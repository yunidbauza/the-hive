import { useEffect } from 'react';

/**
 * A shared-timer poller, one per call to this factory.
 *
 * Extracted from `use-pr-refresh` (HIVE-81) when the WORK panel needed the same
 * behaviour for tickets. Everything hard about it was already solved there and
 * none of it is specific to pull requests:
 *
 * - **One timer per data source, not per component.** Two surfaces read PRs and
 *   both can be mounted at once; the obvious per-component `setInterval` would
 *   mean two sweeps a minute, two subprocesses, and two writes racing into one
 *   store slice. First consumer starts the timer, last one stops it.
 * - **In-flight dedup.** Mounting a second panel mid-sweep must not start a
 *   second read, and a tick landing on a slow sweep must not stack a third.
 * - **Deferral, not dropping.** A hidden window is not worth the work, but
 *   whatever changed while the user was away is exactly what they want on
 *   return — so a skipped tick is remembered and collected on the next
 *   visibility change rather than waiting out the rest of the interval.
 *
 * Each factory call closes over its own state, so the PR poller and the ticket
 * poller share code and share nothing else. That is the point: a single module
 * with two counters would couple their lifetimes, and the WORK panel mounts
 * both.
 */
export interface PollerOptions {
  /** The cadence, in milliseconds. */
  intervalMs: number;
}

export function createPoller({ intervalMs }: PollerOptions) {
  let consumers = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight: Promise<void> | null = null;
  let missed = false;
  let refresh: (() => Promise<void>) | null = null;

  const canSeeVisibility = (): boolean => typeof document !== 'undefined';

  const sweep = (): void => {
    if (inFlight !== null || refresh === null) return;
    inFlight = refresh().finally(() => {
      inFlight = null;
    });
  };

  const tick = (): void => {
    if (canSeeVisibility() && document.hidden) {
      missed = true;
      return;
    }
    sweep();
  };

  const onVisibilityChange = (): void => {
    if (document.hidden || !missed) return;
    missed = false;
    sweep();
  };

  /**
   * Subscribe a component to this poller.
   *
   * Mount reads immediately **only when it is the first consumer**. With a
   * panel already open the data is at most one interval old and the timer is
   * already running, so opening the second would spend a read to re-learn what
   * is on screen.
   */
  return function usePoller(action: () => Promise<void>): void {
    useEffect(() => {
      refresh = action;
      consumers += 1;

      if (consumers === 1) {
        if (canSeeVisibility()) {
          document.addEventListener('visibilitychange', onVisibilityChange);
        }
        timer = setInterval(tick, intervalMs);
        sweep();
      }

      return () => {
        consumers -= 1;
        if (consumers > 0) return;

        if (timer !== null) {
          clearInterval(timer);
          timer = null;
        }
        if (canSeeVisibility()) {
          document.removeEventListener('visibilitychange', onVisibilityChange);
        }
        missed = false;
        /*
          Dropped alongside the timer and the missed flag, so the cleanup is
          exhaustive rather than nearly so. Holding it costs nothing today —
          nothing can call `sweep` with no timer and no listener — but it keeps
          the last unmounted component's closure alive for as long as the
          module does, and "the poller is idle" ought to mean it is holding
          nothing.

          `inFlight` is deliberately *not* cleared: its own `finally` does that,
          and nulling the handle here would let a remount start a second read
          alongside the one still out.
        */
        refresh = null;
      };
    }, [action]);
  };
}
