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
 * `tests/electron/main/integrations/slack/`. What belongs here is the seam —
 * that each of the four channels calls the right function, that the resolver
 * it passes as `claude` is the same one the agents composition reads
 * (`getConfig().claudeCommand`, live on every call), that the `run` it passes
 * is the real `runCommand` from `gh.ts` and not a second implementation, and
 * that a payload arriving on any of the four verbs is inert — there is no
 * validator to throw `IpcValidationError`; the handler signature simply does
 * not declare a `payload` parameter, so nothing sent from the renderer can
 * ever reach the call.
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
 */
const snapshot = {
  configPath: '/tmp/config.json',
  templateWritten: false,
  shell: '/bin/zsh',
  claudeCommand: '/opt/hive-test/claude',
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

const readSlackStatus = vi.fn<(claude: string, run: unknown) => SlackStatus>(
  () => ({ kind: 'connected' }),
);
const signInToSlack = vi.fn<(claude: string, run: unknown) => SlackStatus>(
  () => ({ kind: 'connected' }),
);
const signOutOfSlack = vi.fn<(claude: string, run: unknown) => SlackStatus>(
  () => ({ kind: 'not-added' }),
);
const probeSlack = vi.fn<(claude: string, run: unknown) => SlackStatus>(
  () => ({ kind: 'connected' }),
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
    readSlackStatus.mockReturnValueOnce({ kind: 'connected' });

    await expect(call(CH.slackStatus)).resolves.toEqual({ kind: 'connected' });
    expect(readSlackStatus).toHaveBeenCalledOnce();
  });

  it('passes the live claudeCommand and the real runCommand to slack:status', async () => {
    await call(CH.slackStatus);

    expect(readSlackStatus).toHaveBeenCalledWith(snapshot.claudeCommand, runCommand);
  });

  it('routes slack:sign-in to signInToSlack with the same resolver', async () => {
    signInToSlack.mockReturnValueOnce({ kind: 'needs-auth' });

    await expect(call(CH.slackSignIn)).resolves.toEqual({ kind: 'needs-auth' });
    expect(signInToSlack).toHaveBeenCalledWith(snapshot.claudeCommand, runCommand);
  });

  it('routes slack:sign-out to signOutOfSlack with the same resolver', async () => {
    signOutOfSlack.mockReturnValueOnce({ kind: 'not-added' });

    await expect(call(CH.slackSignOut)).resolves.toEqual({ kind: 'not-added' });
    expect(signOutOfSlack).toHaveBeenCalledWith(snapshot.claudeCommand, runCommand);
  });

  it('routes slack:test to probeSlack with the same resolver', async () => {
    probeSlack.mockReturnValueOnce({ kind: 'pending-approval' });

    await expect(call(CH.slackTest)).resolves.toEqual({ kind: 'pending-approval' });
    expect(probeSlack).toHaveBeenCalledWith(snapshot.claudeCommand, runCommand);
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

    expect(readSlackStatus).toHaveBeenCalledWith(snapshot.claudeCommand, runCommand);
    expect(signInToSlack).toHaveBeenCalledWith(snapshot.claudeCommand, runCommand);
    expect(signOutOfSlack).toHaveBeenCalledWith(snapshot.claudeCommand, runCommand);
    expect(probeSlack).toHaveBeenCalledWith(snapshot.claudeCommand, runCommand);

    // Exactly two arguments each — nothing from the smuggled payload arrived.
    for (const mock of [readSlackStatus, signInToSlack, signOutOfSlack, probeSlack]) {
      expect(mock.mock.calls[0]).toHaveLength(2);
    }
  });
});
