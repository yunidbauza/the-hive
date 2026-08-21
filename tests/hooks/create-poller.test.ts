import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPoller } from '@hooks/create-poller';

/**
 * The poller factory itself (HIVE-81 review, finding 12).
 *
 * `use-pr-refresh.test.ts` and `use-ticket-refresh.test.ts` both exercise this
 * machinery, but each does so through one store action and one interval, and
 * neither can say anything about the property the factory exists for: **two
 * calls to it share code and share nothing else.** That was the whole argument
 * for extracting it — the WORK panel mounts both consumers at once, and a
 * module-level timer or counter would couple their lifetimes — and it was the
 * one claim no test made. `tests/` mirrors `src/`, with no exceptions.
 *
 * Fake timers throughout, per the repo's rule that timer behaviour is never
 * tested with real waits.
 */

const INTERVAL = 60_000;

/** Let a `.finally`-cleared in-flight slot settle. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

/** Advance whole intervals, flushing the sweep each one starts. */
async function tick(count = 1): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await act(async () => {
      vi.advanceTimersByTime(INTERVAL);
      await Promise.resolve();
    });
  }
}

/** Whether `document.hidden` reports the window as hidden. */
function setHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => hidden,
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

/**
 * A stable action, so the `[action]` dependency does not re-run the effect on
 * every render — which is exactly how the real consumers pass one, since a
 * zustand selector hook returns the same function identity across renders.
 */
const stable = (fn: () => Promise<void>) => fn;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  setHidden(false);
});

describe('per-factory isolation', () => {
  /**
   * The reason the factory exists rather than a module of shared mutable
   * state. Two pollers, mounted together the way the WORK panel mounts them.
   */
  it('gives each factory its own timer and consumer count', async () => {
    const first = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const second = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const usePollerA = createPoller({ intervalMs: INTERVAL });
    const usePollerB = createPoller({ intervalMs: 10_000 });

    const a = renderHook(() => usePollerA(stable(first)));
    const b = renderHook(() => usePollerB(stable(second)));
    await settle();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    // B's cadence is six times A's, which a shared timer could not express: a
    // tenth of a minute is a whole interval for B and nothing at all for A.
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);

    // Unmounting one must not stop the other.
    a.unmount();
    second.mockClear();
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });
    expect(second).toHaveBeenCalled();

    b.unmount();
  });

  it('does not let one factory’s in-flight sweep dedup another’s', async () => {
    const slow = vi.fn<() => Promise<void>>().mockReturnValue(new Promise(() => {}));
    const quick = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const usePollerA = createPoller({ intervalMs: INTERVAL });
    const usePollerB = createPoller({ intervalMs: INTERVAL });

    const a = renderHook(() => usePollerA(stable(slow)));
    const b = renderHook(() => usePollerB(stable(quick)));
    await settle();

    // A's sweep never resolves; B must keep sweeping regardless.
    await tick(2);

    expect(slow).toHaveBeenCalledTimes(1);
    expect(quick).toHaveBeenCalledTimes(3);

    a.unmount();
    b.unmount();
  });
});

describe('the shared timer', () => {
  it('reads on the first consumer and not on the second', async () => {
    const action = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const usePoller = createPoller({ intervalMs: INTERVAL });

    const first = renderHook(() => usePoller(stable(action)));
    await settle();
    expect(action).toHaveBeenCalledTimes(1);

    // With a panel already open the data is at most one interval old, so
    // opening a second would spend a read to re-learn what is on screen.
    const second = renderHook(() => usePoller(stable(action)));
    await settle();
    expect(action).toHaveBeenCalledTimes(1);

    // ...and one tick is still one sweep, not two.
    await tick();
    expect(action).toHaveBeenCalledTimes(2);

    first.unmount();
    second.unmount();
  });

  it('keeps ticking until the last consumer unmounts', async () => {
    const action = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const usePoller = createPoller({ intervalMs: INTERVAL });

    const first = renderHook(() => usePoller(stable(action)));
    const second = renderHook(() => usePoller(stable(action)));
    await settle();

    first.unmount();
    await tick();
    expect(action).toHaveBeenCalledTimes(2);

    second.unmount();
    await tick();
    expect(action).toHaveBeenCalledTimes(2);
  });

  it('reads again when a consumer mounts after the last one left', async () => {
    const action = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const usePoller = createPoller({ intervalMs: INTERVAL });

    renderHook(() => usePoller(stable(action))).unmount();
    await settle();
    expect(action).toHaveBeenCalledTimes(1);

    // A fresh first consumer: the data is however old the gap was, so it reads.
    const again = renderHook(() => usePoller(stable(action)));
    await settle();
    expect(action).toHaveBeenCalledTimes(2);

    again.unmount();
  });
});

describe('in-flight dedup', () => {
  it('does not stack a tick on top of a sweep that has not answered', async () => {
    let release: (() => void) | undefined;
    const action = vi.fn<() => Promise<void>>().mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const usePoller = createPoller({ intervalMs: INTERVAL });

    const view = renderHook(() => usePoller(stable(action)));
    await settle();
    expect(action).toHaveBeenCalledTimes(1);

    await tick(3);
    expect(action).toHaveBeenCalledTimes(1);

    // Once it answers, the next tick sweeps again.
    release?.();
    await settle();
    await tick();
    expect(action).toHaveBeenCalledTimes(2);

    view.unmount();
  });

  it('does not start a second read when a consumer mounts mid-sweep', async () => {
    const action = vi.fn<() => Promise<void>>().mockReturnValue(new Promise(() => {}));
    const usePoller = createPoller({ intervalMs: INTERVAL });

    const first = renderHook(() => usePoller(stable(action)));
    // No settle: the sweep is deliberately still out.
    const second = renderHook(() => usePoller(stable(action)));
    await settle();

    expect(action).toHaveBeenCalledTimes(1);

    first.unmount();
    second.unmount();
  });
});

describe('hidden-window deferral', () => {
  /**
   * Deferral, not dropping. A hidden window is not worth the work, but whatever
   * changed while the user was away is exactly what they want on return — so a
   * skipped tick is collected on the next visibility change rather than waiting
   * out the rest of the interval.
   */
  it('skips a tick while hidden and catches up on return', async () => {
    const action = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const usePoller = createPoller({ intervalMs: INTERVAL });

    const view = renderHook(() => usePoller(stable(action)));
    await settle();
    expect(action).toHaveBeenCalledTimes(1);

    setHidden(true);
    await tick(3);
    expect(action).toHaveBeenCalledTimes(1);

    setHidden(false);
    await settle();
    expect(action).toHaveBeenCalledTimes(2);

    view.unmount();
  });

  it('collects at most one catch-up read, however many ticks were missed', async () => {
    const action = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const usePoller = createPoller({ intervalMs: INTERVAL });

    const view = renderHook(() => usePoller(stable(action)));
    await settle();
    action.mockClear();

    setHidden(true);
    await tick(5);
    setHidden(false);
    await settle();

    // One read, not five: the point is the current answer, not a replay.
    expect(action).toHaveBeenCalledTimes(1);

    view.unmount();
  });

  it('does not read when the window becomes hidden with nothing missed', async () => {
    const action = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const usePoller = createPoller({ intervalMs: INTERVAL });

    const view = renderHook(() => usePoller(stable(action)));
    await settle();
    action.mockClear();

    setHidden(true);
    await settle();
    setHidden(false);
    await settle();

    expect(action).not.toHaveBeenCalled();

    view.unmount();
  });

  /**
   * The missed flag belongs to the mounted lifetime. A tick skipped while the
   * window was hidden, followed by every consumer leaving, must not fire a
   * catch-up read into a panel nobody is looking at.
   */
  it('forgets a missed tick once the last consumer has gone', async () => {
    const action = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const usePoller = createPoller({ intervalMs: INTERVAL });

    const view = renderHook(() => usePoller(stable(action)));
    await settle();

    setHidden(true);
    await tick();
    view.unmount();
    action.mockClear();

    setHidden(false);
    await settle();

    expect(action).not.toHaveBeenCalled();
  });
});
