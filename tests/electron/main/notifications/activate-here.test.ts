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

const openExternal = vi.fn();
const downloadUpdate = vi.fn();
const installUpdate = vi.fn();

let windows: {
  isDestroyed: () => boolean;
  isMinimized: () => boolean;
  restore: () => void;
  focus: () => void;
}[] = [];

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => windows },
  shell: { openExternal: (...args: unknown[]) => openExternal(...args) },
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
});
