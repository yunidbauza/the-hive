// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { emptySnapshot } from '../../../../electron/shared/config-contract';

/**
 * HIVE-75's cycle guard, which HIVE-141 turned from a structure into a
 * convention — so it needs a test now (review finding 8).
 *
 * The invariant: the notification hub's three pushes must reach every surface
 * **without** reaching `notifier.observe`. `send` taps the notifier and the
 * notifier produces into the hub, so a tapped notification push would feed the
 * hub's own output back into its input.
 *
 * Until HIVE-141 that was guaranteed by construction — those three sites called
 * `webContents.send` directly and had no path to `send` at all. They now share
 * the injected `Broadcaster` with `send`, so the guarantee is one careless edit
 * away, and the careless edit is an attractive one: teeing every push at the
 * socket is the obvious way to write HIVE-142's broadcaster. This test is what
 * makes that land as a red suite rather than as a feedback loop nobody sees.
 *
 * `createNotificationHub` is mocked at the factory so the presenter options
 * `registerIpcHandlers` builds can be captured and called directly. Everything
 * about the wiring under test — which function each presenter calls — stays
 * real.
 */
type OnHandler = (event: unknown, payload: unknown) => void;

const sent: { channel: string; payload: unknown }[] = [];
const observe = vi.fn();

let windows: { isDestroyed: () => boolean; webContents: { send: OnHandler } }[] = [];

const fakeWindow = () => ({
  isDestroyed: () => false,
  webContents: {
    send: (channel: unknown, payload: unknown) => {
      sent.push({ channel: channel as string, payload });
    },
  },
});

vi.mock('electron', () => ({
  app: {
    getVersion: () => '0.0.0',
    getPath: () => '/tmp/hive-test-notification-broadcast',
    on: vi.fn(),
    removeListener: vi.fn(),
    dock: { bounce: vi.fn(), setBadge: vi.fn() },
  },
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
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn(), removeAllListeners: vi.fn() },
  session: { defaultSession: { webRequest: { onHeadersReceived: vi.fn() } } },
  shell: { showItemInFolder: vi.fn(), openExternal: vi.fn() },
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
    onForeground: () => () => {},
    shutdown: async () => {},
    isRunning: () => true,
    isBlocked: () => false,
    sessionIds: () => [],
  }),
}));

vi.mock('../../../../electron/main/shutdown', () => ({ onShutdown: vi.fn() }));

/** The presenter options `registerIpcHandlers` hands to the hub factory. */
interface Presenter {
  broadcast: (notification: unknown) => void;
  announceRead: (id: string, unread: number) => void;
  announceDismissed: (id: string) => void;
  announceUnread: (count: number) => void;
}

let presenter: Presenter | undefined;

vi.mock('../../../../electron/main/notifications', async () => {
  const actual = await vi.importActual<
    typeof import('../../../../electron/main/notifications')
  >('../../../../electron/main/notifications');

  return {
    createNotificationHub: (options: Presenter) => {
      presenter = options;
      return {
        list: () => [],
        markRead: () => {},
        dismiss: () => {},
        raise: () => null,
        activate: () => {},
        clear: () => {},
      };
    },
    createNotifier: () => ({ observe, reevaluateForeground: vi.fn() }),
    createSessionNames: actual.createSessionNames,
    /*
      The real router and queue (HIVE-145). This suite fakes the *hub*, to
      capture the options it is handed, and has no reason to fake what the hub
      is handed *to* — the router is what turns a toast into a targeted push,
      which is the thing a broadcast test should be watching happen rather than
      standing in for.
    */
    createToastRoute: actual.createToastRoute,
    createToastQueue: actual.createToastQueue,
  };
});

const snapshot = emptySnapshot('/tmp/config.json', '/bin/zsh');

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
const { registerIpcHandlers, resetIpcHandlers } = await import(
  '../../../../electron/main/ipc'
);
const { app } = await import('electron');
const { resetServerModeForTest, setServerMode } = await import(
  '../../../../electron/main/server-mode'
);

beforeEach(() => {
  sent.length = 0;
  presenter = undefined;
  windows = [fakeWindow()];
  resetServerModeForTest();
  vi.clearAllMocks();
  resetIpcHandlers();
  registerIpcHandlers();
});

describe('the notification hub’s presenters (HIVE-75)', () => {
  it('is wired at all — the fixture captured the presenter', () => {
    expect(presenter).toBeDefined();
  });

  it('reaches every surface with a raised notification', () => {
    presenter!.broadcast({ id: 'n1' });

    expect(sent).toEqual([{ channel: CH.notificationsNew, payload: { id: 'n1' } }]);
  });

  it('reaches every surface with a read announcement', () => {
    presenter!.announceRead('n1', 3);

    expect(sent).toEqual([
      { channel: CH.notificationsRead, payload: { id: 'n1', unread: 3 } },
    ]);
  });

  it('reaches every surface with a dismissal', () => {
    presenter!.announceDismissed('n1');

    expect(sent).toEqual([
      { channel: CH.notificationsDismissed, payload: { id: 'n1' } },
    ]);
  });

  /**
   * The assertion this file exists for. If a future broadcaster taps the
   * notifier — or if these three are ever "tidied up" to go through `send` —
   * this is what fails.
   */
  it('never taps the notifier, or the hub would feed its own output back in', () => {
    presenter!.broadcast({ id: 'n1' });
    presenter!.announceRead('n1', 0);
    presenter!.announceDismissed('n1');

    expect(observe).not.toHaveBeenCalled();
  });

  it('still delivers to a second surface when one is destroyed mid-fleet', () => {
    const live = fakeWindow();
    windows = [{ ...fakeWindow(), isDestroyed: () => true }, live];

    presenter!.broadcast({ id: 'n1' });

    expect(sent).toHaveLength(1);
  });
});

/**
 * Whose dock the hub's count lands on (HIVE-159).
 *
 * The count is the fleet's, but the badge is a fact about one screen. A
 * standalone app is its own screen and badges exactly as it always did. A
 * serving machine answers for attached clients, each of which badges its own
 * dock from its own renderer, so the server's hub writing the same number onto
 * the server's dock was a count shown on behalf of somebody else.
 */
describe('the hub’s unread count on the dock (HIVE-159)', () => {
  // The outer `beforeEach` tears down before registering, and that teardown
  // clears the badge — which would satisfy or fail these cases on its own.
  beforeEach(() => {
    vi.mocked(app.dock!.setBadge).mockClear();
  });

  it('badges this dock on a standalone app', () => {
    presenter!.announceUnread(3);

    expect(app.dock?.setBadge).toHaveBeenCalledWith('3');
  });

  it('does not badge the dock of a serving machine', () => {
    setServerMode(true);

    presenter!.announceUnread(3);

    expect(app.dock?.setBadge).not.toHaveBeenCalled();
  });

  /*
    A teardown is also a mode switch (`unbindEverything` calls it in both
    directions), and whichever mode comes next inherits a badge written by a
    writer that no longer exists: the hub it just disposed, or the renderer
    reports of an attachment that has ended.
  */
  it('clears the dock badge when the handlers are torn down', () => {
    resetIpcHandlers();

    expect(app.dock?.setBadge).toHaveBeenCalledWith('');
  });
});
