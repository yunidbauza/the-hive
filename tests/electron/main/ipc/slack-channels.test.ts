// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_SLACK,
  emptySnapshot,
} from '../../../../electron/shared/config-contract';
import type {
  SlackSocketStatus,
  SlackSocketTestResult,
  SlackStatus,
  SlackTokensState,
} from '../../../../electron/shared/slack-contract';

/**
 * Slack's four channels (HIVE-123) — what `ipc/index.ts` *does with* the
 * functions Tasks 3 and 4 built, not their own rules.
 *
 * `readSlackStatus`, `signInToSlack`, `signOutOfSlack` and `probeSlack` are
 * faked the way `createLedger` is faked in `ledger-channels.test.ts`, and for
 * the same reason: parsing `claude mcp get`, the two-step sign-in, and the
 * `stream-json` probe are each covered by their own suite under
 * `tests/electron/main/integrations/slack/`. What belongs here is the seam:
 *
 * - each channel calls the right function;
 * - the `claude` it is handed is `getConfig().claudeCommand` **through
 *   `resolveClaude`**, the same resolver every agent wake goes through — these
 *   four were the only callers in the app that ran the bare configured name;
 * - each verb gets the right runner — the synchronous `runCommand` for the one
 *   local file edit, the async one for the three that wait on a browser, a
 *   model turn, or an HTTP health check;
 * - the async runner is wrapped so a quit can hang up on the child;
 * - a second call while one is in flight joins it rather than starting a rival;
 * - and a payload arriving on any of the four is inert. There is no validator
 *   throwing `IpcValidationError` here; the handler signature simply does not
 *   declare a `payload` parameter, so nothing from the renderer can reach the
 *   call.
 */

const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();

vi.mock('electron', () => ({
  app: {
    getVersion: () => '0.0.0',
    on: vi.fn(),
    removeListener: vi.fn(),
    // Per-spec, never shared: these specs really write a container set here,
    // and vitest runs spec files in parallel worker processes (HIVE-139).
    getPath: () => '/tmp/hive-test-slack-channels',
  },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
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

/**
 * The quit hooks, captured rather than swallowed (HIVE-124).
 *
 * `resetIpcHandlers` is the *test* teardown path; `onShutdown` is the
 * production one, and the two orderings are independent facts. The socket-mode
 * suite below runs the captured hooks to assert the second.
 */
const shutdownHooks: (() => void)[] = [];

vi.mock('../../../../electron/main/shutdown', () => ({
  onShutdown: (fn: () => void) => {
    shutdownHooks.push(fn);
  },
}));

/**
 * Which teardown ran first, recorded by both participants (HIVE-124).
 *
 * The bridge produces wakes and the scheduler consumes them, so a bridge that
 * outlives its scheduler calls `onEvent` into a disposed `agentState` — the
 * class of bug `slackChildren` was created to fix. Ordering is the whole risk
 * of this composition, which makes it worth an assertion rather than a comment.
 */
const teardownOrder: string[] = [];

/**
 * `claudeCommand` deliberately not `'claude'` — a value the real config could
 * never produce by default — so a test that accidentally asserted against the
 * hard-coded string the brief warned off would fail loudly instead of passing
 * by coincidence.
 *
 * `process.execPath` because the handlers now put it through `resolveClaude`,
 * which asks the disk: a made-up path is refused, with a sentence, and that
 * refusal is its own test below. This is the node binary running the suite —
 * absolute, executable, and different on every machine, which is exactly what
 * makes "the resolver ran" observable.
 *
 * Mutable, so the refusal test can point it somewhere that is not there.
 *
 * Built on the whole snapshot, so no getter reading a field this fixture forgot
 * can throw into a swallowing catch (HIVE-139); `claudeCommand` stays this
 * file's own for the reason above.
 */
const snapshot = {
  ...emptySnapshot('/tmp/config.json', '/bin/zsh'),
  claudeCommand: process.execPath,
  /*
    HIVE-124. The block the bridge reads its switch and allow-list from.

    `emptySnapshot` already supplies a fully resolved `slack`, so this is not
    filling a gap — it restates the field only to widen its type to a mutable
    one, because the composition tests below move the switch and re-`sync()`.
    Spread from `DEFAULT_SLACK` rather than written out, so a third field on
    `SlackConfig` reaches this fixture rather than drifting from it.
  */
  slack: { ...DEFAULT_SLACK } as { socketMode: boolean; commanders: string[] },
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
  // HIVE-124. The write verb `config:set-slack` calls; Task 2 shipped it.
  setSlack: vi.fn(() => snapshot),
  /*
    The other two paths that change `slack.socketMode` without any Slack verb
    having been called: a hand edit read back by Reload, and Reset writing
    `DEFAULT_SLACK` over whatever was there.
  */
  resetConfig: vi.fn(() => snapshot),
  configPath: vi.fn(() => '/tmp/config.json'),
}));

vi.mock('../../../../electron/main/sessions/history', () => ({
  createSessionHistory: () => ({
    begin: vi.fn(),
    record: vi.fn(),
    resumable: () => undefined,
    all: () => [],
    flush: vi.fn(),
    dispose: vi.fn(),
  }),
}));

vi.mock('../../../../electron/main/sessions/index', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../../electron/main/sessions/index')>();
  return {
    ...actual,
    createSessions: (options: Parameters<typeof actual.createSessions>[0]) => ({
      ...actual.createSessions(options),
      entities: () => [],
    }),
  };
});

/**
 * The registry and the run state, faked the way `agent-channels.test.ts` fakes
 * them (HIVE-124).
 *
 * `agents:pause` goes through `requireAgent`, which asks the registry whether a
 * definition exists, and then through `setAgentStatus`, which writes run state.
 * Both are on the path from "a person paused an agent" to "the socket may no
 * longer be needed", and neither should reach a real folder or a real file from
 * a unit test.
 */
let listedAgents: { name: string; wake: { on: string[] } }[] = [];
let agentsChanged: (() => void) | undefined;

vi.mock('../../../../electron/main/agents', () => ({
  createAgentsRuntime: () => ({
    list: () =>
      Promise.resolve({
        agents: listedAgents.map((agent) => ({
          name: agent.name,
          wake: { on: agent.wake.on },
          mcp: [],
          parallel: 1,
        })),
        agentsRoot: '/tmp/.hive/agents',
      }),
    read: vi.fn(),
    write: vi.fn(),
    remove: vi.fn(),
    rename: vi.fn(),
    onChange: (fn: () => void) => {
      agentsChanged = fn;

      return () => {};
    },
    close: vi.fn(),
  }),
}));

let runStates: Record<string, { status: string; runsSinceRotate: number; runs: [] }> =
  {};

vi.mock('../../../../electron/main/agents/state', () => ({
  createAgentState: () => ({
    all: () => ({ ...runStates }),
    read: (name: string) =>
      runStates[name] ?? { status: 'sleeping', runsSinceRotate: 0, runs: [] },
    patch: (name: string, change: Record<string, unknown>) => {
      const next = {
        ...(runStates[name] ?? { status: 'sleeping', runsSinceRotate: 0, runs: [] }),
        ...change,
      };
      runStates[name] = next as (typeof runStates)[string];

      return next;
    },
    recordRun: vi.fn(),
    forget: vi.fn(),
    carry: vi.fn(),
    clearSlackNeedsAuth: () => [],
    flush: vi.fn(),
    dispose: vi.fn(),
  }),
}));

vi.mock('../../../../electron/main/ledger', () => ({
  createLedger: () => ({
    read: vi.fn(() => ({ entries: [], openAsks: [], claims: {} })),
    append: vi.fn(),
    answer: vi.fn(),
    onChange: () => () => {},
  }),
}));

const readSlackStatus = vi.fn<(claude: string, run: unknown) => Promise<SlackStatus>>(
  () => Promise.resolve({ kind: 'connected' }),
);
const signInToSlack = vi.fn<(claude: string, run: unknown) => Promise<SlackStatus>>(
  () => Promise.resolve({ kind: 'connected' }),
);
const signOutOfSlack = vi.fn<(claude: string, run: unknown) => SlackStatus>(
  () => ({ kind: 'not-added' }),
);
const probeSlack = vi.fn<(claude: string, run: unknown) => Promise<SlackStatus>>(
  () => Promise.resolve({ kind: 'connected' }),
);

vi.mock('../../../../electron/main/integrations/slack/status', () => ({
  readSlackStatus: (claude: string, run: unknown) => readSlackStatus(claude, run),
}));
vi.mock('../../../../electron/main/integrations/slack/login', () => ({
  signInToSlack: (claude: string, run: unknown) => signInToSlack(claude, run),
  signOutOfSlack: (claude: string, run: unknown) => signOutOfSlack(claude, run),
}));
vi.mock('../../../../electron/main/integrations/slack/probe', () => ({
  probeSlack: (claude: string, run: unknown) => probeSlack(claude, run),
}));

/* ------------------------------------------------- socket mode (HIVE-124) */

/**
 * The token store, in memory and holding the real values.
 *
 * Faked rather than driven for the reason `readSlackStatus` is: `tokens.ts` has
 * its own suite, and the real one reaches `safeStorage` and a file under
 * `userData`. What this fake keeps is the part the invariant needs — it really
 * stores the secret — so a verb that leaked one would have something to leak.
 */
let stored: { appToken?: string; botToken?: string } = {};

const tokensState = (): SlackTokensState => ({
  hasAppToken: stored.appToken !== undefined,
  hasBotToken: stored.botToken !== undefined,
  encryptionAvailable: true,
});

vi.mock('../../../../electron/main/integrations/slack/tokens', () => ({
  createSlackTokens: () => ({
    state: tokensState,
    read: () => stored,
    save: (next: { appToken?: string; botToken?: string }) => {
      stored = { ...stored, ...next };

      return tokensState();
    },
    clear: () => {
      stored = {};

      return tokensState();
    },
  }),
}));

/**
 * The bridge, counted rather than run.
 *
 * `bridge.ts` has its own suite driving a fake socket; what belongs here is
 * *when* `ipc/index.ts` re-syncs it, and that is a count. The dependencies it
 * was built with are kept so the composition — which config block it reads,
 * which agents it asks about — can be asserted without opening anything.
 */
let bridgeSyncs = 0;
let bridgeDeps: {
  config: () => { socketMode: boolean; commanders: string[] };
  subscriptions: () => { channels: Map<string, string[]>; mentions: string[]; known: string[] };
  onStatus: (status: SlackSocketStatus) => void;
} | null = null;

const bridgeTest = vi.fn<() => Promise<SlackSocketTestResult>>(() =>
  Promise.resolve({ kind: 'ok', workspace: 'acme', bot: 'hive' }),
);

/** What `SlackBridge.status()` answers — the last status it pushed. */
let bridgeStatus: SlackSocketStatus = { kind: 'off' };

vi.mock('../../../../electron/main/integrations/slack/bridge', () => ({
  createSlackBridge: (deps: never) => {
    bridgeDeps = deps;

    return {
      sync: () => {
        bridgeSyncs += 1;
      },
      status: () => bridgeStatus,
      test: () => bridgeTest(),
      unresolved: () => [],
      stop: () => {
        teardownOrder.push('bridge');
      },
    };
  },
}));

/**
 * The two SDK adapters, replaced so importing this layer does not pull
 * `@slack/socket-mode` and `@slack/web-api` into every suite that touches
 * `ipc/index.ts`. Nothing here is called: the bridge above never connects.
 */
vi.mock('../../../../electron/main/integrations/slack/clients', () => ({
  openSlackSocket: vi.fn(),
  openSlackWeb: vi.fn(),
}));

/**
 * The real scheduler, with a `stop` that says when it ran.
 *
 * Wrapped rather than replaced: the composition below builds a live scheduler
 * from the live tracker, and swapping in a stub would make the ordering
 * assertion a statement about the stub.
 */
vi.mock('../../../../electron/main/agents/scheduler', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../../electron/main/agents/scheduler')>();

  return {
    ...actual,
    createScheduler: (deps: Parameters<typeof actual.createScheduler>[0]) => {
      const real = actual.createScheduler(deps);

      return {
        ...real,
        stop: () => {
          teardownOrder.push('scheduler');
          real.stop();
        },
      };
    },
  };
});

/**
 * The shared async runner, spied rather than executed.
 *
 * The Slack verbs are handed a **wrapper** around it now — the one that carries
 * the abort signal a quit fires — so identity against the export no longer says
 * anything. What the wrapper does when called is the fact worth pinning, and
 * that needs the real module replaced.
 */
const asyncRun = vi.fn<
  (
    file: string,
    args: readonly string[],
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ) => Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }>
>(() => Promise.resolve({ code: 0, stdout: '', stderr: '', timedOut: false }));

vi.mock('../../../../electron/main/integrations/github/run', () => ({
  runAsync: (
    file: string,
    args: readonly string[],
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ) => asyncRun(file, args, options),
}));

const { CH } = await import('../../../../electron/shared/ipc-contract');
const { runCommand } = await import('../../../../electron/main/integrations/gh');
const { registerIpcHandlers, resetIpcHandlers } = await import(
  '../../../../electron/main/ipc'
);

const mainFrame = { url: 'file:///out/renderer/index.html' };
const trustedEvent = { senderFrame: mainFrame, sender: { mainFrame } } as never;

const call = (channel: string, payload: unknown = undefined) =>
  Promise.resolve().then(() => handlers.get(channel)!(trustedEvent, payload));

beforeEach(() => {
  handlers.clear();
  vi.clearAllMocks();
  shutdownHooks.length = 0;
  teardownOrder.length = 0;
  bridgeSyncs = 0;
  bridgeDeps = null;
  bridgeStatus = { kind: 'off' };
  stored = {};
  listedAgents = [{ name: 'pr-patrol', wake: { on: ['slack.channel:#eng'] } }];
  agentsChanged = undefined;
  runStates = {};
  snapshot.slack = { ...DEFAULT_SLACK };
  registerIpcHandlers();
});

afterEach(() => {
  resetIpcHandlers();
});

describe('slack channels (HIVE-123)', () => {
  it('answers slack:status from the cheap read', async () => {
    readSlackStatus.mockResolvedValueOnce({ kind: 'connected' });

    await expect(call(CH.slackStatus)).resolves.toEqual({ kind: 'connected' });
    expect(readSlackStatus).toHaveBeenCalledOnce();
  });

  /**
   * `claude mcp get` health-checks the server over HTTP — about 1.7 s measured
   * — so on `gh.ts`'s five-second `spawnSync` helper it was a network call on
   * the main process's event loop, freezing IPC, pty chunks and the scheduler,
   * with two components asking for it on mount.
   */
  it('gives slack:status the async runner, not the synchronous one', async () => {
    await call(CH.slackStatus);

    expect(readSlackStatus).toHaveBeenCalledWith(
      process.execPath,
      expect.any(Function),
    );
    expect(readSlackStatus).not.toHaveBeenCalledWith(
      expect.anything(),
      runCommand,
    );
  });

  /**
   * The login waits on a browser OAuth round-trip, and the read-back it ends
   * with is that same `mcp get` — so the whole verb is asynchronous and takes
   * one runner. Handing it `runCommand` was the defect: a five-second
   * `spawnSync` cap meant the sign-in could never succeed, and every attempt
   * froze the main process on its way to failing.
   */
  it('routes slack:sign-in to signInToSlack with the async runner alone', async () => {
    signInToSlack.mockResolvedValueOnce({ kind: 'needs-auth' });

    await expect(call(CH.slackSignIn)).resolves.toEqual({ kind: 'needs-auth' });
    expect(signInToSlack).toHaveBeenCalledWith(
      process.execPath,
      expect.any(Function),
    );
    expect(signInToSlack.mock.calls[0]).toHaveLength(2);
  });

  /** The one verb with no network and no model in it: a local JSON edit. */
  it('routes slack:sign-out to signOutOfSlack on the synchronous runner', async () => {
    signOutOfSlack.mockReturnValueOnce({ kind: 'not-added' });

    await expect(call(CH.slackSignOut)).resolves.toEqual({ kind: 'not-added' });
    expect(signOutOfSlack).toHaveBeenCalledWith(process.execPath, runCommand);
  });

  /** Model turns cannot run on the five-second synchronous runner either. */
  it('routes slack:test to probeSlack with the async runner', async () => {
    probeSlack.mockResolvedValueOnce({ kind: 'pending-approval' });

    await expect(call(CH.slackTest)).resolves.toEqual({ kind: 'pending-approval' });
    expect(probeSlack).toHaveBeenCalledWith(process.execPath, expect.any(Function));
  });

  /**
   * `gh.ts` wrote the rule and these four were the only callers skipping it:
   * "the resolved absolute path is what runs, never the bare name". Every agent
   * wake goes through `resolveClaude`; a `claudeCommand` that is a shell
   * function or that carries arguments is unreachable from a child spawned
   * without a shell, and the resolver's refusal *says which* — where the bare
   * name gave the pane a raw `spawn ENOENT`.
   */
  describe('the claude binary is resolved, not passed through', () => {
    const configured = snapshot.claudeCommand;

    afterEach(() => {
      snapshot.claudeCommand = configured;
    });

    it('refuses with the resolver’s own sentence, and runs nothing', async () => {
      snapshot.claudeCommand = '/opt/hive-test/claude';

      await expect(call(CH.slackStatus)).resolves.toEqual({
        kind: 'error',
        message: '`/opt/hive-test/claude` is not an executable file.',
      });
      expect(readSlackStatus).not.toHaveBeenCalled();
    });

    it('refuses a command carrying arguments rather than word-splitting it', async () => {
      snapshot.claudeCommand = 'claude --dangerously-skip-permissions';

      const status = (await call(CH.slackSignIn)) as SlackStatus;

      expect(status.kind).toBe('error');
      expect(signInToSlack).not.toHaveBeenCalled();
    });

    /** A refusal is not cached: the Settings edit that fixes it must land. */
    it('re-resolves per call, so fixing the setting is enough', async () => {
      snapshot.claudeCommand = '/opt/hive-test/claude';
      await call(CH.slackStatus);
      snapshot.claudeCommand = configured;

      await expect(call(CH.slackStatus)).resolves.toEqual({ kind: 'connected' });
      expect(readSlackStatus).toHaveBeenCalledOnce();
    });
  });

  /**
   * The runner the verbs are handed is a **wrapper**, and its one addition is
   * the abort signal `before-quit` fires. Without it a `claude mcp login`
   * survived the quit for the rest of its ten-minute budget, holding Slack's
   * single registered callback port 3118 against the next launch's sign-in.
   */
  it('hands the verbs a runner that carries the quit signal', async () => {
    await call(CH.slackTest);

    const run = probeSlack.mock.calls[0]?.[1] as (
      file: string,
      args: readonly string[],
      options?: { timeoutMs?: number },
    ) => Promise<unknown>;

    await run('/bin/echo', ['hi'], { timeoutMs: 1_000 });

    expect(asyncRun).toHaveBeenCalledWith('/bin/echo', ['hi'], {
      timeoutMs: 1_000,
      signal: expect.any(AbortSignal),
    });
  });

  /**
   * The pane guards its own buttons, but only while it stays mounted: closing
   * Settings and reopening it re-enables them. Two `mcp login` children then
   * contend for port 3118, and two probes spend two sets of model turns for one
   * answer — so the guarantee belongs to the verb, in main.
   */
  describe('a second call joins the one in flight', () => {
    it('starts one sign-in for two clicks, and answers both', async () => {
      let settle = (_status: SlackStatus): void => {};
      signInToSlack.mockReturnValueOnce(
        new Promise<SlackStatus>((resolve) => {
          settle = resolve;
        }),
      );

      const first = call(CH.slackSignIn);
      const second = call(CH.slackSignIn);

      await Promise.resolve();
      settle({ kind: 'connected' });

      await expect(first).resolves.toEqual({ kind: 'connected' });
      await expect(second).resolves.toEqual({ kind: 'connected' });
      expect(signInToSlack).toHaveBeenCalledOnce();
    });

    it('starts one probe for two clicks', async () => {
      let settle = (_status: SlackStatus): void => {};
      probeSlack.mockReturnValueOnce(
        new Promise<SlackStatus>((resolve) => {
          settle = resolve;
        }),
      );

      const both = [call(CH.slackTest), call(CH.slackTest)];

      await Promise.resolve();
      settle({ kind: 'pending-approval' });
      await Promise.all(both);

      expect(probeSlack).toHaveBeenCalledOnce();
    });

    /** Released on settle, or the pane could never ask a second time. */
    it('lets the next call through once the first has answered', async () => {
      await call(CH.slackTest);
      await call(CH.slackTest);

      expect(probeSlack).toHaveBeenCalledTimes(2);
    });

    /** Different verbs are different keys — a slow sign-in must not gag Test. */
    it('does not let one verb block another', async () => {
      signInToSlack.mockReturnValueOnce(new Promise<SlackStatus>(() => {}));

      void call(CH.slackSignIn);

      await expect(call(CH.slackTest)).resolves.toEqual({ kind: 'connected' });
    });
  });

  /**
   * There is no `IpcValidationError` here, and the brief's snippet guessed
   * wrong: `CH.integrationsStatus` and `CH.jiraStatus` refuse nothing because
   * their handlers simply do not declare a `payload` parameter — the guard is
   * structural, not a thrown error. The four Slack handlers copy that exact
   * shape, so a payload is inert rather than rejected: the underlying
   * function is still called with exactly `(claude, run)`, and whatever a
   * caller tried to smuggle in never reaches it.
   */
  it('ignores a payload on every slack verb — the handler signature takes none', async () => {
    for (const channel of [
      CH.slackStatus,
      CH.slackSignIn,
      CH.slackSignOut,
      CH.slackTest,
    ]) {
      await expect(
        call(channel, { name: 'x', command: '/bin/sh' }),
      ).resolves.toBeDefined();
    }

    /*
      Exactly two arguments on every verb — the resolved binary and the runner
      the handler chose — so nothing from the smuggled payload arrived.
    */
    for (const mock of [readSlackStatus, signInToSlack, signOutOfSlack, probeSlack]) {
      expect(mock.mock.calls[0]?.[0]).toBe(process.execPath);
      expect(mock.mock.calls[0]).toHaveLength(2);
    }

    expect(signOutOfSlack).toHaveBeenCalledWith(process.execPath, runCommand);
  });
});

/**
 * Socket mode (HIVE-124) — the five channels, and the composition behind them.
 *
 * Everything the bridge *does* is `bridge.ts`'s own suite. What belongs here is
 * what only this file can get wrong:
 *
 * - **no verb returns a token**, enumerated over the contract rather than over
 *   a list somebody remembered to extend;
 * - the bridge is re-synced at every moment that changes the answer to "should
 *   the socket be open" — the switch, the tokens, and an agent paused, written
 *   or removed;
 * - and it is **stopped before the scheduler is**, on both teardown paths,
 *   because a wake producer that outlives its consumer calls `onEvent` into a
 *   disposed `agentState`.
 */
describe('socket mode channels (HIVE-124)', () => {
  it('saves tokens and answers with presence, never a value', async () => {
    const state = await call(CH.slackSetTokens, {
      appToken: 'xapp-1-SECRET',
      botToken: 'xoxb-2-SECRET',
    });

    expect(state).toEqual({
      hasAppToken: true,
      hasBotToken: true,
      encryptionAvailable: true,
    });
    expect(JSON.stringify(state)).not.toContain('SECRET');
  });

  it('clears both tokens together', async () => {
    await call(CH.slackSetTokens, { appToken: 'xapp-1-SECRET' });

    await expect(call(CH.slackClearTokens)).resolves.toEqual({
      hasAppToken: false,
      hasBotToken: false,
      encryptionAvailable: true,
    });
  });

  /**
   * Enumerated over `CH`, not over a list — a sixth `slack:` channel added
   * later is covered by this test on the day it is added, which is the only
   * version of this assertion worth having.
   */
  it('has no verb that returns a token', async () => {
    await call(CH.slackSetTokens, {
      appToken: 'xapp-1-SECRET',
      botToken: 'xoxb-2-SECRET',
    });

    const channels = Object.values(CH).filter((channel) =>
      channel.startsWith('slack:'),
    );

    /*
      The enumeration is the test, and the floor is what makes it one: a filter
      that matched nothing would otherwise pass. Eight — `status`, `sign-in`,
      `sign-out`, `test`, `set-tokens`, `clear-tokens`, `socket-status`,
      `socket-test` — so a channel *deleted* fails here too, not only a filter
      that stopped matching.
    */
    expect(channels.length).toBeGreaterThanOrEqual(8);

    for (const channel of channels) {
      const answer = await call(channel).catch(() => null);

      expect(JSON.stringify(answer ?? null)).not.toContain('SECRET');
    }
  });

  /**
   * The half the push cannot deliver (fix-round-2, HIVE-124).
   *
   * `CH.slackSocketStatus` fires when the socket changes, `send` buffers
   * nothing and the bridge suppresses a repeat of the last status — so a pane
   * that mounts after boot learns nothing by subscribing. Token presence had
   * no read verb at all, so a fully configured bridge rendered as two empty
   * placeholders after every restart. One verb answers both.
   */
  it('answers slack:socket-state with presence and the last status pushed', async () => {
    await call(CH.slackSetTokens, {
      appToken: 'xapp-1-SECRET',
      botToken: 'xoxb-2-SECRET',
    });
    bridgeStatus = {
      kind: 'connected',
      workspace: 'acme',
      bot: 'hive',
      unresolved: ['#no-such-channel'],
    };

    const state = await call(CH.slackSocketState);

    expect(state).toEqual({
      tokens: { hasAppToken: true, hasBotToken: true, encryptionAvailable: true },
      socket: {
        kind: 'connected',
        workspace: 'acme',
        bot: 'hive',
        unresolved: ['#no-such-channel'],
      },
    });
    // Presence, never a value — the invariant every `slack:` channel keeps.
    expect(JSON.stringify(state)).not.toContain('SECRET');
  });

  it('answers slack:socket-test from the bridge, which opens nothing', async () => {
    bridgeTest.mockResolvedValueOnce({ kind: 'ok', workspace: 'acme', bot: 'hive' });

    await expect(call(CH.slackSocketTest)).resolves.toEqual({
      kind: 'ok',
      workspace: 'acme',
      bot: 'hive',
    });
  });

  describe('every change that alters the answer re-syncs', () => {
    it('re-syncs when the switch is written', async () => {
      const before = bridgeSyncs;

      await call(CH.configSetSlack, { socketMode: true, commanders: ['U1'] });

      expect(bridgeSyncs).toBeGreaterThan(before);
    });

    it('re-syncs when a token is saved, and when both are cleared', async () => {
      const before = bridgeSyncs;

      await call(CH.slackSetTokens, { appToken: 'xapp-1-SECRET' });
      const afterSave = bridgeSyncs;

      expect(afterSave).toBeGreaterThan(before);

      await call(CH.slackClearTokens);

      expect(bridgeSyncs).toBeGreaterThan(afterSave);
    });

    /**
     * The config file is meant to be hand-editable — `CH.configSetJira` says so
     * of its own block — so `slack.socketMode` changes with no verb in
     * `ipc/index.ts` having written it, and Reload is the moment the app learns
     * that happened. Without a `sync()` here, turning socket mode on by hand
     * and pressing Reload connects nothing until some unrelated agent edit
     * happens to sync.
     */
    it('re-syncs when the file is reloaded, so a hand edit lands', async () => {
      const before = bridgeSyncs;
      snapshot.slack = { socketMode: true, commanders: [] };

      await call(CH.configReload);

      expect(bridgeSyncs).toBeGreaterThan(before);
      expect(bridgeDeps?.config().socketMode).toBe(true);
    });

    /**
     * Reset writes `DEFAULT_SLACK` over whatever was there, so it turns socket
     * mode **off** — the change with the worst failure if it is missed: a live
     * socket surviving the reset keeps waking agents from a setting the user
     * has just erased.
     */
    it('re-syncs when the settings are reset', async () => {
      snapshot.slack = { socketMode: true, commanders: ['U1'] };
      const before = bridgeSyncs;

      snapshot.slack = { ...DEFAULT_SLACK };
      await call(CH.configReset);

      expect(bridgeSyncs).toBeGreaterThan(before);
      expect(bridgeDeps?.config().socketMode).toBe(false);
    });

    it('re-syncs when an agent is paused', async () => {
      const before = bridgeSyncs;

      await call(CH.agentsPause, { name: 'pr-patrol' });

      expect(bridgeSyncs).toBeGreaterThan(before);
    });

    it('re-syncs when an agent is resumed', async () => {
      await call(CH.agentsPause, { name: 'pr-patrol' });
      const before = bridgeSyncs;

      await call(CH.agentsResume, { name: 'pr-patrol' });

      expect(bridgeSyncs).toBeGreaterThan(before);
    });

    /**
     * A definition written, renamed or removed reaches the bridge through the
     * folder change, **not** from inside the handler — and that is the correct
     * seam rather than a convenience. `subscriptions()` is answered from the
     * cache `refreshKnownAgents` rebuilds, so a `sync()` fired from the write
     * handler would read the set as it was *before* the write.
     */
    it('re-syncs once the folder change has been read back', async () => {
      const before = bridgeSyncs;

      listedAgents = [];
      agentsChanged?.();
      await Promise.resolve();
      await Promise.resolve();

      expect(bridgeSyncs).toBeGreaterThan(before);
    });
  });

  describe('the composition', () => {
    it('reads the switch from the config file, live', () => {
      snapshot.slack = { socketMode: true, commanders: ['U9'] };

      expect(bridgeDeps?.config()).toEqual({ socketMode: true, commanders: ['U9'] });
    });

    /**
     * From the same cache the scheduler's tick reads, so the two can never
     * disagree about which agents are enabled — and synchronously, because
     * `sync()` is.
     */
    it('answers subscriptions from the agents the registry listed', async () => {
      agentsChanged?.();
      await Promise.resolve();
      await Promise.resolve();

      expect([...(bridgeDeps?.subscriptions().channels.keys() ?? [])]).toEqual([
        '#eng',
      ]);
      expect(bridgeDeps?.subscriptions().known).toEqual(['pr-patrol']);
    });

    it('drops a paused agent from what the socket is held open for', async () => {
      agentsChanged?.();
      await Promise.resolve();
      await Promise.resolve();

      await call(CH.agentsPause, { name: 'pr-patrol' });

      expect(bridgeDeps?.subscriptions().known).toEqual([]);
      expect([...(bridgeDeps?.subscriptions().channels.keys() ?? [])]).toEqual([]);
    });
  });

  describe('teardown stops the producer before its consumer', () => {
    it('on the test path', () => {
      resetIpcHandlers();

      expect(teardownOrder).toEqual(['bridge', 'scheduler']);
    });

    it('on the quit path', () => {
      for (const hook of shutdownHooks) hook();

      expect(teardownOrder.indexOf('bridge')).toBeGreaterThanOrEqual(0);
      expect(teardownOrder.indexOf('bridge')).toBeLessThan(
        teardownOrder.indexOf('scheduler'),
      );
    });

    it('drops the reference, so a next registration builds its own', () => {
      resetIpcHandlers();
      teardownOrder.length = 0;
      resetIpcHandlers();

      expect(teardownOrder).toEqual([]);
    });
  });
});
