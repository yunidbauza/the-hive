import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { usePrRefresh } from '@/hooks/use-pr-refresh';

import { useHiveStore } from '@stores/hive-store';

/**
 * The shared poller.
 *
 * The whole reason this module exists is that **two panels can be mounted at
 * once** — the PRS panel in the activity rail and the WORK panel in the left
 * one. Everything below is about what that must not cost: not two timers, not
 * two concurrent `gh` processes, and not a sweep for a window nobody is
 * looking at.
 *
 * Fake timers throughout, per the repo's rule that timer behaviour is never
 * tested with real waits.
 */

const refreshPrs = vi.fn<() => Promise<void>>();

/**
 * Let the in-flight sweep settle.
 *
 * The dedup guard clears itself in a `.finally`, which is a microtask — so a
 * synchronous test would leave every later tick deduped against a sweep that
 * had already resolved. Advancing a minute at a time with a flush between is
 * also the more faithful model: in the app, a sweep answers in about a second
 * and the next tick arrives fifty-nine seconds later.
 */
async function tick(minutes = 1): Promise<void> {
  for (let i = 0; i < minutes; i += 1) {
    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
    });
  }
}

/** Flush a sweep started outside a tick — a mount, or a visibility change. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

/** Whether `document.hidden` reports the window as hidden. */
function setHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => hidden,
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  vi.useFakeTimers();
  refreshPrs.mockReset();
  refreshPrs.mockResolvedValue(undefined);
  useHiveStore.setState({ refreshPrs });
  setHidden(false);
});

afterEach(() => {
  vi.useRealTimers();
  useHiveStore.getState().reset();
});

describe('usePrRefresh', () => {
  it('reads once on the first mount', async () => {
    renderHook(() => usePrRefresh());
    await settle();

    expect(refreshPrs).toHaveBeenCalledTimes(1);
  });

  it('sweeps once a minute while mounted', async () => {
    renderHook(() => usePrRefresh());
    await settle();
    refreshPrs.mockClear();

    await tick(3);

    expect(refreshPrs).toHaveBeenCalledTimes(3);
  });

  /**
   * The case the module exists for. Two consumers, one timer: the WORK panel
   * and the PRS panel open together must not double the sweep rate.
   */
  it('shares one timer between two consumers', async () => {
    renderHook(() => usePrRefresh());
    const second = renderHook(() => usePrRefresh());
    await settle();
    refreshPrs.mockClear();

    await tick();

    expect(refreshPrs).toHaveBeenCalledTimes(1);
    second.unmount();
  });

  /**
   * The second consumer does not read on mount. The data is at most a minute
   * old and the timer is already running, so opening the other panel would be
   * spending a process to re-learn what is already on screen.
   */
  it('does not re-read when a second consumer mounts', async () => {
    renderHook(() => usePrRefresh());
    await settle();
    refreshPrs.mockClear();

    const second = renderHook(() => usePrRefresh());
    await settle();

    expect(refreshPrs).not.toHaveBeenCalled();
    second.unmount();
  });

  it('keeps polling while one consumer remains', async () => {
    const first = renderHook(() => usePrRefresh());
    renderHook(() => usePrRefresh());
    await settle();
    refreshPrs.mockClear();

    first.unmount();
    await tick();

    expect(refreshPrs).toHaveBeenCalledTimes(1);
  });

  it('stops when the last consumer unmounts', async () => {
    const only = renderHook(() => usePrRefresh());
    await settle();
    refreshPrs.mockClear();

    only.unmount();
    await tick(5);

    expect(refreshPrs).not.toHaveBeenCalled();
  });

  it('reads again when a panel is reopened after everything closed', async () => {
    const first = renderHook(() => usePrRefresh());
    await settle();
    first.unmount();
    refreshPrs.mockClear();

    renderHook(() => usePrRefresh());
    await settle();

    expect(refreshPrs).toHaveBeenCalledTimes(1);
  });

  describe('a hidden window', () => {
    it('skips the tick', async () => {
      renderHook(() => usePrRefresh());
      await settle();
      refreshPrs.mockClear();
      setHidden(true);

      await tick(3);

      expect(refreshPrs).not.toHaveBeenCalled();
    });

    /**
     * Deferred, not dropped. Whatever changed while the user was elsewhere is
     * exactly what they want to see when they come back, so the next visibility
     * change collects it rather than waiting out the rest of the minute.
     */
    it('catches up as soon as the window is shown again', async () => {
      renderHook(() => usePrRefresh());
      await settle();
      refreshPrs.mockClear();

      setHidden(true);
      await tick(2);
      setHidden(false);
      await settle();

      expect(refreshPrs).toHaveBeenCalledTimes(1);
    });

    it('does not catch up when no tick was missed', async () => {
      renderHook(() => usePrRefresh());
      await settle();
      refreshPrs.mockClear();

      setHidden(true);
      setHidden(false);
      await settle();

      expect(refreshPrs).not.toHaveBeenCalled();
    });
  });

  /**
   * A sweep that has not answered yet must not be joined by another. `gh` can
   * take seconds on a slow network, and a tick landing on one would stack
   * processes rather than replace them.
   */
  it('does not start a second sweep while one is in flight', async () => {
    let release: (() => void) | undefined;
    refreshPrs.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    renderHook(() => usePrRefresh());
    await settle();
    expect(refreshPrs).toHaveBeenCalledTimes(1);

    // Three minutes of ticks land on a sweep that has not answered.
    await tick(3);

    expect(refreshPrs).toHaveBeenCalledTimes(1);

    release?.();
  });
});
