// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `ui:foreground` (HIVE-81) — main records the id and computes the predicate;
 * nothing consumes it yet.
 *
 * Mocked the way `config-channels.test.ts` mocks electron, and for the same
 * reason: `ipc/index.ts` imports it at module scope, so the mock has to be
 * installed before the dynamic import below. `ipcMain.on` records every
 * registration instead of `.handle`, because `CH.uiForeground` is a `send`
 * channel — a report, not a question.
 *
 * `windows` is a mutable array the tests reassign to simulate the window
 * gaining and losing OS focus; `windowFocused()` in `ipc/index.ts` reads it
 * fresh on every call via `BrowserWindow.getAllWindows()`.
 */
type OnHandler = (event: unknown, payload: unknown) => void;

const onHandlers = new Map<string, OnHandler>();
const shutdownHooks: (() => void)[] = [];

let windows: { isDestroyed: () => boolean; isFocused: () => boolean }[] = [];

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', on: vi.fn(), getPath: () => '/tmp/hive-test' },
  BrowserWindow: {
    fromWebContents: () => null,
    getAllWindows: () => windows,
  },
  dialog: { showOpenDialog: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => '',
  },
  ipcMain: {
    handle: vi.fn(),
    on: (channel: string, fn: OnHandler) => {
      onHandlers.set(channel, fn);
    },
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

/**
 * The real `isForeground` composition (HIVE-81) — `action.type === 'session'
 * && isForeground(action.entityId)` in `ipc/index.ts` — is the one line that
 * makes "non-session kinds are never gated" true in the shipped app. Asserting
 * it by inspection is not enough, so this mocks the hub *factory* rather than
 * the hub itself: `registerIpcHandlers` still runs for real, still resolves
 * the real `isForeground` from module scope, still composes the real
 * predicate — this only intercepts the options object handed to
 * `createNotificationHub` so the predicate can be called directly.
 */
let capturedIsForeground:
  | ((action: import('../../../../electron/shared/notification-contract').NotificationAction) => boolean)
  | undefined;

const fakeHub = {
  list: () => [],
  markRead: () => {},
  dismiss: () => {},
  raise: () => null,
  activate: () => {},
  clear: () => {},
};

vi.mock('../../../../electron/main/notifications', () => ({
  createNotificationHub: (options: {
    isForeground?: (
      action: import('../../../../electron/shared/notification-contract').NotificationAction,
    ) => boolean;
  }) => {
    capturedIsForeground = options.isForeground;
    return fakeHub;
  },
  createNotifier: () => ({ observe: vi.fn() }),
}));

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
const { registerIpcHandlers, resetIpcHandlers, isForeground } = await import(
  '../../../../electron/main/ipc'
);

/**
 * `assertSender` compares `senderFrame` to `sender.mainFrame` by **identity**,
 * so a trusted event has to share one object rather than two equal literals.
 */
const mainFrame = { url: 'file:///out/renderer/index.html' };
const trustedEvent = { senderFrame: mainFrame, sender: { mainFrame } } as never;

/** A window that has, or has not, OS focus right now. */
const fakeWindow = (focused: boolean) => ({
  isDestroyed: () => false,
  isFocused: () => focused,
});

const report = (payload: unknown) => {
  onHandlers.get(CH.uiForeground)!(trustedEvent, payload);
};

beforeEach(() => {
  onHandlers.clear();
  shutdownHooks.length = 0;
  windows = [fakeWindow(true)];
  vi.clearAllMocks();
  registerIpcHandlers();
});

afterEach(() => {
  resetIpcHandlers();
});

describe('ui:foreground', () => {
  it('registers as a send (`on`) channel, not invoke', () => {
    expect(onHandlers.has(CH.uiForeground)).toBe(true);
  });

  it('records a reported terminal id', () => {
    report({ terminalId: 'term-1' });

    expect(isForeground('term-1')).toBe(true);
  });

  it('rejects a payload with an extra key', () => {
    report({ terminalId: 'term-1', extra: 1 });

    // The guard throws inside `on()`'s wrapper, which logs and drops rather
    // than surfacing — so the assertion is on the state the rejected payload
    // failed to change, not on a thrown error.
    expect(isForeground('term-1')).toBe(false);
  });

  it('rejects a non-string, non-null terminalId', () => {
    report({ terminalId: 42 });

    expect(isForeground('42')).toBe(false);
    expect(isForeground('term-1')).toBe(false);
  });

  it('is not foreground while the window is blurred', () => {
    windows = [fakeWindow(false)];

    report({ terminalId: 'term-1' });

    expect(isForeground('term-1')).toBe(false);
  });

  it('is not foreground for a different terminal id', () => {
    report({ terminalId: 'term-1' });

    expect(isForeground('term-2')).toBe(false);
  });

  it('treats a null report as nothing on stage', () => {
    report({ terminalId: 'term-1' });
    report({ terminalId: null });

    expect(isForeground('term-1')).toBe(false);
  });

  it('notifies foreground listeners when the reported id changes', async () => {
    const { onForegroundChange } = await import('../../../../electron/main/ipc');
    const listener = vi.fn();
    onForegroundChange(listener);

    report({ terminalId: 'term-1' });

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not notify when the report repeats the current id', async () => {
    const { onForegroundChange } = await import('../../../../electron/main/ipc');
    report({ terminalId: 'term-1' });
    const listener = vi.fn();
    onForegroundChange(listener);

    report({ terminalId: 'term-1' });

    expect(listener).not.toHaveBeenCalled();
  });

  it('leaves the recorded id unchanged on a malformed payload, and fires no listener', async () => {
    const { onForegroundChange } = await import('../../../../electron/main/ipc');
    report({ terminalId: 'term-1' });
    const listener = vi.fn();
    onForegroundChange(listener);

    report({ terminalId: 42 });
    report('not an object');
    report({ wrong: 'key' });

    expect(isForeground('term-1')).toBe(true);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('the isForeground predicate composed for the notification hub (HIVE-81)', () => {
  const session = (entityId: string) => ({ type: 'session' as const, entityId });

  it('is true for a session action naming the reported terminal while focused', () => {
    report({ terminalId: 'term-1' });

    expect(capturedIsForeground?.(session('term-1'))).toBe(true);
  });

  it('is false while the window is blurred', () => {
    windows = [fakeWindow(false)];
    report({ terminalId: 'term-1' });

    expect(capturedIsForeground?.(session('term-1'))).toBe(false);
  });

  it('is false for a session action naming a different terminal', () => {
    report({ terminalId: 'term-1' });

    expect(capturedIsForeground?.(session('term-2'))).toBe(false);
  });

  it('is false for a non-session action, even while a session is foreground', () => {
    report({ terminalId: 'term-1' });

    expect(capturedIsForeground?.({ type: 'url', url: 'https://example.test' })).toBe(false);
    expect(capturedIsForeground?.({ type: 'none' })).toBe(false);
  });
});
