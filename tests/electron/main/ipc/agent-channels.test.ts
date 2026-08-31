// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AgentRunState,
  AgentsSnapshot,
} from '../../../../electron/shared/agent-contract';
import {
  OVERMIND,
  type LedgerEntry,
} from '../../../../electron/shared/ledger-contract';

/**
 * The agent runtime's channel wiring (HIVE-115) — what `ipc/index.ts` *does
 * with* a registry, a state file and a run tracker, never what any of those
 * three does internally.
 *
 * Built on `ledger-channels.test.ts`, and faked the same way: `createLedger`,
 * `createRunTracker` and `createAgentState` are all replaced, so every
 * assertion here is about the callbacks the composition **handed them** — the
 * seam — rather than about behaviour those modules already have their own
 * specs for. Nothing here spawns anything.
 */

const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();

interface FakeWindow {
  isDestroyed: () => boolean;
  webContents: { send: ReturnType<typeof vi.fn> };
}
const windows: FakeWindow[] = [];

vi.mock('electron', () => ({
  app: {
    getVersion: () => '0.0.0',
    on: vi.fn(),
    removeListener: vi.fn(),
    getPath: () => '/tmp/hive-test',
  },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => windows },
  dialog: { showOpenDialog: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => '',
  },
  ipcMain: {
    handle: (
      channel: string,
      fn: (event: unknown, payload: unknown) => unknown,
    ) => {
      handlers.set(channel, fn);
    },
    on: vi.fn(),
    removeHandler: vi.fn(),
  },
  session: { defaultSession: { webRequest: { onHeadersReceived: vi.fn() } } },
}));

vi.mock('../../../../electron/main/pty-host', () => ({
  registerPtyHost: () => ({
    spawn: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    onData: () => () => {},
    onExit: () => () => {},
    onSpawned: () => () => {},
    onError: () => () => {},
    onSessionLost: () => () => {},
    shutdown: async () => {},
    isRunning: () => true,
    isBlocked: () => false,
    sessionIds: () => [],
  }),
}));

/** Captured so the quit path can be driven without quitting anything. */
let shutdownHooks: (() => void)[] = [];

vi.mock('../../../../electron/main/shutdown', () => ({
  onShutdown: (hook: () => void) => {
    shutdownHooks.push(hook);
  },
}));

const snapshot = {
  configPath: '/tmp/config.json',
  templateWritten: false,
  shell: '/bin/zsh',
  claudeCommand: 'claude',
  subscriptionAuth: true,
  projects: [],
  errors: [],
};

vi.mock('../../../../electron/main/config/index', () => ({
  getConfig: vi.fn(() => snapshot),
  reloadConfig: vi.fn(() => snapshot),
  loadConfig: vi.fn(() => snapshot),
  addProject: vi.fn(() => snapshot),
  removeProject: vi.fn(() => snapshot),
  renameProject: vi.fn(() => snapshot),
  repointProject: vi.fn(() => snapshot),
  reorderProjects: vi.fn(() => snapshot),
  configPath: vi.fn(() => '/tmp/config.json'),
}));

// ---------------------------------------------------------------------------
// The three agent-side fakes.
// ---------------------------------------------------------------------------

let listed: AgentsSnapshot = { agents: [], agentsRoot: '/tmp/.hive/agents' };
let onAgentsChanged: (() => void) | undefined;
const registryClose = vi.fn();

vi.mock('../../../../electron/main/agents', () => ({
  createAgentsRuntime: (options: { runFiles?: unknown }) => {
    runtimeOptions = options;

    return {
      list: () => Promise.resolve(listed),
      read: vi.fn(),
      write: vi.fn(),
      remove: vi.fn(),
      rename: vi.fn(),
      onChange: (fn: () => void) => {
        onAgentsChanged = fn;
        return () => {};
      },
      close: registryClose,
    };
  },
}));

/** What `ipc/index.ts` handed `createAgentsRuntime`. */
let runtimeOptions: { runFiles?: unknown } | undefined;

let stored: Record<string, AgentRunState> = {};
const statePatch = vi.fn((name: string, change: Partial<AgentRunState>) => {
  const next = {
    ...(stored[name] ?? { status: 'sleeping', runsSinceRotate: 0, runs: [] }),
    ...change,
  };
  stored[name] = next as AgentRunState;
  return next as AgentRunState;
});
const stateFlush = vi.fn();
const stateDispose = vi.fn();

vi.mock('../../../../electron/main/agents/state', () => ({
  createAgentState: () => ({
    all: () => ({ ...stored }),
    read: (name: string) =>
      stored[name] ?? { status: 'sleeping', runsSinceRotate: 0, runs: [] },
    patch: statePatch,
    recordRun: vi.fn(),
    forget: vi.fn(),
    carry: vi.fn(),
    flush: stateFlush,
    dispose: stateDispose,
  }),
}));

/**
 * The deps `ipc/index.ts` handed the tracker. Every assertion about the
 * composition's ledger writes, its pushes and its ask-detection is made by
 * calling one of these back — which is exactly how the real tracker reaches
 * them.
 */
type TrackerDeps = Parameters<
  typeof import('../../../../electron/main/agents/runs').createRunTracker
>[0];
let trackerDeps: TrackerDeps | undefined;

const trackerRun = vi.fn(() => ({ started: true as const, run: 'run-1' }));
const trackerKill = vi.fn(() => true);
const trackerKillAll = vi.fn();
const trackerCloseAll = vi.fn();
let liveRuns: string[] = [];

vi.mock('../../../../electron/main/agents/runs', () => ({
  createRunTracker: (deps: TrackerDeps) => {
    trackerDeps = deps;
    return {
      run: trackerRun,
      kill: trackerKill,
      noteTurnEnded: vi.fn(),
      killAll: trackerKillAll,
      closeAll: trackerCloseAll,
      live: () => liveRuns,
    };
  },
}));

let ledgerEntries: LedgerEntry[] = [];
let ledgerOpenAsks: LedgerEntry[] = [];
let capturedKnowsParty: ((id: string) => boolean) | undefined;
let capturedOnChange: ((entry: LedgerEntry) => void) | undefined;
const ledgerAppend = vi.fn(() => ({ ok: true as const, id: 'entry-1' }));

vi.mock('../../../../electron/main/ledger', () => ({
  createLedger: (options: { knowsParty: (id: string) => boolean }) => {
    capturedKnowsParty = options.knowsParty;
    return {
      read: (query: { from?: string }) => ({
        entries: ledgerEntries.filter(
          (entry) => query.from === undefined || entry.from === query.from,
        ),
        openAsks: ledgerOpenAsks,
        claims: {},
      }),
      append: ledgerAppend,
      answer: vi.fn(),
      /*
        Captured rather than discarded (HIVE-120): the scheduler is a consumer
        of this listener, and driving it is the only way to assert from outside
        that an entry addressed to an agent becomes a wake.
      */
      onChange: (listener: (entry: LedgerEntry) => void) => {
        capturedOnChange = listener;
        return () => {
          capturedOnChange = undefined;
        };
      },
    };
  },
}));

const { CH } = await import('../../../../electron/shared/ipc-contract');
const { registerIpcHandlers, resetIpcHandlers } = await import(
  '../../../../electron/main/ipc'
);

const mainFrame = { url: 'file:///out/renderer/index.html' };
const trustedEvent = { senderFrame: mainFrame, sender: { mainFrame } } as never;

const invoke = (channel: string, payload?: unknown) =>
  Promise.resolve().then(() => handlers.get(channel)!(trustedEvent, payload));

/** One tick, so the fire-and-forget `agents.list()` refresh has landed. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

const definition = (name: string) => ({
  name,
  description: 'Watches.',
  icon: 'Robot',
  status: 'sleeping' as const,
  wake: { on: [] },
  rotateAfter: 50,
  runs: [],
});

beforeEach(async () => {
  handlers.clear();
  windows.length = 0;
  shutdownHooks = [];
  stored = {};
  liveRuns = [];
  ledgerEntries = [];
  ledgerOpenAsks = [];
  listed = {
    agents: [definition('slack-watcher')],
    agentsRoot: '/tmp/.hive/agents',
  };
  trackerDeps = undefined;
  runtimeOptions = undefined;
  capturedKnowsParty = undefined;
  onAgentsChanged = undefined;
  vi.clearAllMocks();
  registerIpcHandlers();
  await settle();
});

afterEach(() => {
  resetIpcHandlers();
});

describe('agents:run (HIVE-115)', () => {
  it('wakes the named agent, and supplies the trigger itself', async () => {
    await expect(invoke(CH.agentsRun, { name: 'slack-watcher' })).resolves.toEqual({
      started: true,
      run: 'run-1',
    });

    expect(trackerRun).toHaveBeenCalledWith('slack-watcher', 'manual');
  });

  it('refuses a name that could reach anything but an agent folder', async () => {
    // Rejected input is logged and dropped by `handle`, never acted on — the
    // observable consequence is that the tracker was never asked to run.
    await expect(invoke(CH.agentsRun, { name: '../../claude' })).rejects.toThrow();
    expect(trackerRun).not.toHaveBeenCalled();
  });

  it('refuses a payload that tries to name its own trigger', async () => {
    await expect(
      invoke(CH.agentsRun, { name: 'slack-watcher', trigger: 'ledger' }),
    ).rejects.toThrow();
    expect(trackerRun).not.toHaveBeenCalled();
  });
});

describe('agents:kill (HIVE-115)', () => {
  it('stops the run under that name', async () => {
    await expect(invoke(CH.agentsKill, { name: 'slack-watcher' })).resolves.toBe(
      true,
    );
    expect(trackerKill).toHaveBeenCalledWith('slack-watcher');
  });

  it('answers false rather than throwing when nothing was running', async () => {
    trackerKill.mockReturnValueOnce(false);

    await expect(invoke(CH.agentsKill, { name: 'slack-watcher' })).resolves.toBe(
      false,
    );
  });
});

describe('agents:pause and agents:resume (HIVE-117)', () => {
  /** A live window, so the status push has somewhere to land. */
  const watchWindow = () => {
    const send = vi.fn();
    windows.push({ isDestroyed: () => false, webContents: { send } });
    return send;
  };

  it('pauses by writing the status and pushing the row, without touching the run', async () => {
    const send = watchWindow();

    await expect(
      invoke(CH.agentsPause, { name: 'slack-watcher' }),
    ).resolves.toBe('paused');

    expect(statePatch).toHaveBeenCalledWith('slack-watcher', {
      status: 'paused',
    });
    /*
      The whole of the pause-is-not-a-kill decision, in one assertion: a turn in
      flight finishes. `kill` is the verb next door for the other case.
    */
    expect(trackerKill).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      CH.agentsStatus,
      expect.objectContaining({ name: 'slack-watcher', status: 'paused' }),
    );
  });

  it('resumes to sleeping when the agent has no unanswered question', async () => {
    const send = watchWindow();
    stored['slack-watcher'] = {
      status: 'paused',
      runsSinceRotate: 0,
      runs: [],
    };

    await expect(
      invoke(CH.agentsResume, { name: 'slack-watcher' }),
    ).resolves.toBe('sleeping');

    expect(statePatch).toHaveBeenCalledWith('slack-watcher', {
      status: 'sleeping',
    });
    expect(send).toHaveBeenCalledWith(
      CH.agentsStatus,
      expect.objectContaining({ name: 'slack-watcher', status: 'sleeping' }),
    );
  });

  it('resumes to asking when a question of the agent’s is still open', async () => {
    stored['slack-watcher'] = {
      status: 'paused',
      runsSinceRotate: 0,
      runs: [],
    };
    ledgerOpenAsks = [
      {
        id: '20260830-120000-0001',
        ts: 1,
        from: 'slack-watcher',
        kind: 'ask',
        body: 'ship it?',
      } as LedgerEntry,
    ];

    /*
      Recomputed, not restored. Nothing records what the status was before the
      pause — deliberately, because a remembered `sleeping` would hide a
      question the agent asked while it was paused.
    */
    await expect(
      invoke(CH.agentsResume, { name: 'slack-watcher' }),
    ).resolves.toBe('asking');

    expect(statePatch).toHaveBeenCalledWith('slack-watcher', {
      status: 'asking',
    });
  });

  it('ignores an open ask that belongs to somebody else', async () => {
    stored['slack-watcher'] = {
      status: 'paused',
      runsSinceRotate: 0,
      runs: [],
    };
    ledgerOpenAsks = [
      {
        id: '20260830-120000-0001',
        ts: 1,
        from: 'some-session',
        kind: 'ask',
        body: 'unrelated',
      } as LedgerEntry,
    ];

    await expect(
      invoke(CH.agentsResume, { name: 'slack-watcher' }),
    ).resolves.toBe('sleeping');
  });

  it('is idempotent: resuming an agent that was never paused writes nothing', async () => {
    stored['slack-watcher'] = {
      status: 'sleeping',
      runsSinceRotate: 0,
      runs: [],
    };

    await expect(
      invoke(CH.agentsResume, { name: 'slack-watcher' }),
    ).resolves.toBe('sleeping');

    expect(statePatch).not.toHaveBeenCalled();
  });

  /**
   * The destructive case the guard exists for: resume is the inverse of pause
   * and of nothing else. Applied to a running agent it would rewrite the row to
   * `sleeping` while the process is still going, and only the next
   * `finalizeRun` would put it back.
   */
  it('will not resume a working agent out of its own run', async () => {
    stored['slack-watcher'] = {
      status: 'working',
      runsSinceRotate: 0,
      runs: [],
    };

    await expect(
      invoke(CH.agentsResume, { name: 'slack-watcher' }),
    ).resolves.toBe('working');

    expect(statePatch).not.toHaveBeenCalled();
  });

  it('takes the same name guard as every other verb in the namespace', async () => {
    await expect(invoke(CH.agentsPause, { name: '../../claude' })).rejects.toThrow();
    await expect(invoke(CH.agentsResume, { name: '../../claude' })).rejects.toThrow();
    expect(statePatch).not.toHaveBeenCalled();
  });

  it('refuses a payload carrying anything but a name', async () => {
    await expect(
      invoke(CH.agentsPause, { name: 'slack-watcher', until: 'tomorrow' }),
    ).rejects.toThrow();
    expect(statePatch).not.toHaveBeenCalled();
  });

  /**
   * The counterpart to `agents:kill still answers a boolean once the runtime is
   * gone`, and it goes the other way on purpose: `kill`'s type has a value for
   * "nothing happened" and this one's does not. Every {@link AgentStatus} is a
   * claim that something was written, so a pause that reached no file has to
   * reject rather than pick one.
   */
  it('rejects rather than reporting a status it never wrote', async () => {
    resetIpcHandlers();

    // Whichever guard fires first, the promise rejects — what must never happen
    // is a resolved `AgentStatus` for a write that reached no file.
    await expect(
      invoke(CH.agentsPause, { name: 'slack-watcher' }),
    ).rejects.toThrow();
    await expect(
      invoke(CH.agentsResume, { name: 'slack-watcher' }),
    ).rejects.toThrow();
  });

  /**
   * A name with no definition is refused before anything is written.
   *
   * `parseAgentNameRequest` validates the name's *shape* only, and
   * `AgentState.patch` creates whatever entry it is handed — so without this
   * guard, `pause` on an unknown name persisted `{"ghost": {"status":
   * "paused"}}` forever, and an agent later created under that name would be
   * born paused with nothing on screen to explain it. The namespace's own
   * security note claims these verbs cannot create an agent; this is what makes
   * that true of its run state too.
   */
  it.each([CH.agentsPause, CH.agentsResume])(
    '%s refuses a name with no definition, writing nothing',
    async (channel) => {
      await expect(invoke(channel, { name: 'ghost' })).rejects.toThrow(
        'No such agent: ghost',
      );
      expect(statePatch).not.toHaveBeenCalled();
    },
  );

  /**
   * A pause is allowed to land mid-turn, so `paused` and "a child is alive" are
   * not exclusive — and resuming there must not put a resting word on a row
   * whose agent is still working. `run` would immediately contradict it.
   */
  it('resumes a mid-run pause back to working, not to sleeping', async () => {
    stored['slack-watcher'] = {
      status: 'paused',
      runsSinceRotate: 0,
      runs: [],
    };
    liveRuns = ['slack-watcher'];

    await expect(
      invoke(CH.agentsResume, { name: 'slack-watcher' }),
    ).resolves.toBe('working');

    expect(statePatch).toHaveBeenCalledWith('slack-watcher', {
      status: 'working',
    });
  });
});

describe('agents:list merges run state (R2)', () => {
  it('answers with the definition joined to what has happened to it', async () => {
    stored['slack-watcher'] = {
      status: 'working',
      runsSinceRotate: 4,
      sessionUuid: 'uuid-1',
      lastRunAt: 99,
      runs: [
        {
          run: 'r1',
          trigger: 'manual',
          startedAt: 1,
          endedAt: 2,
          outcome: 'done',
          costUsd: 1.25,
        },
      ],
    };

    const result = (await invoke(CH.agentsList)) as AgentsSnapshot;

    expect(result.agents[0]).toMatchObject({
      name: 'slack-watcher',
      status: 'working',
      sessionUuid: 'uuid-1',
      runsSinceRotate: 4,
      lastRunAt: 99,
      cost: '$1.25',
    });
  });

  it('leaves an agent that has never run untouched', async () => {
    const result = (await invoke(CH.agentsList)) as AgentsSnapshot;

    expect(result.agents[0]).toEqual(definition('slack-watcher'));
  });
});

/**
 * The scheduler's three seams, from outside (HIVE-120).
 *
 * What is asserted here is the *composition* — that main subscribed the
 * scheduler to the ledger, handed the tracker an `onRunClosed`, and told it
 * about a resume. The rules themselves belong to `scheduler.test.ts`.
 */
describe('ledger-addressed wakes reach the tracker (HIVE-120)', () => {
  const addressed = (over: Partial<LedgerEntry> = {}): LedgerEntry => ({
    id: 'a1',
    ts: 0,
    from: OVERMIND,
    to: 'slack-watcher',
    kind: 'ask',
    body: 'take a look?',
    ...over,
  });

  /** The default fixture's `wake.on` is empty, which is now a gate. */
  const subscribed = async (): Promise<void> => {
    listed = {
      agents: [{ ...definition('slack-watcher'), wake: { on: ['ledger'] } }],
      agentsRoot: '/tmp/.hive/agents',
    };
    onAgentsChanged?.();
    await settle();
  };

  it('wakes the agent an entry names, with the ledger trigger', async () => {
    await subscribed();

    capturedOnChange?.(addressed());

    expect(trackerRun).toHaveBeenCalledWith(
      'slack-watcher',
      'ledger',
      'ask a1 from overmind',
    );
  });

  it('leaves an agent whose definition omits ledger alone', () => {
    /*
      The default fixture has `wake: { on: [] }`. Settings promises that means
      "a question addressed to it waits unread until then", so an entry must
      neither wake it nor queue against it.
    */
    capturedOnChange?.(addressed());

    expect(trackerRun).not.toHaveBeenCalled();
    expect(statePatch).not.toHaveBeenCalledWith(
      'slack-watcher',
      expect.objectContaining({ pendingWake: expect.anything() }),
    );
  });

  it('leaves an entry addressed to a session alone', () => {
    capturedOnChange?.(addressed({ to: 'sess-1' }));

    expect(trackerRun).not.toHaveBeenCalled();
  });

  it('leaves a broadcast alone', () => {
    capturedOnChange?.(addressed({ to: undefined }));

    expect(trackerRun).not.toHaveBeenCalled();
  });

  it('flushes what a run was holding when the tracker reports it closed', () => {
    stored['slack-watcher'] = {
      status: 'sleeping',
      runsSinceRotate: 0,
      runs: [],
      pendingWake: [{ kind: 'answer', id: 'a4', from: OVERMIND }],
    };

    trackerDeps?.onRunClosed?.('slack-watcher');

    expect(trackerRun).toHaveBeenCalledWith(
      'slack-watcher',
      'ledger',
      'answer a4 from overmind',
    );
  });

  it('flushes what a pause was holding when the agent resumes', async () => {
    stored['slack-watcher'] = {
      status: 'paused',
      runsSinceRotate: 0,
      runs: [],
      pendingWake: [{ kind: 'ask', id: 'a5', from: OVERMIND }],
    };

    await invoke(CH.agentsResume, { name: 'slack-watcher' });

    expect(trackerRun).toHaveBeenCalledWith(
      'slack-watcher',
      'ledger',
      'ask a5 from overmind',
    );
  });
});

describe('the ledger accepts an agent as a party (HIVE-115)', () => {
  it('knows an agent the registry listed', () => {
    expect(capturedKnowsParty?.('slack-watcher')).toBe(true);
  });

  it('still refuses a name that is neither a session nor an agent', () => {
    expect(capturedKnowsParty?.('stranger')).toBe(false);
  });

  it('drops an agent whose folder has gone', async () => {
    listed = { agents: [], agentsRoot: '/tmp/.hive/agents' };
    onAgentsChanged?.();
    await settle();

    expect(capturedKnowsParty?.('slack-watcher')).toBe(false);
  });

  it('never accepts a folder the registry listed as invalid', async () => {
    listed = {
      agents: [{ ...definition('broken'), invalid: 'name: Required.' }],
      agentsRoot: '/tmp/.hive/agents',
    };
    onAgentsChanged?.();
    await settle();

    expect(capturedKnowsParty?.('broken')).toBe(false);
  });

  it('keeps a live run a party while its definition is being edited', async () => {
    /*
      The epic's own premise, not an edge case: an agent is meant to be edited
      in a text editor while it works, and a save mid-edit routinely lands a
      file that does not parse. A rebuild that dropped the name would refuse
      the running child's hooks, its `ledger_*` calls, and — silently — the
      `run.ended` its own tracker appends at close.
    */
    liveRuns = ['slack-watcher'];
    listed = {
      agents: [{ ...definition('slack-watcher'), invalid: 'model: Unknown.' }],
      agentsRoot: '/tmp/.hive/agents',
    };
    onAgentsChanged?.();
    await settle();

    expect(capturedKnowsParty?.('slack-watcher')).toBe(true);

    // And it leaves again once the run has ended.
    liveRuns = [];
    onAgentsChanged?.();
    await settle();

    expect(capturedKnowsParty?.('slack-watcher')).toBe(false);
  });

  it('accepts an agent the moment a command was built for it, listing or not', () => {
    listed = { agents: [], agentsRoot: '/tmp/.hive/agents' };

    // A real `command()` reads the definition off main's own disk, so a
    // successful build is a stronger proof of existence than the cached list.
    // The build fails here (no such file), which is the case that must *not*
    // widen the ledger.
    trackerDeps?.command('never-listed', 'manual');

    expect(capturedKnowsParty?.('never-listed')).toBe(false);
  });
});

describe('what the tracker was handed (HIVE-115)', () => {
  it('appends a run entry as the agent, never as the coordinator', () => {
    trackerDeps?.appendLedger({
      from: 'slack-watcher',
      kind: 'event',
      body: 'run.started — manual',
      meta: { run: 'run-1' },
    });

    expect(ledgerAppend).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'slack-watcher' }),
    );
  });

  it('logs a refused append instead of discarding it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    ledgerAppend.mockReturnValueOnce({
      ok: false,
      status: 404,
      reason: 'unknown party',
    } as never);

    trackerDeps?.appendLedger({
      from: 'slack-watcher',
      kind: 'event',
      body: 'run.ended — done',
      meta: { run: 'run-1' },
    });

    /*
      The result was being dropped on the floor, which made a refused
      `run.ended` invisible: the log simply grew a `run.started` with no end
      and nothing anywhere said why.
    */
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('slack-watcher'),
      'unknown party',
    );

    warn.mockRestore();
  });

  it('counts an ask posted after this run started', () => {
    ledgerEntries = [
      {
        id: '20260830-010000-0001',
        ts: 1,
        from: 'slack-watcher',
        kind: 'event',
        body: 'run.started — manual',
        meta: { run: 'run-1' },
      },
    ];
    ledgerOpenAsks = [
      {
        id: '20260830-010500-0002',
        ts: 2,
        from: 'slack-watcher',
        kind: 'ask',
        body: 'which channel?',
      },
    ];

    expect(trackerDeps?.openAsksFor('slack-watcher', 'run-1')).toBe(true);
  });

  it('ignores an ask left open by an earlier run', () => {
    ledgerOpenAsks = [
      {
        id: '20260830-005900-0001',
        ts: 1,
        from: 'slack-watcher',
        kind: 'ask',
        body: 'older question',
      },
    ];
    ledgerEntries = [
      {
        id: '20260830-010000-0002',
        ts: 2,
        from: 'slack-watcher',
        kind: 'event',
        body: 'run.started — manual',
        meta: { run: 'run-2' },
      },
    ];

    expect(trackerDeps?.openAsksFor('slack-watcher', 'run-2')).toBe(false);
  });

  it('never counts an open ask belonging to another party', () => {
    ledgerOpenAsks = [
      {
        id: '20260830-010500-0002',
        ts: 2,
        from: 'overmind',
        kind: 'ask',
        body: 'anyone?',
      },
    ];

    expect(trackerDeps?.openAsksFor('slack-watcher', 'run-1')).toBe(false);
  });

  it('pushes a status built from the state file, to live windows only', () => {
    const liveSend = vi.fn();
    const destroyedSend = vi.fn();
    windows.push(
      { isDestroyed: () => false, webContents: { send: liveSend } },
      { isDestroyed: () => true, webContents: { send: destroyedSend } },
    );
    stored['slack-watcher'] = {
      status: 'asking',
      runsSinceRotate: 1,
      lastRunAt: 77,
      runs: [
        {
          run: 'r1',
          trigger: 'manual',
          startedAt: 1,
          endedAt: 2,
          outcome: 'asking',
          costUsd: 0.0031,
        },
      ],
    };

    trackerDeps?.pushStatus('slack-watcher');

    expect(liveSend).toHaveBeenCalledWith(CH.agentsStatus, {
      name: 'slack-watcher',
      status: 'asking',
      lastRunAt: 77,
      cost: '$0.0031',
      /*
        The history rides along since HIVE-116, so the agent view's `Today`
        tile can move the moment a run closes. `cost` stays the *last* run's:
        a row draws one number, a view draws the sum, and both are answered
        from this one push rather than from a re-list.
      */
      runsSinceRotate: 1,
      runs: [
        {
          run: 'r1',
          trigger: 'manual',
          startedAt: 1,
          endedAt: 2,
          outcome: 'asking',
          costUsd: 0.0031,
        },
      ],
    });
    expect(destroyedSend).not.toHaveBeenCalled();
  });

  it('never puts the session uuid on a status push', () => {
    const send = vi.fn();
    windows.push({ isDestroyed: () => false, webContents: { send } });
    stored['slack-watcher'] = {
      status: 'sleeping',
      runsSinceRotate: 1,
      sessionUuid: 'uuid-must-not-travel',
      runs: [],
    };

    trackerDeps?.pushStatus('slack-watcher');

    expect(send.mock.calls[0]?.[1]).not.toHaveProperty('sessionUuid');
  });

  it('pushes run-log lines under the agent that wrote them', () => {
    const send = vi.fn();
    windows.push({ isDestroyed: () => false, webContents: { send } });

    trackerDeps?.pushLines('slack-watcher', [{ text: 'hello', color: 'ink' }]);

    expect(send).toHaveBeenCalledWith(CH.agentsLines, {
      name: 'slack-watcher',
      lines: [{ text: 'hello', color: 'ink' }],
    });
  });
});

describe('quitting with a run in flight (HIVE-115)', () => {
  it('closes every live run rather than only signalling it, then flushes', () => {
    liveRuns = ['slack-watcher'];

    for (const hook of shutdownHooks) hook();

    /*
      `closeAll`, not `killAll`. This hook is synchronous, so the child's
      'close' — which is what records the summary, the `run.ended` entry and
      the `sleeping` status — cannot arrive before the process is gone. Only a
      finalizer that does not wait for an event can leave `agents.json` and the
      log truthful, and the flush below is what writes it.
    */
    expect(trackerCloseAll).toHaveBeenCalledWith('app-closed');
    expect(trackerKillAll).not.toHaveBeenCalled();
    expect(stateFlush).toHaveBeenCalled();
  });

  it('flushes even when nothing was running', () => {
    for (const hook of shutdownHooks) hook();

    expect(trackerCloseAll).toHaveBeenCalledWith('app-closed');
    expect(stateFlush).toHaveBeenCalled();
  });
});

describe('tearing the handlers down (HIVE-115)', () => {
  /**
   * `killAll` only *signals*. The `'close'` events land afterwards, run the
   * finalizer, and `recordRun` arms a fresh 400 ms debounce against a state
   * that has already been disposed — writing `agents.json` at whatever
   * `configPath()` a spec stubbed, which is precisely the leak `dispose()`
   * exists to cancel, and pushing status into a torn-down IPC layer on the way.
   * `closeAll` finalizes synchronously, so everything it schedules is scheduled
   * before the dispose that cancels it.
   */
  it('closes every run before disposing the state, never merely signalling', () => {
    liveRuns = ['slack-watcher'];

    resetIpcHandlers();

    expect(trackerCloseAll).toHaveBeenCalledWith('reset');
    expect(trackerKillAll).not.toHaveBeenCalled();
    expect(stateDispose).toHaveBeenCalled();
    expect(trackerCloseAll.mock.invocationCallOrder[0]).toBeLessThan(
      stateDispose.mock.invocationCallOrder[0]!,
    );
  });

  /**
   * The channel is declared `Promise<boolean>`, and "the runtime is not
   * running" is the same news to the renderer as "there was nothing to stop".
   * `undefined` is neither.
   */
  it('agents:kill still answers a boolean once the runtime is gone', async () => {
    resetIpcHandlers();

    await expect(invoke(CH.agentsKill, { name: 'slack-watcher' })).resolves.toBe(
      false,
    );
  });
});

describe('what the registry was handed (HIVE-115)', () => {
  /**
   * A delete or a rename has to reach `agents.json` and `~/.hive/work/<name>`,
   * and only this composition knows both. Without them a name freed by a delete
   * is reused with the previous agent's session uuid still attached, so its
   * first wake resumes a conversation that belonged to something else.
   */
  it('gives it a way to move the run bookkeeping a folder does not hold', () => {
    expect(runtimeOptions?.runFiles).toBeDefined();
  });
});
