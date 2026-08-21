// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The clone channels' security posture (story 102).
 *
 * Mocked the way `tests/electron/main/ipc-security.test.ts` mocks electron, and
 * for the same reason: `ipc/index.ts` imports it at module scope, so the mock
 * has to be installed before the dynamic import below. `ipcMain.handle` records
 * every registration, which is how a test reaches a handler that is otherwise
 * only callable by Electron.
 */
const handlers = new Map<
  string,
  (event: unknown, payload: unknown) => unknown
>();

const shutdownHooks: (() => void)[] = [];

vi.mock('electron', () => ({
  app: {
    getVersion: () => '0.0.0',
    on: vi.fn(),
    // HIVE-81 review: `registerIpcHandlers` now wires app-level window focus
    // events, and `resetIpcHandlers` takes them off again.
    removeListener: vi.fn(),
    getPath: () => '/tmp/hive-test',
  },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
  dialog: { showOpenDialog: vi.fn() },
  /**
   * HIVE-67. `ipc/index.ts` builds the Jira integration at registration time
   * and hands it `safeStorage`, so the mock has to answer for it. Encryption
   * reports as unavailable, which is the state that stores nothing — a test of
   * the config channels must not write a credential file.
   */
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

/** The host is never started for real; nothing here spawns a process. */
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

const { CH } = await import('../../../../electron/shared/ipc-contract');
const { registerIpcHandlers, resetIpcHandlers } = await import(
  '../../../../electron/main/ipc'
);

/**
 * `assertSender` compares `senderFrame` to `sender.mainFrame` by **identity**,
 * so a trusted event has to share one object rather than two equal literals.
 */
const mainFrame = { url: 'file:///out/renderer/index.html' };

/** An event whose sending frame is the app's own main frame. */
const trustedEvent = { senderFrame: mainFrame, sender: { mainFrame } } as never;

/** A subframe — any frame in the process could otherwise invoke. */
const untrustedEvent = {
  senderFrame: { url: 'https://evil.example/' },
  sender: { mainFrame },
} as never;

const VALID = {
  url: 'https://github.com/behiques/the-hive.git',
  parentPath: '/tmp',
  cols: 80,
  rows: 24,
};

const invoke = (channel: string, event: unknown, payload: unknown) =>
  Promise.resolve().then(() => handlers.get(channel)!(event, payload));

beforeEach(() => {
  handlers.clear();
  shutdownHooks.length = 0;
  registerIpcHandlers();
});

afterEach(() => {
  resetIpcHandlers();
});

describe('clone channels', () => {
  it('registers both clone verbs', () => {
    expect(handlers.has(CH.configCloneStart)).toBe(true);
    expect(handlers.has(CH.configCloneCancel)).toBe(true);
  });

  it('rejects a sender that is not the main frame', async () => {
    await expect(
      invoke(CH.configCloneStart, untrustedEvent, VALID),
    ).rejects.toThrow();
  });

  it('rejects a sender that is not the main frame on cancel too', async () => {
    await expect(
      invoke(CH.configCloneCancel, untrustedEvent, undefined),
    ).rejects.toThrow();
  });

  /**
   * The assertion that keeps the epic's rule true end to end: a renderer that
   * tried to name where the clone should land is refused at the boundary.
   */
  it('rejects a payload carrying a destination key', async () => {
    await expect(
      invoke(CH.configCloneStart, trustedEvent, {
        ...VALID,
        destination: '/etc',
      }),
    ).rejects.toThrow();
  });

  it('rejects a malformed payload', async () => {
    await expect(
      invoke(CH.configCloneStart, trustedEvent, { url: 42 }),
    ).rejects.toThrow();
  });

  /**
   * A mistyped URL is something the user fixes in a text field, not an
   * exception the renderer has to catch — so it comes back as a value.
   */
  it('returns a refusal for an unusable URL rather than throwing', async () => {
    await expect(
      invoke(CH.configCloneStart, trustedEvent, {
        ...VALID,
        url: 'http://github.com/behiques/the-hive.git',
      }),
    ).resolves.toMatchObject({ ok: false });
  });

  it('cancel is safe when no clone is running', async () => {
    await expect(
      invoke(CH.configCloneCancel, trustedEvent, undefined),
    ).resolves.toBeUndefined();
  });

  it('disposes the clone flow on shutdown', () => {
    expect(shutdownHooks.length).toBeGreaterThan(0);
    // A clone in flight would be killed and cleaned up here; with none running
    // this proves only that the hook exists and is safe to run.
    expect(() => {
      for (const hook of shutdownHooks) hook();
    }).not.toThrow();
  });
});
