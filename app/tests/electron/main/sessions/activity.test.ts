// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createActivityTracker } from '../../../../electron/main/sessions/activity';

/**
 * Status derived from pty output (story 096).
 *
 * The debounce is the whole reason this lives in main: a per-chunk store write
 * at firehose rates would re-render the shell continuously, which is precisely
 * what the store split exists to prevent.
 */

let seen: { entityId: string; status: string }[];

function tracker(idleAfterMs?: number) {
  return createActivityTracker({
    onStatus: (entityId, status) => seen.push({ entityId, status }),
    ...(idleAfterMs === undefined ? {} : { idleAfterMs }),
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  seen = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('derived status', () => {
  it('goes working on output and idle after the silence window', () => {
    const activity = tracker();

    activity.sawOutput('sess');
    expect(seen).toEqual([{ entityId: 'sess', status: 'working' }]);

    vi.advanceTimersByTime(1_999);
    expect(seen).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(seen.at(-1)).toEqual({ entityId: 'sess', status: 'idle' });
  });

  it('collapses a firehose into one status change', () => {
    /**
     * The point of the debounce. A `pnpm build` emits tens of thousands of
     * writes; every one of them reaching the renderer as a status update would
     * re-render the shell continuously.
     */
    const activity = tracker();

    for (let i = 0; i < 500; i += 1) {
      activity.sawOutput('sess');
      vi.advanceTimersByTime(1);
    }

    expect(seen).toEqual([{ entityId: 'sess', status: 'working' }]);
  });

  it('does not re-emit idle every window forever', () => {
    const activity = tracker();
    activity.sawOutput('sess');
    vi.advanceTimersByTime(2_000);
    const after = seen.length;

    vi.advanceTimersByTime(60_000);

    expect(seen).toHaveLength(after);
  });

  it('reports done when the process exits', () => {
    const activity = tracker();
    activity.sawOutput('sess');
    activity.exited('sess');

    expect(seen.at(-1)).toEqual({ entityId: 'sess', status: 'done' });
    expect(activity.statusOf('sess')).toBe('done');
  });

  it('never leaves a dead session claiming to be working', () => {
    /**
     * The last bytes of a process routinely arrive after main has seen the
     * exit. Flipping back to `working` there would strand the session in a busy
     * state that can never correct itself, because nothing more is coming.
     */
    const activity = tracker();
    activity.exited('sess');
    activity.sawOutput('sess');

    expect(activity.statusOf('sess')).toBe('done');
    vi.advanceTimersByTime(10_000);
    expect(seen.filter((entry) => entry.status === 'working')).toEqual([]);
  });

  it('never derives waiting from output', () => {
    /**
     * The guard against someone adding a heuristic later. A TUI that has asked a
     * question and a TUI that is thinking both produce no output; scraping
     * rendered text for question marks fails silently and constantly, and the
     * whole inbox and attention model is built on this field.
     *
     * The type already forbids it. This asserts the behaviour too, because a
     * type is not a test.
     */
    const activity = tracker();

    activity.sawOutput('sess');
    vi.advanceTimersByTime(10_000);
    activity.exited('sess');

    expect(seen.map((entry) => entry.status)).toEqual(['working', 'idle', 'done']);
    expect(seen.some((entry) => entry.status === 'waiting')).toBe(false);
  });

  it('tracks sessions independently', () => {
    const activity = tracker();

    activity.sawOutput('a');
    vi.advanceTimersByTime(1_500);
    activity.sawOutput('b');
    vi.advanceTimersByTime(500);

    // `a` fell silent; `b` did not.
    expect(activity.statusOf('a')).toBe('idle');
    expect(activity.statusOf('b')).toBe('working');
  });

  it('forgets a session on request', () => {
    const activity = tracker();
    activity.sawOutput('sess');
    activity.forget('sess');

    expect(activity.statusOf('sess')).toBeUndefined();
    vi.advanceTimersByTime(10_000);
    // Its idle timer went with it.
    expect(seen).toHaveLength(1);
  });

  it('drops every timer on dispose', () => {
    const activity = tracker();
    activity.sawOutput('a');
    activity.sawOutput('b');
    activity.dispose();

    vi.advanceTimersByTime(10_000);

    expect(seen.filter((entry) => entry.status === 'idle')).toEqual([]);
  });
});
