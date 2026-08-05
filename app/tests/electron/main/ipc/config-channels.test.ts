// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Story 103's config channels.
 *
 * Mocked the way `clone-channels.test.ts` mocks electron, and for the same
 * reason: `ipc/index.ts` imports it at module scope, so the mock has to be
 * installed before the dynamic import below. `ipcMain.handle` records every
 * registration, which is how a test reaches a handler that is otherwise only
 * callable by Electron.
 *
 * The config module is mocked here — unlike in `clone-channels.test.ts` —
 * because what is under test is the *seam*: that the guard runs before the verb
 * and that whatever the verb returns is what the channel answers with. The
 * verbs' own behaviour is covered against a real filesystem in
 * `tests/electron/main/config/index.test.ts`.
 */
const handlers = new Map<
  string,
  (event: unknown, payload: unknown) => unknown
>();

const shutdownHooks: (() => void)[] = [];

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', on: vi.fn(), getPath: () => '/tmp/hive-test' },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
  dialog: { showOpenDialog: vi.fn() },
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
  onShutdown: (hook: () => void) => shutdownHooks.push(hook),
}));

/** The one object every mocked verb answers with, so identity is assertable. */
const snapshot = {
  configPath: '/tmp/config.json',
  templateWritten: false,
  shell: '/bin/zsh',
  claudeCommand: 'claude',
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

const { CH } = await import('../../../../electron/shared/ipc-contract');
const config = await import('../../../../electron/main/config/index');
const { registerIpcHandlers, resetIpcHandlers } = await import(
  '../../../../electron/main/ipc'
);

/**
 * `assertSender` compares `senderFrame` to `sender.mainFrame` by **identity**,
 * so a trusted event has to share one object rather than two equal literals.
 */
const mainFrame = { url: 'file:///out/renderer/index.html' };
const trustedEvent = { senderFrame: mainFrame, sender: { mainFrame } } as never;
const untrustedEvent = {
  senderFrame: { url: 'https://evil.example/' },
  sender: { mainFrame },
} as never;

const invoke = (channel: string, event: unknown, payload: unknown) =>
  Promise.resolve().then(() => handlers.get(channel)!(event, payload));

beforeEach(() => {
  handlers.clear();
  shutdownHooks.length = 0;
  vi.clearAllMocks();
  registerIpcHandlers();
});

afterEach(() => {
  resetIpcHandlers();
});

describe('story 103 config channels', () => {
  it('registers rename, re-point and reorder as invoke handlers', () => {
    expect(handlers.has(CH.configRenameProject)).toBe(true);
    expect(handlers.has(CH.configRepointProject)).toBe(true);
    expect(handlers.has(CH.configReorderProjects)).toBe(true);
  });

  it.each([
    ['rename', 'configRenameProject' as const, { id: 'a', name: 'A' }],
    ['re-point', 'configRepointProject' as const, { id: 'a', path: '/tmp' }],
    ['reorder', 'configReorderProjects' as const, { ids: ['a'] }],
  ])('rejects a %s from a sender that is not the main frame', async (
    _label,
    channel,
    payload,
  ) => {
    await expect(invoke(CH[channel], untrustedEvent, payload)).rejects.toThrow();
  });

  it('guards the payload before the verb ever sees it', async () => {
    await expect(
      invoke(CH.configRenameProject, trustedEvent, {
        id: 'a',
        name: 'b',
        extra: 1,
      }),
    ).rejects.toThrow(/unexpected key/);
    expect(config.renameProject).not.toHaveBeenCalled();
  });

  it('passes the parsed rename through and answers with the snapshot', async () => {
    const result = await invoke(CH.configRenameProject, trustedEvent, {
      id: 'a',
      name: '  Trimmed  ',
    });

    // Trimmed by the guard, so main and the renderer agree about what is blank.
    expect(config.renameProject).toHaveBeenCalledWith({
      id: 'a',
      name: 'Trimmed',
    });
    expect(result).toBe(snapshot);
  });

  it('passes the parsed re-point through and answers with the snapshot', async () => {
    const result = await invoke(CH.configRepointProject, trustedEvent, {
      id: 'a',
      path: '~/moved',
    });

    expect(config.repointProject).toHaveBeenCalledWith({
      id: 'a',
      path: '~/moved',
    });
    expect(result).toBe(snapshot);
  });

  it('passes the parsed reorder through and answers with the snapshot', async () => {
    const result = await invoke(CH.configReorderProjects, trustedEvent, {
      ids: ['a', 'b'],
    });

    expect(config.reorderProjects).toHaveBeenCalledWith({ ids: ['a', 'b'] });
    expect(result).toBe(snapshot);
  });

  it('refuses a reorder carrying a duplicate id', async () => {
    await expect(
      invoke(CH.configReorderProjects, trustedEvent, { ids: ['a', 'a'] }),
    ).rejects.toThrow(/duplicate id/);
    expect(config.reorderProjects).not.toHaveBeenCalled();
  });

  it('refuses a re-point that tries to name a second path', async () => {
    await expect(
      invoke(CH.configRepointProject, trustedEvent, {
        id: 'a',
        path: '/tmp',
        to: '/etc',
      }),
    ).rejects.toThrow(/unexpected key/);
    expect(config.repointProject).not.toHaveBeenCalled();
  });
});
