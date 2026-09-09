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

beforeEach(() => {
  sent.length = 0;
  presenter = undefined;
  windows = [fakeWindow()];
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
