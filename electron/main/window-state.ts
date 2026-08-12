import { readFileSync, writeFileSync } from 'node:fs';

import {
  DEFAULT_WINDOW_SIZE,
  MIN_WINDOW_SIZE,
} from '@shared/window';

/**
 * Window geometry that survives a restart (story 081).
 *
 * The interesting half is not saving — it is refusing to restore a rect that
 * would open the window somewhere the user cannot see. A window restored to the
 * coordinates of a monitor that is no longer connected opens offscreen, and
 * that looks exactly like a hang: the app is running, the dock icon is
 * bouncing, and there is nothing on screen.
 */

export interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowState {
  rect: WindowRect | null;
  maximized: boolean;
}

/** A display's usable area, i.e. Electron's `Display['workArea']`. */
export type WorkArea = WindowRect;

export const EMPTY_STATE: WindowState = { rect: null, maximized: false };

/**
 * How much of the window has to land on a real display for the saved rect to be
 * worth restoring.
 *
 * A pure "do the rectangles intersect at all?" test passes for a window
 * overlapping by one pixel, which is indistinguishable from offscreen. This is
 * roughly "enough of the header to grab and drag".
 */
export const MIN_VISIBLE = { width: 96, height: 48 } as const;

function isRect(value: unknown): value is WindowRect {
  if (typeof value !== 'object' || value === null) return false;
  const rect = value as Record<string, unknown>;
  return (['x', 'y', 'width', 'height'] as const).every(
    (key) => typeof rect[key] === 'number' && Number.isFinite(rect[key]),
  );
}

/** Overlap of two rects, in pixels, per axis. */
function overlap(a: WindowRect, b: WorkArea) {
  return {
    width: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
    height: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
  };
}

/** True when the rect lands meaningfully on at least one attached display. */
export function isRectVisible(rect: WindowRect, workAreas: WorkArea[]): boolean {
  return workAreas.some((area) => {
    const { width, height } = overlap(rect, area);
    return width >= MIN_VISIBLE.width && height >= MIN_VISIBLE.height;
  });
}

/**
 * The rect to actually open with.
 *
 * Returns `null` when there is nothing trustworthy to restore, which the caller
 * reads as "let Electron centre a default-sized window".
 */
export function resolveRect(
  saved: WindowRect | null,
  workAreas: WorkArea[],
): WindowRect | null {
  if (!saved) return null;
  if (saved.width < MIN_WINDOW_SIZE.width || saved.height < MIN_WINDOW_SIZE.height) {
    return null;
  }
  return isRectVisible(saved, workAreas) ? saved : null;
}

/**
 * Read persisted state, treating every failure as "no state".
 *
 * A corrupt or hand-edited state file must never stop the app from opening —
 * the whole feature is a convenience, and failing closed here would trade a
 * cosmetic nicety for a launch failure.
 */
export function readWindowState(path: string): WindowState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return EMPTY_STATE;
  }
  if (typeof parsed !== 'object' || parsed === null) return EMPTY_STATE;

  const { rect, maximized } = parsed as Record<string, unknown>;
  return {
    rect: isRect(rect) ? rect : null,
    maximized: maximized === true,
  };
}

/** Persist state, treating a write failure as non-fatal for the same reason. */
export function writeWindowState(path: string, state: WindowState): boolean {
  try {
    writeFileSync(path, JSON.stringify(state), 'utf8');
    return true;
  } catch (error) {
    console.error('[hive] could not save window state:', error);
    return false;
  }
}

/**
 * Collapse a burst of `resize`/`move` events into one write.
 *
 * Dragging a window fires these continuously; writing on each one would mean
 * hundreds of synchronous `writeFileSync` calls during a single drag.
 */
export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
): ((...args: A) => void) & { flush: () => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: A | undefined;

  const run = (...args: A) => {
    pending = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      const args_ = pending;
      pending = undefined;
      if (args_) fn(...args_);
    }, ms);
  };

  run.flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    const args = pending;
    pending = undefined;
    if (args) fn(...args);
  };

  run.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    pending = undefined;
  };

  return run;
}

export { DEFAULT_WINDOW_SIZE, MIN_WINDOW_SIZE };
