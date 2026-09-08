import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The one place a main → renderer push leaves this process (HIVE-141).
 *
 * There is nothing clever here to test, which is the point: the value of
 * extracting the loop is that there is now exactly one of it, and the assertions
 * below are about the two properties the five call sites it replaced each had to
 * remember on their own — every live window is written to, and a destroyed one
 * is skipped.
 */

const getAllWindows = vi.fn();

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows } }));

const { createWindowBroadcaster } = await import(
  '../../../../electron/main/ipc/broadcaster'
);

const fakeWindow = (destroyed = false) => ({
  isDestroyed: () => destroyed,
  webContents: { send: vi.fn() },
});

beforeEach(() => {
  getAllWindows.mockReset();
});

describe('createWindowBroadcaster', () => {
  it('writes the channel and payload to every live window', () => {
    const first = fakeWindow();
    const second = fakeWindow();
    getAllWindows.mockReturnValue([first, second]);

    createWindowBroadcaster().emit('pty:data', { seq: 1 });

    expect(first.webContents.send).toHaveBeenCalledWith('pty:data', { seq: 1 });
    expect(second.webContents.send).toHaveBeenCalledWith('pty:data', { seq: 1 });
  });

  it('skips a destroyed window rather than throwing on it', () => {
    const dead = fakeWindow(true);
    const live = fakeWindow();
    getAllWindows.mockReturnValue([dead, live]);

    expect(() => createWindowBroadcaster().emit('ledger:changed', null)).not.toThrow();

    expect(dead.webContents.send).not.toHaveBeenCalled();
    expect(live.webContents.send).toHaveBeenCalledTimes(1);
  });

  /**
   * The reason the closure this replaces resolved windows per send rather than
   * capturing them: on macOS the window is created after registration and can be
   * closed and re-created while the app keeps running. A broadcaster that read
   * the list once would go deaf after the first close.
   */
  it('resolves the window list per emit, not once at construction', () => {
    getAllWindows.mockReturnValue([]);
    const broadcaster = createWindowBroadcaster();

    broadcaster.emit('agents:changed', undefined);
    expect(getAllWindows).toHaveBeenCalledTimes(1);

    const late = fakeWindow();
    getAllWindows.mockReturnValue([late]);
    broadcaster.emit('agents:changed', undefined);

    expect(late.webContents.send).toHaveBeenCalledWith('agents:changed', undefined);
  });

  it('emits nothing and does not throw when no window is open', () => {
    getAllWindows.mockReturnValue([]);

    expect(() => createWindowBroadcaster().emit('session:ready', {})).not.toThrow();
  });
});
