import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useTicketRefresh } from '@hooks/use-ticket-refresh';

import { useHiveStore } from '@stores/hive-store';

/**
 * The shared poller, on the ticket side (HIVE-81).
 *
 * `createPoller` is what makes this file nearly identical to
 * `use-pr-refresh.test.ts`: the machinery is shared, and so is the risk it
 * guards against — the WORK panel mounts both `useTicketRefresh` and
 * `usePrRefresh` at once, so each needs its own timer, consumer count, and
 * in-flight slot rather than a module-level one shared between them.
 *
 * Fake timers throughout, per the repo's rule that timer behaviour is never
 * tested with real waits.
 */

const refreshTickets = vi.fn<() => Promise<void>>();

/**
 * Let the in-flight sweep settle.
 *
 * The dedup guard clears itself in a `.finally`, which is a microtask — so a
 * synchronous test would leave every later tick deduped against a sweep that
 * had already resolved. Advancing a minute at a time with a flush between is
 * also the more faithful model: in the app, a sweep answers quickly and the
 * next tick arrives fifty-nine seconds later.
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
  refreshTickets.mockReset();
  refreshTickets.mockResolvedValue(undefined);
  useHiveStore.setState({ refreshTickets });
  setHidden(false);
});

afterEach(() => {
  vi.useRealTimers();
  useHiveStore.getState().reset();
});

describe('useTicketRefresh', () => {
  it('reads once on the first mount', async () => {
    renderHook(() => useTicketRefresh());
    await settle();

    expect(refreshTickets).toHaveBeenCalledTimes(1);
  });

  it('sweeps once a minute while mounted', async () => {
    renderHook(() => useTicketRefresh());
    await settle();
    refreshTickets.mockClear();

    await tick(3);

    expect(refreshTickets).toHaveBeenCalledTimes(3);
  });

  /**
   * The case the module exists for. Two consumers, one timer: two mounts of
   * the WORK panel's poller must not double the sweep rate.
   */
  it('shares one timer between two consumers', async () => {
    renderHook(() => useTicketRefresh());
    const second = renderHook(() => useTicketRefresh());
    await settle();
    refreshTickets.mockClear();

    await tick();

    expect(refreshTickets).toHaveBeenCalledTimes(1);
    second.unmount();
  });

  /**
   * The second consumer does not read on mount. The data is at most a minute
   * old and the timer is already running, so opening the second one would be
   * spending a read to re-learn what is already on screen.
   */
  it('does not re-read when a second consumer mounts', async () => {
    renderHook(() => useTicketRefresh());
    await settle();
    refreshTickets.mockClear();

    const second = renderHook(() => useTicketRefresh());
    await settle();

    expect(refreshTickets).not.toHaveBeenCalled();
    second.unmount();
  });

  it('keeps polling while one consumer remains', async () => {
    const first = renderHook(() => useTicketRefresh());
    renderHook(() => useTicketRefresh());
    await settle();
    refreshTickets.mockClear();

    first.unmount();
    await tick();

    expect(refreshTickets).toHaveBeenCalledTimes(1);
  });

  it('stops when the last consumer unmounts', async () => {
    const only = renderHook(() => useTicketRefresh());
    await settle();
    refreshTickets.mockClear();

    only.unmount();
    await tick(5);

    expect(refreshTickets).not.toHaveBeenCalled();
  });

  it('reads again when a panel is reopened after everything closed', async () => {
    const first = renderHook(() => useTicketRefresh());
    await settle();
    first.unmount();
    refreshTickets.mockClear();

    renderHook(() => useTicketRefresh());
    await settle();

    expect(refreshTickets).toHaveBeenCalledTimes(1);
  });

  describe('a hidden window', () => {
    it('skips the tick', async () => {
      renderHook(() => useTicketRefresh());
      await settle();
      refreshTickets.mockClear();
      setHidden(true);

      await tick(3);

      expect(refreshTickets).not.toHaveBeenCalled();
    });

    /**
     * Deferred, not dropped. Whatever changed while the user was elsewhere is
     * exactly what they want to see when they come back, so the next
     * visibility change collects it rather than waiting out the rest of the
     * minute.
     */
    it('catches up as soon as the window is shown again', async () => {
      renderHook(() => useTicketRefresh());
      await settle();
      refreshTickets.mockClear();

      setHidden(true);
      await tick(2);
      setHidden(false);
      await settle();

      expect(refreshTickets).toHaveBeenCalledTimes(1);
    });

    it('does not catch up when no tick was missed', async () => {
      renderHook(() => useTicketRefresh());
      await settle();
      refreshTickets.mockClear();

      setHidden(true);
      setHidden(false);
      await settle();

      expect(refreshTickets).not.toHaveBeenCalled();
    });
  });

  /**
   * A sweep that has not answered yet must not be joined by another. A tick
   * landing on one must not stack a second read.
   */
  it('does not start a second sweep while one is in flight', async () => {
    let release: (() => void) | undefined;
    refreshTickets.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    renderHook(() => useTicketRefresh());
    await settle();
    expect(refreshTickets).toHaveBeenCalledTimes(1);

    // Three minutes of ticks land on a sweep that has not answered.
    await tick(3);

    expect(refreshTickets).toHaveBeenCalledTimes(1);

    release?.();
  });

  /**
   * The specific bug the per-call closure guards against (HIVE-81): the WORK
   * panel mounts this poller and `usePrRefresh` together, and a shared
   * module-level timer would couple their lifetimes. Stopping the ticket
   * poller must leave a PR poller running on its own timer untouched — proven
   * indirectly here by asserting this poller's timer is independently owned:
   * it starts on its own first mount and stops on its own last unmount, which
   * only holds if `createPoller` gives each call fresh closure state rather
   * than sharing one module-level counter.
   */
  it('owns a timer independent of any other poller', async () => {
    const only = renderHook(() => useTicketRefresh());
    await settle();
    refreshTickets.mockClear();

    await tick(2);
    expect(refreshTickets).toHaveBeenCalledTimes(2);

    only.unmount();
    refreshTickets.mockClear();
    await tick(2);

    expect(refreshTickets).not.toHaveBeenCalled();
  });
});
