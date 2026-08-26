import { act, render } from '@testing-library/react';
import { createElement, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import {
  PULL_MAX,
  PULL_THRESHOLD,
  usePullToRefresh,
} from '@/hooks/use-pull-to-refresh';

/**
 * The gesture, without a trackpad.
 *
 * happy-dom performs no layout, but this hook needs none: it reads `scrollTop`
 * (settable) and `overflow-y` (an inline style), and everything else is arithmetic
 * over `deltaY`. The one thing asserted nowhere here is how it *feels*, which no
 * unit test can reach.
 */

let latest: ReturnType<typeof usePullToRefresh>;
/** Typed to the hook's own option, so a signature change fails here too. */
let onRefresh: Mock<() => Promise<unknown>>;

/** A panel inside a scrollable rail — the shape the real rails produce. */
function Harness({ disabled = false }: { disabled?: boolean }): ReactElement {
  const pull = usePullToRefresh({ onRefresh, disabled });
  latest = pull;
  return createElement(
    'div',
    { 'data-testid': 'scroller', style: { overflowY: 'auto' } },
    createElement('div', { ref: pull.ref, 'data-testid': 'panel' }),
  );
}

const scroller = (): HTMLElement =>
  document.querySelector('[data-testid="scroller"]') as HTMLElement;

/** One notch of a two-finger scroll *up*: a negative delta. */
function wheel(deltaY: number): void {
  act(() => {
    scroller().dispatchEvent(
      new WheelEvent('wheel', { deltaY, cancelable: true, bubbles: true }),
    );
  });
}

const release = (): void => {
  act(() => {
    vi.advanceTimersByTime(200);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  onRefresh = vi.fn<() => Promise<unknown>>().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('usePullToRefresh', () => {
  it('starts idle and travelled nowhere', () => {
    render(createElement(Harness));
    expect(latest.phase).toBe('idle');
    expect(latest.distance).toBe(0);
  });

  it('accumulates an upward wheel at the top of the list', () => {
    render(createElement(Harness));

    wheel(-10);
    expect(latest.distance).toBe(10);
    expect(latest.phase).toBe('pulling');

    wheel(-15);
    expect(latest.distance).toBe(25);
    expect(latest.phase).toBe('pulling');
  });

  it('arms once the threshold is crossed', () => {
    render(createElement(Harness));

    wheel(-(PULL_THRESHOLD - 1));
    expect(latest.phase).toBe('pulling');

    wheel(-1);
    expect(latest.phase).toBe('armed');
  });

  /**
   * The gesture-end timer is the whole reason the hook has one: crossing the
   * threshold must not refresh mid-scroll, while the user is still moving.
   */
  it('does not refresh until the deltas stop', () => {
    render(createElement(Harness));

    wheel(-PULL_THRESHOLD);
    expect(onRefresh).not.toHaveBeenCalled();

    release();
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('returns to idle once the refresh settles', async () => {
    render(createElement(Harness));

    wheel(-PULL_THRESHOLD);
    release();
    expect(latest.phase).toBe('refreshing');
    // Held at the threshold, not wherever the gesture happened to end.
    expect(latest.distance).toBe(PULL_THRESHOLD);

    await act(async () => {
      await Promise.resolve();
    });

    expect(latest.phase).toBe('idle');
    expect(latest.distance).toBe(0);
  });

  it('springs back without refreshing when released short', () => {
    render(createElement(Harness));

    wheel(-(PULL_THRESHOLD - 5));
    release();

    expect(onRefresh).not.toHaveBeenCalled();
    expect(latest.phase).toBe('idle');
    expect(latest.distance).toBe(0);
  });

  it('clamps how far the list travels', () => {
    render(createElement(Harness));

    wheel(-(PULL_MAX * 3));
    expect(latest.distance).toBe(PULL_MAX);
  });

  it('ignores the gesture unless the list is already at the top', () => {
    render(createElement(Harness));
    scroller().scrollTop = 40;

    wheel(-100);

    expect(latest.phase).toBe('idle');
    expect(latest.distance).toBe(0);
    release();
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('abandons a pull the moment the wheel turns back downward', () => {
    render(createElement(Harness));

    wheel(-40);
    expect(latest.distance).toBe(40);

    wheel(20);
    expect(latest.phase).toBe('idle');
    expect(latest.distance).toBe(0);

    release();
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('claims the delta so the rail does not bounce against it', () => {
    render(createElement(Harness));

    const event = new WheelEvent('wheel', {
      deltaY: -20,
      cancelable: true,
      bubbles: true,
    });
    act(() => {
      scroller().dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
  });

  it('leaves a delta alone when there is nothing to pull', () => {
    render(createElement(Harness));
    scroller().scrollTop = 40;

    const event = new WheelEvent('wheel', {
      deltaY: -20,
      cancelable: true,
      bubbles: true,
    });
    act(() => {
      scroller().dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(false);
  });

  it('does nothing at all while disabled', () => {
    render(createElement(Harness, { disabled: true }));

    wheel(-PULL_THRESHOLD * 2);
    release();

    expect(latest.phase).toBe('idle');
    expect(latest.distance).toBe(0);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  /** A search box gaining a term while the list is held open mid-pull. */
  it('clears an in-flight pull when it becomes disabled', () => {
    const view = render(createElement(Harness));

    wheel(-40);
    expect(latest.distance).toBe(40);

    view.rerender(createElement(Harness, { disabled: true }));

    expect(latest.distance).toBe(0);
    expect(latest.phase).toBe('idle');
  });

  it('will not stack a second refresh on one already running', async () => {
    let settle: () => void = () => {};
    onRefresh.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    render(createElement(Harness));

    wheel(-PULL_THRESHOLD);
    release();
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(latest.phase).toBe('refreshing');

    // Keep pulling while it is still in flight.
    wheel(-PULL_THRESHOLD);
    release();
    expect(onRefresh).toHaveBeenCalledTimes(1);

    await act(async () => {
      settle();
      await Promise.resolve();
    });
    expect(latest.phase).toBe('idle');
  });

  /**
   * A failing refresh must not also produce an unhandled rejection. `void
   * promise.finally()` does — `finally` passes the rejection straight through,
   * and the `void` throws away the handle that would have caught it.
   */
  it('settles even when the refresh rejects, and raises nothing', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    onRefresh.mockRejectedValue(new Error('offline'));
    render(createElement(Harness));

    wheel(-PULL_THRESHOLD);
    release();

    await act(async () => {
      await Promise.resolve();
    });

    expect(latest.phase).toBe('idle');
    expect(latest.distance).toBe(0);

    // Node reports an unhandled rejection on a real macrotask turn, which a
    // fake clock never reaches — so this one assertion needs the real one.
    vi.useRealTimers();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(unhandled).not.toHaveBeenCalled();
    process.off('unhandledRejection', unhandled);
  });

  it('detaches its listener when the panel goes away', () => {
    const view = render(createElement(Harness));
    const node = scroller();
    const remove = vi.spyOn(node, 'removeEventListener');

    view.unmount();

    expect(remove).toHaveBeenCalledWith('wheel', expect.any(Function));
  });
});
