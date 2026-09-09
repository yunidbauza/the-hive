// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The client's own focus, stamped onto `ui:foreground` (HIVE-145).
 *
 * The server cannot answer "is the person looking at this" for a machine it
 * has no windows on, so the attached client answers it for itself. What is
 * under test is that the answer is read *live* from `BrowserWindow` rather
 * than remembered, that a focus change re-sends without a stage change, and
 * that a malformed payload is forwarded untouched so the server's own guard
 * still gets to reject it.
 */

const appListeners = new Map<string, Set<() => void>>();
let windows: { isDestroyed: () => boolean; isFocused: () => boolean }[] = [];

vi.mock('electron', () => ({
  app: {
    on: (event: string, listener: () => void) => {
      const existing = appListeners.get(event) ?? new Set();
      existing.add(listener);
      appListeners.set(event, existing);
    },
    removeListener: (event: string, listener: () => void) => {
      appListeners.get(event)?.delete(listener);
    },
  },
  BrowserWindow: {
    getAllWindows: () => windows,
  },
}));

const { CH } = await import('../../../../electron/shared/ipc-contract');
const { createForegroundStamp } = await import(
  '../../../../electron/main/ipc/remote-foreground'
);

const fakeWindow = (focused: boolean) => ({
  isDestroyed: () => false,
  isFocused: () => focused,
});

/** Every listener the app-level focus events would drive. */
const fireFocusChange = (event: 'browser-window-focus' | 'browser-window-blur') => {
  for (const listener of appListeners.get(event) ?? []) listener();
};

let notify: ReturnType<typeof vi.fn<(channel: string, payload: unknown) => void>>;
let stamp: ReturnType<typeof createForegroundStamp>;

beforeEach(() => {
  appListeners.clear();
  windows = [fakeWindow(true)];
  vi.useFakeTimers();
  notify = vi.fn<(channel: string, payload: unknown) => void>();
  stamp = createForegroundStamp(notify);
});

afterEach(() => {
  stamp.dispose();
  vi.useRealTimers();
});

describe('createForegroundStamp', () => {
  it('adds this machine\'s focus to a well-formed report', () => {
    expect(stamp.stamp({ terminalId: 'term-1' })).toEqual({
      terminalId: 'term-1',
      focused: true,
    });
  });

  it('reports not focused when no window of ours has focus', () => {
    windows = [fakeWindow(false)];

    expect(stamp.stamp({ terminalId: 'term-1' })).toEqual({
      terminalId: 'term-1',
      focused: false,
    });
  });

  it('counts any window of ours, not the first', () => {
    windows = [fakeWindow(false), fakeWindow(true)];

    expect(stamp.stamp({ terminalId: 'term-1' })).toEqual({
      terminalId: 'term-1',
      focused: true,
    });
  });

  it('ignores a destroyed window still in the list', () => {
    windows = [{ isDestroyed: () => true, isFocused: () => true }];

    expect(stamp.stamp({ terminalId: 'term-1' })).toEqual({
      terminalId: 'term-1',
      focused: false,
    });
  });

  it('stamps a null terminalId, which means nothing is on stage', () => {
    expect(stamp.stamp({ terminalId: null })).toEqual({
      terminalId: null,
      focused: true,
    });
  });

  it('reads focus live rather than remembering the last answer', () => {
    stamp.stamp({ terminalId: 'term-1' });
    windows = [fakeWindow(false)];

    expect(stamp.stamp({ terminalId: 'term-1' })).toEqual({
      terminalId: 'term-1',
      focused: false,
    });
  });

  /**
   * The server rejects rather than sanitises, so a compromised or buggy
   * renderer cannot make a fabricated shape read as "nothing on stage".
   * Normalising here would launder a malformed payload straight past that.
   */
  describe('leaves a payload the server must reject untouched', () => {
    it('an extra key', () => {
      const payload = { terminalId: 'term-1', extra: 1 };
      expect(stamp.stamp(payload)).toBe(payload);
    });

    it('a non-string, non-null terminalId', () => {
      const payload = { terminalId: 42 };
      expect(stamp.stamp(payload)).toBe(payload);
    });

    it('no terminalId at all', () => {
      const payload = { focused: true };
      expect(stamp.stamp(payload)).toBe(payload);
    });

    it('not an object', () => {
      expect(stamp.stamp('nope')).toBe('nope');
      expect(stamp.stamp(null)).toBe(null);
    });
  });

  describe('a focus change with no stage change', () => {
    it('re-sends the last reported terminal', () => {
      stamp.stamp({ terminalId: 'term-1' });
      windows = [fakeWindow(false)];

      fireFocusChange('browser-window-blur');
      vi.advanceTimersByTime(1);

      expect(notify).toHaveBeenCalledExactlyOnceWith(CH.uiForeground, {
        terminalId: 'term-1',
        focused: false,
      });
    });

    it('sends nothing before the renderer has reported at all', () => {
      fireFocusChange('browser-window-focus');
      vi.advanceTimersByTime(1);

      expect(notify).not.toHaveBeenCalled();
    });

    /**
     * On macOS `blur` on the outgoing window fires before `focus` on the
     * incoming one, so a switch between two of our own windows passes through
     * a moment where none is focused. Sending synchronously there would tell
     * the server the user had walked away, and it would toast about a session
     * sitting in plain sight.
     */
    it('coalesces the burst of a window switch into one settled send', () => {
      stamp.stamp({ terminalId: 'term-1' });

      windows = [fakeWindow(false)];
      fireFocusChange('browser-window-blur');
      windows = [fakeWindow(true)];
      fireFocusChange('browser-window-focus');
      vi.advanceTimersByTime(1);

      expect(notify).toHaveBeenCalledExactlyOnceWith(CH.uiForeground, {
        terminalId: 'term-1',
        focused: true,
      });
    });

    it('stops re-sending once disposed', () => {
      stamp.stamp({ terminalId: 'term-1' });
      stamp.dispose();

      fireFocusChange('browser-window-blur');
      vi.advanceTimersByTime(1);

      expect(notify).not.toHaveBeenCalled();
    });

    it('drops a tick already scheduled when disposed', () => {
      stamp.stamp({ terminalId: 'term-1' });
      fireFocusChange('browser-window-blur');

      stamp.dispose();
      vi.advanceTimersByTime(1);

      expect(notify).not.toHaveBeenCalled();
    });
  });
});
