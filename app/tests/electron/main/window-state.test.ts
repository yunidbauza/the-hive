// @vitest-environment node
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  EMPTY_STATE,
  debounce,
  isRectVisible,
  readWindowState,
  resolveRect,
  writeWindowState,
} from '../../../electron/main/window-state';

/** A 1440×900 window sitting on a 1920×1080 primary display. */
const PRIMARY = { x: 0, y: 0, width: 1920, height: 1080 };
/** A second display to the right, as a laptop-plus-monitor setup reports it. */
const SECONDARY = { x: 1920, y: 0, width: 2560, height: 1440 };

const rect = (x: number, y: number, width = 1440, height = 900) => ({
  x,
  y,
  width,
  height,
});

describe('isRectVisible', () => {
  it('accepts a window fully inside a display', () => {
    expect(isRectVisible(rect(100, 100), [PRIMARY])).toBe(true);
  });

  it('accepts a window straddling two displays', () => {
    expect(isRectVisible(rect(1800, 100), [PRIMARY, SECONDARY])).toBe(true);
  });

  it('rejects a window on a display that is no longer attached', () => {
    // Saved on the secondary monitor; only the laptop screen is present now.
    expect(isRectVisible(rect(2200, 300), [PRIMARY])).toBe(false);
  });

  it('rejects a one-pixel sliver, which is indistinguishable from offscreen', () => {
    expect(isRectVisible(rect(1919, 0), [PRIMARY])).toBe(false);
  });

  it('rejects a window above the work area, where the title bar is unreachable', () => {
    expect(isRectVisible(rect(200, -880), [PRIMARY])).toBe(false);
  });
});

describe('resolveRect', () => {
  it('restores a rect that is still on a display', () => {
    const saved = rect(120, 80);
    expect(resolveRect(saved, [PRIMARY])).toEqual(saved);
  });

  it('falls back to centred defaults when the display is gone', () => {
    // The regression that otherwise looks exactly like a hang.
    expect(resolveRect(rect(2200, 300), [PRIMARY])).toBeNull();
  });

  it('falls back when there is nothing saved', () => {
    expect(resolveRect(null, [PRIMARY])).toBeNull();
  });

  it('falls back when the saved size is below the minimum', () => {
    expect(resolveRect(rect(0, 0, 400, 300), [PRIMARY])).toBeNull();
  });

  it('falls back when no display is attached at all', () => {
    expect(resolveRect(rect(0, 0), [])).toBeNull();
  });
});

describe('readWindowState', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-window-state-'));

  it('round-trips a written state', () => {
    const path = join(dir, 'ok.json');
    const state = { rect: rect(10, 20), maximized: true };

    expect(writeWindowState(path, state)).toBe(true);
    expect(readWindowState(path)).toEqual(state);
  });

  it('treats a missing file as no state', () => {
    expect(readWindowState(join(dir, 'nope.json'))).toEqual(EMPTY_STATE);
  });

  it('treats a corrupt file as no state rather than failing to launch', () => {
    const path = join(dir, 'corrupt.json');
    writeFileSync(path, '{ this is not json');

    expect(readWindowState(path)).toEqual(EMPTY_STATE);
  });

  it('discards a rect with non-numeric fields', () => {
    const path = join(dir, 'bad-rect.json');
    writeFileSync(path, JSON.stringify({ rect: { x: 'left', y: 0 } }));

    expect(readWindowState(path).rect).toBeNull();
  });

  it('discards a rect with a NaN coordinate', () => {
    const path = join(dir, 'nan.json');
    // JSON has no NaN literal; this is what a hand-edit produces.
    writeFileSync(path, '{"rect":{"x":null,"y":0,"width":1440,"height":900}}');

    expect(readWindowState(path).rect).toBeNull();
  });

  it('reports a failed write instead of throwing', () => {
    expect(writeWindowState(join(dir, 'no', 'such', 'dir.json'), EMPTY_STATE)).toBe(
      false,
    );
  });
});

describe('debounce', () => {
  afterEach(() => vi.useRealTimers());

  it('collapses a burst of resize events into one write', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounce(fn, 400);

    for (let i = 0; i < 50; i += 1) debounced(i);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(400);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(49);
  });

  it('flush writes the pending call immediately — the close-beats-timer case', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounce(fn, 400);

    debounced('last drag position');
    debounced.flush();

    expect(fn).toHaveBeenCalledWith('last drag position');
  });

  it('flush is a no-op when nothing is pending', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounce(fn, 400);

    debounced.flush();
    expect(fn).not.toHaveBeenCalled();
  });

  it('cancel drops the pending call', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounce(fn, 400);

    debounced('dropped');
    debounced.cancel();
    vi.advanceTimersByTime(1000);

    expect(fn).not.toHaveBeenCalled();
  });
});
