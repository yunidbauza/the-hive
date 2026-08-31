// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';

import { createScheduler } from '../../../../electron/main/agents/scheduler';
import { createAgentState } from '../../../../electron/main/agents/state';
import {
  AGENT_PENDING_WAKE_MAX,
  type WakeSpec,
} from '../../../../electron/shared/agent-contract';
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
  let wakesOnLedger: boolean;
  let appendOk: boolean;
  let state: ReturnType<typeof createAgentState>;
  let scheduler: ReturnType<typeof createScheduler>;
  /** What `scheduleFor` answers. Empty means "no usable definition". */
  let schedules: Map<string, { wake: WakeSpec; dailyUsd?: number }>;
  /** Makes `run` answer a refusal, as `RunTracker` does for a working agent. */
  let refuse: boolean;
  /** Whether the registry has answered its first listing yet. */
  let listed: boolean;
  /** Names pushed to the renderer, in order. */
  let pushed: string[];

  /** Fire every armed interval once — the sweep and the schedule tick. */
  const tick = (): void => {
    for (const handler of [...timers.values()]) handler();
  };

  const build = (): ReturnType<typeof createScheduler> =>
    createScheduler({
      run: (name, trigger, extra) => {
        if (refuse) return { started: false };

        woke.push({ name, trigger, ...(extra === undefined ? {} : { extra }) });
        return { started: true };
      },
      state,
      isAgent: (id) => id === AGENT,
      wakesOnLedger: () => wakesOnLedger,
      schedules: () => (listed ? schedules : undefined),
      pushStatus: (name) => pushed.push(name),
      ledger: {
        read: () => ({ entries }),
        append: (request) => {
          appended.push(request);
          return { ok: appendOk };
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
    wakesOnLedger = true;
    appendOk = true;
    schedules = new Map();
    refuse = false;
    listed = true;
    pushed = [];
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
      wakesOnLedger: () => true,
      // This spec drives `onEntry` only; the tick has nothing to read.
      schedules: () => new Map(),
      pushStatus: () => {},
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

  it('leaves an agent alone when its definition does not take ledger wakes', () => {
    // `wake.on: [ledger]` is a gate, and the Settings copy promises it: without
    // it "a question addressed to it waits unread".
    wakesOnLedger = false;
    scheduler = build();

    scheduler.onEntry(entry());

    expect(woke).toEqual([]);
    // And nothing is queued either — a queue nothing will deliver would only
    // fire on the day its author ticks the box.
    expect(state.read(AGENT).pendingWake ?? []).toEqual([]);
  });

  describe('a refused wake', () => {
    /** The tracker refuses without ever reaching `onRunClosed`. */
    const refusing = (): void => {
      scheduler = createScheduler({
        run: (name, trigger, extra) => {
          woke.push({ name, trigger, ...(extra === undefined ? {} : { extra }) });
          return { started: false };
        },
        state,
        isAgent: (id) => id === AGENT,
        wakesOnLedger: () => true,
      // This spec drives `onEntry` only; the tick has nothing to read.
      schedules: () => new Map(),
      pushStatus: () => {},
        ledger: { read: () => ({ entries }), append: () => ({ ok: true }) },
        now: () => clock,
      });
    };

    it('queues the entry instead of dropping it', () => {
      refusing();
      scheduler.onEntry(entry());

      expect(woke).toHaveLength(1);
      expect(state.read(AGENT).pendingWake).toEqual([
        { kind: 'ask', id: 'a1', from: 'overmind' },
      ]);
    });

    it('puts a flushed queue back', () => {
      /*
        The boot case is not a race: `mcp.start()` is still in flight when
        `start()` runs, so `wake-command` refuses for a config not yet written.
        Clearing without checking would destroy every crash-surviving queue at
        the one moment it is guaranteed to happen.
      */
      state.patch(AGENT, {
        status: 'sleeping',
        pendingWake: [{ kind: 'ask', id: 'a9', from: 'overmind' }],
      });
      refusing();

      scheduler.onRunClosed(AGENT);

      expect(woke).toHaveLength(1);
      expect(state.read(AGENT).pendingWake).toEqual([
        { kind: 'ask', id: 'a9', from: 'overmind' },
      ]);
    });

    it('keeps anything that arrived while the wake was being refused', () => {
      state.patch(AGENT, {
        status: 'sleeping',
        pendingWake: [{ kind: 'ask', id: 'a9', from: 'overmind' }],
      });
      scheduler = createScheduler({
        run: (name) => {
          // Something lands mid-refusal, as an append racing a flush would.
          state.patch(name, {
            pendingWake: [
              ...(state.read(name).pendingWake ?? []),
              { kind: 'post', id: 'a10', from: 'sess-2' },
            ],
          });
          return { started: false };
        },
        state,
        isAgent: (id) => id === AGENT,
        wakesOnLedger: () => true,
      // This spec drives `onEntry` only; the tick has nothing to read.
      schedules: () => new Map(),
      pushStatus: () => {},
        ledger: { read: () => ({ entries }), append: () => ({ ok: true }) },
        now: () => clock,
      });

      scheduler.onRunClosed(AGENT);

      expect(state.read(AGENT).pendingWake).toEqual([
        { kind: 'ask', id: 'a9', from: 'overmind' },
        { kind: 'post', id: 'a10', from: 'sess-2' },
      ]);
    });
  });

  it('honours stop() on every entry point, not just the timer', () => {
    /*
      Teardown calls `closeAll`, which finalizes synchronously and so re-enters
      `onRunClosed`. A flush there spawns a process after `closeAll` has finished
      iterating — an orphan with nobody left to signal it.
    */
    state.patch(AGENT, {
      status: 'sleeping',
      pendingWake: [{ kind: 'ask', id: 'a9', from: 'overmind' }],
    });

    scheduler.start();
    woke.length = 0;
    scheduler.stop();

    scheduler.onRunClosed(AGENT);
    scheduler.onEntry(entry());

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
      // Spelled like every other wake — `<kind> <id> from <from>` — so a queued
      // expiry and an immediate one read the same to the model.
      expect(woke).toEqual([
        { name: AGENT, trigger: 'ledger', extra: 'expired a1 from overmind' },
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

    it('queues the expiry when the asker is mid-run', () => {
      /*
        The expiry event is on disk once written, so the sweep will never look
        at this ask again — a wake refused here would lose the news for good.
      */
      state.patch(AGENT, { status: 'working' });
      scheduler.start();
      tick();

      expect(appended).toHaveLength(1);
      expect(woke).toEqual([]);
      expect(state.read(AGENT).pendingWake).toEqual([
        { kind: 'expired', id: 'a1', from: 'overmind' },
      ]);

      state.patch(AGENT, { status: 'sleeping' });
      scheduler.onRunClosed(AGENT);

      expect(woke).toEqual([
        { name: AGENT, trigger: 'ledger', extra: 'expired a1 from overmind' },
      ]);
    });

    it('does not wake when the expiry could not be written', () => {
      /*
        The write is the dedup. Waking without it would re-expire the same ask
        every sixty seconds for as long as the disk stays unwritable.
      */
      appendOk = false;
      scheduler = build();
      scheduler.start();
      tick();
      tick();

      expect(woke).toEqual([]);
      expect(state.read(AGENT).pendingWake ?? []).toEqual([]);
    });

    it('leaves an asker that does not take ledger wakes unwoken', () => {
      wakesOnLedger = false;
      scheduler = build();
      scheduler.start();
      tick();

      expect(appended).toHaveLength(1);
      expect(woke).toEqual([]);
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

  /*
    Time passed (HIVE-121).

    Every case below drives the *same* interval the expiry sweep runs on —
    there is one timer in this module and it does two jobs — and asserts
    against `agents.json` rather than against a timer handle, because
    `nextRunAt` on disk is the only representation of when a wake is due.
  */
  describe('the interval tick', () => {
    const NOON = new Date(2026, 7, 31, 12).getTime();
    const every5m: WakeSpec = { everyMs: 300_000, check: 'always', on: [] };

    beforeEach(() => {
      clock = NOON;
      /*
        Armed before each case arranges anything, so the immediate tick inside
        `start()` finds no schedules and does nothing — leaving `tick()` below
        as the one tick under test. The two cases that are *about* `start()`
        live in their own describe, without this.
      */
      scheduler.start();
    });

    /*
      Arm, do not fire. A definition saved in Settings is a schedule starting
      now, not a wake owed since the epoch — and `nextRunAt` is absent for
      exactly as long as an agent has never been scheduled.
    */
    it('seeds a next run rather than firing the instant an agent is created', () => {
      schedules.set(AGENT, { wake: every5m });

      tick();

      expect(woke).toEqual([]);
      expect(state.read(AGENT).nextRunAt).toBe(NOON + 300_000);
    });

    /*
      The feature's primary path, and the one every other case here hid.

      `agents.json` gains an entry when an agent *runs*, is paused, or is
      queued against — nothing writes one when a definition is merely saved.
      So an agent authored in Settings and left alone has a schedule and no run
      state, and a tick driven off `state.all()` never sees it: it would never
      wake, on a fresh install or on any newly created agent, and the only
      escape would be clicking Run now once.

      Every other scheduling case in this file calls `state.patch` first, which
      is exactly why they could not catch it.
    */
    it('schedules an agent that has never run and has no state entry', () => {
      schedules.set('brand-new', { wake: every5m });

      tick();

      expect(state.read('brand-new').nextRunAt).toBe(NOON + 300_000);
    });

    it('wakes an agent whose only trace is its definition', () => {
      schedules.set('brand-new', { wake: every5m });

      tick();
      clock = NOON + 300_000;
      tick();

      expect(woke).toEqual([{ name: 'brand-new', trigger: 'interval' }]);
    });

    /*
      A schedule that got shorter must not wait out the old, longer time.

      `every: 6h` armed at 10:00 and edited to `every: 5m` at 10:05 would
      otherwise sit until 16:00 — and a calendar agent switched to an interval
      would sit for nearly a day. The docs promise a definition change re-arms
      the schedule; without this they are only true in the lengthening
      direction.
    */
    it('re-arms when the interval is shortened under it', () => {
      state.patch(AGENT, { nextRunAt: NOON + 6 * 60 * 60_000 });
      schedules.set(AGENT, { wake: every5m });

      tick();

      expect(state.read(AGENT).nextRunAt).toBe(NOON + 300_000);
    });

    /*
      The clamp bounds the remaining wait at one interval of the *new*
      schedule — it does not fire immediately.

      That is deliberate. Firing at once would mean re-deriving the owed time
      from `lastRunAt`, and the moment the tick arms a wake it has not yet
      recorded, `lastRunAt` still names the *previous* run — so the next tick
      would read the same stale time and wake again. Bounding the wait instead
      is one comparison, cannot double-fire, and costs at most one interval.
    */
    it('wakes within one interval of the shortened schedule, not at once', () => {
      state.patch(AGENT, { nextRunAt: NOON + 6 * 60 * 60_000, lastRunAt: NOON - 600_000 });
      schedules.set(AGENT, { wake: { everyMs: 60_000, check: 'always', on: [] } });

      tick();

      expect(woke).toEqual([]);
      expect(state.read(AGENT).nextRunAt).toBe(NOON + 60_000);

      clock = NOON + 60_000;
      tick();

      expect(woke).toEqual([{ name: AGENT, trigger: 'interval' }]);
    });

    it('leaves a longer schedule to run its course rather than pushing it out', () => {
      state.patch(AGENT, { nextRunAt: NOON + 60_000 });
      schedules.set(AGENT, { wake: { everyMs: 6 * 60 * 60_000, check: 'always', on: [] } });

      tick();

      expect(state.read(AGENT).nextRunAt).toBe(NOON + 60_000);
    });

    it('wakes on the boundary and arms the next one', () => {
      state.patch(AGENT, { nextRunAt: NOON });
      schedules.set(AGENT, { wake: every5m });

      tick();

      expect(woke).toEqual([{ name: AGENT, trigger: 'interval' }]);
      expect(state.read(AGENT).nextRunAt).toBe(NOON + 300_000);
    });

    it('does not wake before the time it armed', () => {
      state.patch(AGENT, { nextRunAt: NOON + 60_000 });
      schedules.set(AGENT, { wake: every5m });

      tick();

      expect(woke).toEqual([]);
      expect(state.read(AGENT).nextRunAt).toBe(NOON + 60_000);
    });

    /*
      One wake for a missed window, not one per missed interval.

      This is the whole reason `nextRunAt` is polled off disk rather than held
      in a `setTimeout`: six hours of lid-shut sleep is one overdue timestamp,
      and one overdue timestamp is one wake. A per-agent timer would have to
      reconstruct that, and a naive catch-up loop would spawn 72 runs.
    */
    it('wakes once for a long-overdue time, not once per missed interval', () => {
      state.patch(AGENT, { nextRunAt: NOON - 6 * 60 * 60_000 });
      schedules.set(AGENT, { wake: every5m });

      tick();

      expect(woke).toEqual([{ name: AGENT, trigger: 'interval' }]);
      expect(state.read(AGENT).nextRunAt).toBe(NOON + 300_000);
    });

    it.each(['working', 'paused', 'asking'] as const)(
      'takes no scheduled wake while %s',
      (status) => {
        state.patch(AGENT, { status, nextRunAt: NOON });
        schedules.set(AGENT, { wake: every5m });

        tick();

        expect(woke).toEqual([]);
      },
    );

    /*
      An `asking` agent keeps its overdue `nextRunAt` deliberately. When the
      answer lands and the status moves, the next tick finds one stale time and
      spends it as a single catch-up wake — the same path the boot case takes.
    */
    it('leaves an asking agent its stale next run, to spend when it resumes', () => {
      state.patch(AGENT, { status: 'asking', nextRunAt: NOON - 60_000 });
      schedules.set(AGENT, { wake: every5m });

      tick();

      expect(state.read(AGENT).nextRunAt).toBe(NOON - 60_000);
    });

    it('wakes a failed agent — a failed run is not a paused one', () => {
      state.patch(AGENT, { status: 'failed', nextRunAt: NOON });
      schedules.set(AGENT, { wake: every5m });

      tick();

      expect(woke).toEqual([{ name: AGENT, trigger: 'interval' }]);
    });

    it('clears a stale next run when the definition stops scheduling', () => {
      state.patch(AGENT, { nextRunAt: NOON + 60_000 });
      schedules.set(AGENT, { wake: { on: ['ledger'] } });

      tick();

      expect(state.read(AGENT).nextRunAt).toBeUndefined();
    });

    /*
      A definition that will not parse is absent from the schedule map, and
      that is what stops a broken file being woken on a timer — the same agent
      is still *listed*, so the user can see and fix it.
    */
    it('leaves an agent with no usable definition alone', () => {
      state.patch(AGENT, { nextRunAt: NOON });

      tick();

      expect(woke).toEqual([]);
    });

    /*
      "The registry has not answered yet" is not "this agent has no schedule",
      and conflating them destroys the thing the boot tick exists to catch.

      `refreshKnownAgents` fills the schedule map from an unawaited
      `agents.list()` — a folder walk that reads and parses every `AGENT.md` —
      while `scheduler.start()` ticks synchronously. The walk routinely loses
      that race. If an empty map read as "nothing is scheduled", the first tick
      after every launch would clear the overdue `nextRunAt` of every agent, and
      the promise that a missed window wakes once would be false precisely when
      it matters: on the launch that follows the miss.
    */
    it('waits for the registry rather than clearing what it cannot see', () => {
      listed = false;
      state.patch(AGENT, { nextRunAt: NOON - 60_000 });

      tick();

      expect(state.read(AGENT).nextRunAt).toBe(NOON - 60_000);
      expect(woke).toEqual([]);
    });

    it('spends that overdue time as one wake once the registry answers', () => {
      listed = false;
      state.patch(AGENT, { nextRunAt: NOON - 60_000, lastRunAt: NOON - 600_000 });
      schedules.set(AGENT, { wake: every5m });

      tick();
      listed = true;
      tick();

      expect(woke).toEqual([{ name: AGENT, trigger: 'interval' }]);
    });

    /*
      And once it has answered, an agent genuinely missing from it *is* one
      with no usable schedule — a definition that stopped parsing mid-edit —
      so a stale time is cleared rather than left promising a wake.
    */
    it('clears a stale next run once the registry has answered without it', () => {
      state.patch(AGENT, { nextRunAt: NOON + 60_000 });

      tick();

      expect(state.read(AGENT).nextRunAt).toBeUndefined();
    });

    /*
      A skip changes a row and starts no run, so nothing else would tell the
      renderer. Without this push `next 18:20 · skipped 3` goes stale on
      precisely the agent somebody is staring at the row to diagnose: one that
      is deliberately not running.
    */
    it('pushes the row when a skip changes it', () => {
      state.patch(AGENT, { nextRunAt: NOON, lastRunAt: NOON - 600_000 });
      schedules.set(AGENT, {
        wake: { everyMs: 300_000, check: 'onchange', on: [] },
      });

      tick();

      expect(state.read(AGENT).skipsSinceRun).toBe(1);
      expect(pushed).toEqual([AGENT]);
    });

    it('pushes nothing on a tick that changes nothing', () => {
      state.patch(AGENT, { nextRunAt: NOON + 60_000 });
      schedules.set(AGENT, { wake: every5m });

      tick();

      expect(pushed).toEqual([]);
    });

    it('names the calendar trigger for a fixed-time agent', () => {
      state.patch(AGENT, { nextRunAt: NOON });
      schedules.set(AGENT, { wake: { at: ['09:00'], on: [] } });

      tick();

      expect(woke).toEqual([{ name: AGENT, trigger: 'schedule' }]);
      expect(state.read(AGENT).nextRunAt).toBe(new Date(2026, 8, 1, 9).getTime());
    });

  });

  describe('the tick and the app lifecycle', () => {
    const NOON = new Date(2026, 7, 31, 12).getTime();
    const every5m: WakeSpec = { everyMs: 300_000, check: 'always', on: [] };

    beforeEach(() => {
      clock = NOON;
    });

    /*
      Without this a restart waits a full period before noticing an agent whose
      time passed while the app was closed — which for a `daily` agent is a
      whole extra day of silence.
    */
    it('ticks once immediately on start, so a restart does not wait a minute', () => {
      state.patch(AGENT, { nextRunAt: NOON - 1 });
      schedules.set(AGENT, { wake: every5m });

      scheduler.start();

      expect(woke).toEqual([{ name: AGENT, trigger: 'interval' }]);
    });

    /*
      `stop()` sets a flag every entry point honours rather than only clearing
      the interval, because shutdown finalizes live runs synchronously and
      re-enters this module from inside its own teardown.
    */
    it('stops ticking once stopped', () => {
      scheduler.start();
      state.patch(AGENT, { nextRunAt: NOON });
      schedules.set(AGENT, { wake: every5m });
      scheduler.stop();

      tick();

      expect(woke).toEqual([]);
    });
  });

  describe('quiet hours', () => {
    const quiet = { from: '23:00', to: '07:00' };
    const LATE = new Date(2026, 7, 31, 23, 30).getTime();
    const MORNING = new Date(2026, 8, 1, 7).getTime();

    // Armed before anything is arranged — see the interval tick's beforeEach.
    beforeEach(() => {
      scheduler.start();
    });

    it('defers to the end of the window instead of waking inside it', () => {
      clock = LATE;
      state.patch(AGENT, { nextRunAt: LATE });
      schedules.set(AGENT, {
        wake: { everyMs: 300_000, check: 'always', quiet, on: [] },
      });

      tick();

      expect(woke).toEqual([]);
      expect(state.read(AGENT).nextRunAt).toBe(MORNING);
    });

    /*
      A silence the author asked for is not the same fact as "nothing changed",
      so it must not move the number that reports the second one. Otherwise a
      nightly agent reads `skipped 96` every morning for working perfectly.
    */
    it('does not count a quiet-hours deferral as a skip', () => {
      clock = LATE;
      state.patch(AGENT, { nextRunAt: LATE, skipsSinceRun: 0 });
      schedules.set(AGENT, {
        wake: { everyMs: 300_000, check: 'onchange', quiet, on: [] },
      });

      tick();

      expect(state.read(AGENT).skipsSinceRun).toBe(0);
    });

    it('wakes normally outside the window', () => {
      clock = new Date(2026, 7, 31, 12).getTime();
      state.patch(AGENT, { nextRunAt: clock });
      schedules.set(AGENT, {
        wake: { everyMs: 300_000, check: 'always', quiet, on: [] },
      });

      tick();

      expect(woke).toEqual([{ name: AGENT, trigger: 'interval' }]);
    });

    /*
      A ledger-addressed wake is not a scheduled one and quiet hours do not
      touch it — the field's own help sentence promises exactly that: "no
      scheduled wakes inside the window; a message addressed to the agent still
      wakes it".
    */
    it('does not suppress a ledger-addressed wake', () => {
      clock = LATE;
      schedules.set(AGENT, {
        wake: { everyMs: 300_000, check: 'always', quiet, on: ['ledger'] },
      });

      scheduler.onEntry(entry({ ts: LATE }));

      expect(woke).toHaveLength(1);
    });
  });

  describe('check: onchange', () => {
    const NOON = new Date(2026, 7, 31, 12).getTime();
    const onchange: WakeSpec = { everyMs: 300_000, check: 'onchange', on: [] };

    beforeEach(() => {
      clock = NOON;
      // Armed before anything is arranged — see the interval tick's beforeEach.
      scheduler.start();
      state.patch(AGENT, { nextRunAt: NOON, lastRunAt: NOON - 600_000 });
      schedules.set(AGENT, { wake: onchange });
    });

    it('skips a tick with nothing addressed since the last run, and counts it', () => {
      state.patch(AGENT, { skipsSinceRun: 2 });

      tick();

      expect(woke).toEqual([]);
      expect(state.read(AGENT).skipsSinceRun).toBe(3);
      expect(state.read(AGENT).nextRunAt).toBe(NOON + 300_000);
    });

    it('wakes when an entry addressed to it arrived since the last run', () => {
      entries.push(entry({ kind: 'post', ts: NOON - 60_000 }));

      tick();

      expect(woke).toEqual([{ name: AGENT, trigger: 'interval' }]);
    });

    it('ignores an entry older than the last run', () => {
      entries.push(entry({ kind: 'post', ts: NOON - 900_000 }));

      tick();

      expect(woke).toEqual([]);
    });

    it('ignores an entry addressed to somebody else', () => {
      entries.push(entry({ kind: 'post', to: 'zergling', ts: NOON - 60_000 }));

      tick();

      expect(woke).toEqual([]);
    });

    it('ignores a broadcast, which is addressed to nobody', () => {
      entries.push(entry({ kind: 'post', to: undefined, ts: NOON - 60_000 }));

      tick();

      expect(woke).toEqual([]);
    });

    it('wakes when a queued entry is waiting, whatever its age', () => {
      state.patch(AGENT, {
        pendingWake: [{ id: 'a1', kind: 'ask', from: 'overmind' }],
      });

      tick();

      expect(woke).toEqual([{ name: AGENT, trigger: 'interval' }]);
    });

    /*
      `wake.on: [ledger]` gates whether an entry *wakes* the agent. It does not
      gate whether that entry is a change worth waking for on a schedule the
      author did set — the field's help promises a question "waits unread until
      the next scheduled wake", and this is that wake arriving to read it.
    */
    it('counts an addressed entry even for an agent that does not wake on the ledger', () => {
      wakesOnLedger = false;
      entries.push(entry({ ts: NOON - 60_000 }));

      tick();

      expect(woke).toEqual([{ name: AGENT, trigger: 'interval' }]);
    });

    it('treats an agent that has never run as having something to do', () => {
      state.patch(AGENT, { lastRunAt: undefined });
      entries.push(entry({ ts: NOON - 60_000 }));

      tick();

      expect(woke).toEqual([{ name: AGENT, trigger: 'interval' }]);
    });

    it('never skips under check: always', () => {
      schedules.set(AGENT, { wake: { everyMs: 300_000, check: 'always', on: [] } });

      tick();

      expect(woke).toEqual([{ name: AGENT, trigger: 'interval' }]);
    });
  });

  describe('the daily cap', () => {
    const NOON = new Date(2026, 7, 31, 12).getTime();
    const MIDNIGHT = new Date(2026, 8, 1).getTime();
    const capped = {
      wake: { everyMs: 300_000, check: 'always' as const, on: [] },
      dailyUsd: 0.1,
    };

    beforeEach(() => {
      clock = NOON;
      // Armed before anything is arranged — see the interval tick's beforeEach.
      scheduler.start();
      state.patch(AGENT, { nextRunAt: NOON });
      schedules.set(AGENT, capped);
    });

    it("stops scheduled wakes once today's spend reaches the cap", () => {
      state.patch(AGENT, { today: { day: '2026-08-31', runs: 2, usd: 0.14 } });

      tick();

      expect(woke).toEqual([]);
    });

    /*
      Midnight rather than the next interval, so the agent is not re-deciding
      to stay capped every five minutes for the rest of the day — and so `Next`
      names the hour it will actually come back.
    */
    it('arms the next wake for local midnight', () => {
      state.patch(AGENT, { today: { day: '2026-08-31', runs: 2, usd: 0.14 } });

      tick();

      expect(state.read(AGENT).nextRunAt).toBe(MIDNIGHT);
    });

    it('posts the card once, not on every tick for the rest of the day', () => {
      state.patch(AGENT, { today: { day: '2026-08-31', runs: 2, usd: 0.14 } });

      tick();
      state.patch(AGENT, { nextRunAt: NOON });
      tick();

      const posted = appended.filter(
        (item) => (item.meta as { dailyCap?: number } | undefined)?.dailyCap !== undefined,
      );

      expect(posted).toHaveLength(1);
      /*
        From the **overmind**, not the agent. `meta` is a free-form rider any
        party can write, so a card keyed off an agent's own `from` is one any
        agent could mint for itself — the same reason the expiry event is the
        overmind's. Main declined to start this run; main says so.
      */
      expect(posted[0]).toMatchObject({
        from: 'overmind',
        kind: 'event',
        meta: { dailyCap: 0.1, agent: AGENT },
      });
      expect(state.read(AGENT).today?.capped).toBe(true);
    });

    it('runs normally while spend is under the cap', () => {
      state.patch(AGENT, { today: { day: '2026-08-31', runs: 1, usd: 0.07 } });

      tick();

      expect(woke).toEqual([{ name: AGENT, trigger: 'interval' }]);
    });

    it('ignores a cap for an agent whose definition names none', () => {
      schedules.set(AGENT, { wake: capped.wake });
      state.patch(AGENT, { today: { day: '2026-08-31', runs: 99, usd: 99 } });

      tick();

      expect(woke).toEqual([{ name: AGENT, trigger: 'interval' }]);
    });

    /*
      Yesterday's total cannot cap today. `recordRun` replaces the accumulator
      wholesale on a new day, but a tick can land before the day's first run —
      so the comparison has to check the day key, not only the number.
    */
    it('ignores a total belonging to a previous day', () => {
      state.patch(AGENT, { today: { day: '2026-08-30', runs: 9, usd: 9 } });

      tick();

      expect(woke).toEqual([{ name: AGENT, trigger: 'interval' }]);
    });

    /*
      A budget for unattended work, not a lock on the agent. The gate lives in
      the tick rather than in `RunTracker.run`, so a ledger entry and a manual
      run both still reach the agent while it is capped.
    */
    it('does not stop a ledger-addressed wake', () => {
      state.patch(AGENT, { today: { day: '2026-08-31', runs: 2, usd: 0.14 } });
      tick();

      scheduler.onEntry(entry({ ts: NOON }));

      expect(woke).toEqual([
        { name: AGENT, trigger: 'ledger', extra: 'ask a1 from overmind' },
      ]);
    });
  });

  describe('a scheduled wake the tracker refuses', () => {
    /*
      HIVE-119 defers a permission answer's wake behind the grant write, so
      between the answer landing and the grant completing there is a window
      with the entry on the log and no run started. A tick inside that window
      must not become a second wake for the same entry — and it cannot, because
      both go through `RunTracker.run`, which refuses a `working` agent.

      What this pins is the other half: a refusal is a wake deferred, not a
      quiet tick, so it arms the next time and leaves the skip count alone.
    */
    it('arms the next time without counting a skip', () => {
      const NOON = new Date(2026, 7, 31, 12).getTime();

      clock = NOON;
      scheduler.start();
      state.patch(AGENT, {
        nextRunAt: NOON,
        lastRunAt: NOON - 600_000,
        skipsSinceRun: 1,
      });
      schedules.set(AGENT, { wake: { everyMs: 300_000, check: 'always', on: [] } });
      refuse = true;

      tick();

      expect(state.read(AGENT).skipsSinceRun).toBe(1);
      expect(state.read(AGENT).nextRunAt).toBe(NOON + 300_000);
    });
  });
});
