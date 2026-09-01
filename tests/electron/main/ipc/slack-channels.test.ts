// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SlackStatus } from '../../../../electron/shared/slack-contract';

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
    getPath: () => '/tmp/hive-test',
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

vi.mock('../../../../electron/main/shutdown', () => ({
  onShutdown: vi.fn(),
}));

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
 */
const snapshot = {
  configPath: '/tmp/config.json',
  templateWritten: false,
  shell: '/bin/zsh',
  claudeCommand: process.execPath,
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
