// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The half of a notification's activation that belongs to the machine whose
 * user clicked (HIVE-151).
 *
 * These three branches lived inside `activateNotification` in
 * `electron/main/ipc/index.ts`, where no test ever reached them — the existing
 * coverage exercised `ask` and `session` and asserted only that neither opened
 * anything external. They are also the three the remote proxy now answers
 * locally rather than forwarding, so what they do is worth pinning on its own.
 */

/*
  These three return promises because the real ones do, and because
  `activateOnThisMachine` now attaches a `.catch` to each: an unhandled
  rejection here would be an exception in main with nobody to catch it, which is
  fatal under Node 22's default. A `vi.fn()` returning `undefined` would make
  the module throw on `.catch` rather than exercise it.
*/
const openExternal = vi.fn(async (_url: string) => undefined);
const downloadUpdate = vi.fn(async () => undefined);
const installUpdate = vi.fn(async () => undefined);

let windows: {
  isDestroyed: () => boolean;
  isMinimized: () => boolean;
  restore: () => void;
  focus: () => void;
}[] = [];

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => windows },
  shell: { openExternal: (url: string) => openExternal(url) },
}));

vi.mock('../../../../electron/main/updates', () => ({
  downloadUpdate: () => downloadUpdate(),
  installUpdate: () => installUpdate(),
}));

const { activateOnThisMachine, focusThisMachine } = await import(
  '../../../../electron/main/notifications/activate-here'
);

const fakeWindow = (over: { minimized?: boolean; destroyed?: boolean } = {}) => {
  const restore = vi.fn();
  const focus = vi.fn();
  return {
    isDestroyed: () => over.destroyed === true,
    isMinimized: () => over.minimized === true,
    restore,
    focus,
    calls: { restore, focus },
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  windows = [];
});

describe('focusThisMachine', () => {
  /*
    The restore is not decoration: a minimised window that is merely focused
    does nothing visible, so a user who clicked a notification would see the
    click land nowhere at all.
  */
  it('restores a minimised window before focusing it', () => {
    const window = fakeWindow({ minimized: true });
    windows = [window];

    focusThisMachine();

    expect(window.calls.restore).toHaveBeenCalledTimes(1);
    expect(window.calls.focus).toHaveBeenCalledTimes(1);
  });

  it('focuses a window that is already restored without restoring it', () => {
    const window = fakeWindow();
    windows = [window];

    focusThisMachine();

    expect(window.calls.restore).not.toHaveBeenCalled();
    expect(window.calls.focus).toHaveBeenCalledTimes(1);
  });

  it('skips a destroyed window rather than throwing on it', () => {
    const dead = fakeWindow({ destroyed: true });
    const live = fakeWindow();
    windows = [dead, live];

    expect(() => focusThisMachine()).not.toThrow();
    expect(dead.calls.focus).not.toHaveBeenCalled();
    expect(live.calls.focus).toHaveBeenCalledTimes(1);
  });
});

describe('activateOnThisMachine', () => {
  it('focuses this machine before carrying the action out', () => {
    const window = fakeWindow({ minimized: true });
    windows = [window];

    activateOnThisMachine({ type: 'update.download' });

    expect(window.calls.restore).toHaveBeenCalledTimes(1);
    expect(window.calls.focus).toHaveBeenCalledTimes(1);
  });

  it('opens a safe url', () => {
    activateOnThisMachine({ type: 'url', url: 'https://example.com/x' });

    expect(openExternal).toHaveBeenCalledWith('https://example.com/x');
  });

  /*
    The allowlist is not optional politeness here. A notification's URL is data
    rather than a constant, and an unchecked `shell.openExternal` will launch a
    `file:` URL or a custom scheme some other installed application registered.
  */
  it.each(['file:///etc/passwd', 'javascript:alert(1)', 'not a url', ''])(
    'refuses %j rather than handing it to the OS',
    (url) => {
      activateOnThisMachine({ type: 'url', url });

      expect(openExternal).not.toHaveBeenCalled();
    },
  );

  it('reaches this process\'s own updater for update.download', () => {
    activateOnThisMachine({ type: 'update.download' });

    expect(downloadUpdate).toHaveBeenCalledTimes(1);
    expect(installUpdate).not.toHaveBeenCalled();
  });

  it('reaches this process\'s own updater for update.install', () => {
    activateOnThisMachine({ type: 'update.install' });

    expect(installUpdate).toHaveBeenCalledTimes(1);
    expect(downloadUpdate).not.toHaveBeenCalled();
  });

  it('opens nothing external for an update action', () => {
    activateOnThisMachine({ type: 'update.install' });

    expect(openExternal).not.toHaveBeenCalled();
  });

  /**
   * Every branch here is reachable from inside an Electron `click` listener
   * (`remote-toast.ts`), where an unhandled rejection is an exception in main
   * with nobody to catch it — fatal under Node 22's default
   * `--unhandled-rejections=throw`, as `updates/index.ts` says of its own.
   *
   * Asserted by driving a real rejection rather than by reading the source: a
   * missing `.catch` shows up here as an unhandled rejection the runner
   * reports, which is the failure mode being prevented.
   */
  describe('a rejection from the thing it called', () => {
    it.each([
      ['update.download', () => { downloadUpdate.mockRejectedValueOnce(new Error('no updater')); }, { type: 'update.download' as const }],
      ['update.install', () => { installUpdate.mockRejectedValueOnce(new Error('no updater')); }, { type: 'update.install' as const }],
      ['url', () => { openExternal.mockRejectedValueOnce(new Error('no handler')); }, { type: 'url' as const, url: 'https://example.com' }],
    ])('is caught for %s rather than left to reach main', async (_name, arrange, action) => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      arrange();

      expect(() => { activateOnThisMachine(action); }).not.toThrow();
      // Let the rejection settle; an uncaught one fails the run from here.
      await Promise.resolve();
      await Promise.resolve();

      expect(error).toHaveBeenCalled();
      error.mockRestore();
    });
  });
});
