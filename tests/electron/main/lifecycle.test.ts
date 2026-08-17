// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lifecycle behaviour, with `electron` mocked (story 081).
 *
 * The mock records every `app.on` handler so a test can fire the platform
 * events directly. Asserting `window-all-closed` through a real Electron boot
 * would mean launching an app per platform, which Playwright cannot do either
 * — the host OS is the host OS.
 */

type Handler = (...args: unknown[]) => void;

const handlers = new Map<string, Handler[]>();
const appMock = {
  on: vi.fn((event: string, handler: Handler) => {
    handlers.set(event, [...(handlers.get(event) ?? []), handler]);
  }),
  whenReady: vi.fn(() => Promise.resolve()),
  quit: vi.fn(),
  getName: vi.fn(() => 'The Hive'),
  requestSingleInstanceLock: vi.fn(() => true),
};

const windows: {
  isMinimized: () => boolean;
  restore: () => void;
  focus: () => void;
  /** Real `BrowserWindow`s have this; `aux-windows` filters destroyed ones. */
  isDestroyed: () => boolean;
}[] =
  [];

vi.mock('electron', () => ({
  app: appMock,
  BrowserWindow: { getAllWindows: () => windows },
  Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn((t) => t) },
}));

const { registerLifecycle, resetQuitting } = await import(
  '../../../electron/main/lifecycle'
);
const { onShutdown, resetShutdownHooks } = await import(
  '../../../electron/main/shutdown'
);

/** Fire every handler registered for an event. */
const fire = async (event: string, ...args: unknown[]) => {
  for (const handler of handlers.get(event) ?? []) await handler(...args);
};

/**
 * Register, then let `whenReady().then(...)` settle and forget the startup
 * window it opens.
 *
 * Without this every assertion about `createWindow` would also be counting the
 * one the app makes on boot, and "did `activate` open a window?" would be
 * indistinguishable from "did startup?".
 */
async function register(
  deps: Parameters<typeof registerLifecycle>[0],
): Promise<void> {
  registerLifecycle(deps);
  await vi.waitFor(() => expect(deps.createWindow).toHaveBeenCalled());
  vi.mocked(deps.createWindow).mockClear();
}

beforeEach(() => {
  handlers.clear();
  windows.length = 0;
  resetQuitting();
  resetShutdownHooks();
  vi.clearAllMocks();
});

describe('window-all-closed', () => {
  it('quits on Windows', async () => {
    await register({ createWindow: vi.fn(), platform: 'win32' });
    await fire('window-all-closed');

    expect(appMock.quit).toHaveBeenCalled();
  });

  it('quits on Linux', async () => {
    await register({ createWindow: vi.fn(), platform: 'linux' });
    await fire('window-all-closed');

    expect(appMock.quit).toHaveBeenCalled();
  });

  it('does NOT quit on macOS — the app stays alive with no windows', async () => {
    await register({ createWindow: vi.fn(), platform: 'darwin' });
    await fire('window-all-closed');

    expect(appMock.quit).not.toHaveBeenCalled();
  });
});

describe('activate', () => {
  it('re-creates a window when the dock icon is clicked with none open', async () => {
    const createWindow = vi.fn();
    await register({ createWindow, platform: 'darwin' });

    await fire('activate');

    expect(createWindow).toHaveBeenCalledTimes(1);
  });

  it('does nothing when a window is already open', async () => {
    const createWindow = vi.fn();
    windows.push({
      isMinimized: () => false,
      restore: vi.fn(),
      focus: vi.fn(),
      isDestroyed: () => false,
    });
    await register({ createWindow, platform: 'darwin' });

    await fire('activate');

    expect(createWindow).not.toHaveBeenCalled();
  });
});

describe('second-instance', () => {
  it('focuses the existing window rather than creating another', async () => {
    // The guard against two agents editing the same working tree (story 092).
    const focus = vi.fn();
    const restore = vi.fn();
    const createWindow = vi.fn();
    windows.push({ isMinimized: () => false, restore, focus, isDestroyed: () => false });
    await register({ createWindow, platform: 'darwin' });

    await fire('second-instance');

    expect(focus).toHaveBeenCalledTimes(1);
    expect(createWindow).not.toHaveBeenCalled();
  });

  it('restores a minimized window before focusing it', async () => {
    const focus = vi.fn();
    const restore = vi.fn();
    windows.push({ isMinimized: () => true, restore, focus, isDestroyed: () => false });
    await register({ createWindow: vi.fn(), platform: 'darwin' });

    await fire('second-instance');

    expect(restore).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('does not throw when no window exists', async () => {
    await register({ createWindow: vi.fn(), platform: 'darwin' });

    await expect(fire('second-instance')).resolves.not.toThrow();
  });
});

describe('before-quit', () => {
  it('awaits every registered shutdown hook before quitting', async () => {
    const order: string[] = [];
    let releaseSlowHook!: () => void;
    const slowHook = new Promise<void>((resolve) => {
      releaseSlowHook = resolve;
    });

    onShutdown(async () => {
      await slowHook;
      order.push('hook');
    });

    await register({ createWindow: vi.fn(), platform: 'darwin' });
    const event = { preventDefault: vi.fn() };

    await fire('before-quit', event);

    // The first quit is cancelled: teardown is still running.
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(appMock.quit).not.toHaveBeenCalled();

    releaseSlowHook();
    await vi.waitFor(() => expect(appMock.quit).toHaveBeenCalled());

    order.push('quit');
    expect(order).toEqual(['hook', 'quit']);
  });

  it('quits even when a hook rejects — a failed teardown must not wedge the app', async () => {
    onShutdown(() => Promise.reject(new Error('pty refused to die')));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await register({ createWindow: vi.fn(), platform: 'darwin' });
    await fire('before-quit', { preventDefault: vi.fn() });

    await vi.waitFor(() => expect(appMock.quit).toHaveBeenCalled());
  });

  it('passes the second quit straight through instead of looping', async () => {
    await register({ createWindow: vi.fn(), platform: 'darwin' });

    const first = { preventDefault: vi.fn() };
    await fire('before-quit', first);
    await vi.waitFor(() => expect(appMock.quit).toHaveBeenCalled());

    const second = { preventDefault: vi.fn() };
    await fire('before-quit', second);

    // Re-entry must NOT cancel the quit, or the app can never exit.
    expect(second.preventDefault).not.toHaveBeenCalled();
  });
});

describe('menu installation', () => {
  it('installs the application menu on macOS, where Cmd+C depends on it', async () => {
    const { Menu } = await import('electron');
    await register({ createWindow: vi.fn(), platform: 'darwin' });
    await appMock.whenReady();
    await vi.waitFor(() => expect(Menu.setApplicationMenu).toHaveBeenCalled());
  });
});
