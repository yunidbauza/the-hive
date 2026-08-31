// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';

import { createScheduler } from '../../../../electron/main/agents/scheduler';
import { createAgentState } from '../../../../electron/main/agents/state';
import { AGENT_PENDING_WAKE_MAX } from '../../../../electron/shared/agent-contract';
import {
  LEDGER_ASK_TTL_MS,
  type LedgerEntry,
  type LedgerPostRequest,
} from '../../../../electron/shared/ledger-contract';

const AGENT = 'pr-reviewer';

const entry = (over: Partial<LedgerEntry> = {}): LedgerEntry => ({
  id: 'a1',
  ts: 0,
  from: 'overmind',
  to: AGENT,
  kind: 'ask',
  body: 'take a look?',
  ...over,
});

describe('createScheduler', () => {
  let woke: { name: string; trigger: string; extra?: string }[];
  let entries: LedgerEntry[];
  let appended: LedgerPostRequest[];
  let clock: number;
  let timers: Map<number, () => void>;
  let nextTimerId: number;
  let state: ReturnType<typeof createAgentState>;
  let scheduler: ReturnType<typeof createScheduler>;

  /** Fire every armed interval once — the sweep, in this suite. */
  const tick = (): void => {
    for (const handler of [...timers.values()]) handler();
  };

  const build = (): ReturnType<typeof createScheduler> =>
    createScheduler({
      run: (name, trigger, extra) => {
        woke.push({ name, trigger, ...(extra === undefined ? {} : { extra }) });
        return { started: true };
      },
      state,
      isAgent: (id) => id === AGENT,
      ledger: {
        read: () => ({ entries }),
        append: (request) => {
          appended.push(request);
          return { ok: true };
        },
      },
      now: () => clock,
      setIntervalFn: ((handler: () => void) => {
        const id = nextTimerId;
        nextTimerId += 1;
        timers.set(id, handler);
        return id;
      }) as unknown as typeof setInterval,
      clearIntervalFn: ((id: number) => {
        timers.delete(id);
      }) as unknown as typeof clearInterval,
    });

  beforeEach(() => {
    woke = [];
    entries = [];
    appended = [];
    clock = 0;
    timers = new Map();
    nextTimerId = 1;
    state = createAgentState({ path: '/dev/null/agents.json', debounceMs: 1 });
    state.patch(AGENT, { status: 'sleeping' });

    scheduler = build();
  });

  it('wakes a sleeping agent at once, naming the entry', () => {
    scheduler.onEntry(entry());

    expect(woke).toEqual([
      { name: AGENT, trigger: 'ledger', extra: 'ask a1 from overmind' },
    ]);
  });

  it('writes nothing for a party that is not an agent', () => {
    scheduler.onEntry(entry({ to: 'sess-3' }));

    expect(woke).toEqual([]);
  });

  it('writes nothing for a broadcast', () => {
    scheduler.onEntry(entry({ to: undefined }));

    expect(woke).toEqual([]);
  });

  it('queues while working and wakes once when the run closes', () => {
    state.patch(AGENT, { status: 'working' });

    scheduler.onEntry(entry({ id: 'a1' }));
    scheduler.onEntry(entry({ id: 'a2', kind: 'answer', from: 'sess-2' }));

    expect(woke).toEqual([]);
    expect(state.read(AGENT).pendingWake).toHaveLength(2);

    state.patch(AGENT, { status: 'sleeping' });
    scheduler.onRunClosed(AGENT);

    expect(woke).toEqual([
      {
        name: AGENT,
        trigger: 'ledger',
        extra: 'ask a1 from overmind, answer a2 from sess-2',
      },
    ]);
    expect(state.read(AGENT).pendingWake).toEqual([]);
  });

  it('holds for a paused agent and wakes once on resume', () => {
    state.patch(AGENT, { status: 'paused' });
    scheduler.onEntry(entry());

    expect(woke).toEqual([]);
    expect(state.read(AGENT).pendingWake).toHaveLength(1);

    scheduler.onResume(AGENT);

    expect(woke).toHaveLength(1);
    expect(state.read(AGENT).pendingWake).toEqual([]);
  });

  it('does not flush a run that closed into paused — the pause outranks it', () => {
    /*
      HIVE-117 lets a pause land mid-run: the turn finishes and `finalizeRun`
      holds `paused` rather than writing its computed resting status over it.
      Flushing here would reach `RunTracker.run`'s `refused: 'paused'` and drop
      the entries on the floor, with their asks still open.
    */
    state.patch(AGENT, { status: 'working' });
    scheduler.onEntry(entry());

    state.patch(AGENT, { status: 'paused' });
    scheduler.onRunClosed(AGENT);

    expect(woke).toEqual([]);
    expect(state.read(AGENT).pendingWake).toHaveLength(1);

    scheduler.onResume(AGENT);

    expect(woke).toHaveLength(1);
  });

  it('closes a run with nothing queued without waking', () => {
    scheduler.onRunClosed(AGENT);

    expect(woke).toEqual([]);
  });

  it('resumes an agent with nothing queued without waking', () => {
    scheduler.onResume(AGENT);

    expect(woke).toEqual([]);
  });

  it('keeps the earliest entries when the queue is full', () => {
    state.patch(AGENT, { status: 'working' });

    for (let index = 0; index < AGENT_PENDING_WAKE_MAX + 5; index += 1) {
      scheduler.onEntry(entry({ id: `a${index}` }));
    }

    const queued = state.read(AGENT).pendingWake ?? [];

    expect(queued).toHaveLength(AGENT_PENDING_WAKE_MAX);
    expect(queued[0]?.id).toBe('a0');
    expect(queued.at(-1)?.id).toBe(`a${AGENT_PENDING_WAKE_MAX - 1}`);
  });

  it('clears the queue before it wakes, so a re-entrant close cannot loop', () => {
    /*
      The flush re-enters `RunTracker.run`, and a spawn that fails synchronously
      finalizes the run from inside that call — reaching `onRunClosed` again. A
      queue still standing at that moment would wake forever.
    */
    state.patch(AGENT, { status: 'working' });
    scheduler.onEntry(entry());
    state.patch(AGENT, { status: 'sleeping' });

    let reentered = 0;

    scheduler = createScheduler({
      run: (name) => {
        reentered += 1;
        if (reentered < 5) scheduler.onRunClosed(name);
        return { started: false };
      },
      state,
      isAgent: (id) => id === AGENT,
      ledger: { read: () => ({ entries }), append: () => ({ ok: true }) },
      now: () => clock,
    });

    scheduler.onRunClosed(AGENT);

    expect(reentered).toBe(1);
  });

  it('flushes a queue that survived a crash', () => {
    /*
      `agents.json` is read back through `wakeFromWorking`, which rewrites
      `working` to `sleeping` because no child of the last launch survived it.
      A queue left by a crashed run has no run to close and no resume coming.
    */
    state.patch(AGENT, {
      status: 'sleeping',
      pendingWake: [{ kind: 'ask', id: 'a9', from: 'overmind' }],
    });

    scheduler.start();

    expect(woke).toEqual([
      { name: AGENT, trigger: 'ledger', extra: 'ask a9 from overmind' },
    ]);
  });

  it('leaves a paused agent queue alone at boot', () => {
    state.patch(AGENT, {
      status: 'paused',
      pendingWake: [{ kind: 'ask', id: 'a9', from: 'overmind' }],
    });

    scheduler.start();

    expect(woke).toEqual([]);
    expect(state.read(AGENT).pendingWake).toHaveLength(1);
  });

  it('wakes nobody at boot when no queue survived', () => {
    scheduler.start();

    expect(woke).toEqual([]);
  });

  describe('the expiry sweep', () => {
    const askedByAgent: LedgerEntry = {
      id: 'a1',
      ts: 0,
      from: AGENT,
      to: 'overmind',
      kind: 'ask',
      ref: 'a7',
      body: 'which branch should the demo use?',
    };

    beforeEach(() => {
      entries = [askedByAgent];
      clock = LEDGER_ASK_TTL_MS;
    });

    it('retires an ask past its ttl, tells the log, and wakes the asker', () => {
      scheduler.start();
      tick();

      expect(appended).toEqual([
        {
          from: 'overmind',
          to: AGENT,
          kind: 'event',
          thread: 'a1',
          body: 'ask a7 expired',
          meta: { expired: 'a1' },
        },
      ]);
      expect(woke).toEqual([
        { name: AGENT, trigger: 'ledger', extra: 'expired a1' },
      ]);
    });

    it('does not sweep before the ttl', () => {
      clock = LEDGER_ASK_TTL_MS - 1;
      scheduler.start();
      tick();

      expect(appended).toEqual([]);
      expect(woke).toEqual([]);
    });

    it('sweeps again without re-retiring what it already told', () => {
      // The log itself is the sweep's memory: `expiredAsks` skips an ask whose
      // expiry event is already written, so a second pass finds nothing.
      scheduler.start();
      tick();

      entries = [
        askedByAgent,
        {
          id: 'e1',
          ts: clock,
          from: 'overmind',
          to: AGENT,
          kind: 'event',
          thread: 'a1',
          body: 'ask a7 expired',
          meta: { expired: 'a1' },
        },
      ];
      tick();

      expect(appended).toHaveLength(1);
      expect(woke).toHaveLength(1);
    });

    it('retires a session ask without waking anyone', () => {
      // The card is dismissed by the notifier either way; only an agent has a
      // run to start.
      entries = [{ ...askedByAgent, from: 'sess-4' }];
      scheduler.start();
      tick();

      expect(appended).toHaveLength(1);
      expect(woke).toEqual([]);
    });

    it('honours an ask that shortened its own ttl', () => {
      entries = [{ ...askedByAgent, meta: { ttlMs: 1_000 } }];
      clock = 1_000;
      scheduler.start();
      tick();

      expect(appended).toHaveLength(1);
    });

    it('falls back to the id when the ask has no ref', () => {
      entries = [{ ...askedByAgent, ref: undefined }];
      scheduler.start();
      tick();

      expect(appended[0]?.body).toBe('ask a1 expired');
    });

    it('stops sweeping after stop()', () => {
      scheduler.start();
      scheduler.stop();
      tick();

      expect(appended).toEqual([]);
    });

    it('arms nothing until start()', () => {
      tick();

      expect(appended).toEqual([]);
    });
  });
});
