import { useEffect } from 'react';

import { useRefreshPrs } from '@stores/hive-store';

/**
 * Keep the PR list current for as long as something is showing it.
 *
 * ## Why one poller and not one per panel
 *
 * Two surfaces read this data: the PRS panel in the activity rail, and the WORK
 * panel's ticket cards in the left rail. **Both can be mounted at once**, so the
 * obvious `useEffect(() => setInterval(refresh, 60_000))` inside each panel
 * would mean two concurrent sweeps a minute, two `gh` processes, and two writes
 * racing into the same store slice. This is one module-level timer with a
 * subscriber count: the first consumer starts it, the last one stops it, and
 * however many mount in between share it.
 *
 * ## Why no event bus
 *
 * There is already one. Both panels read `prs` through selector hooks, so a
 * single store write re-renders exactly the components subscribed to it —
 * approving a PR shows up on a ticket card whether or not the PRS tab has ever
 * been opened. What was missing was never a way to *publish*; it was a single
 * owner of the read.
 *
 * ## What this deliberately does not do
 *
 * Poll when nothing is looking. A backgrounded window with both panels closed
 * spends nothing, and the first mount after that reads immediately — so the
 * data is fresh when it is seen, rather than kept fresh when it is not. The day
 * PR changes should raise inbox notifications with no panel open, this moves
 * into the main process; the client it calls does not have to change.
 */

/** The cadence. One minute — CI and reviews move on that timescale. */
const INTERVAL_MS = 60_000;

/** How many mounted components are asking. The timer runs while this is > 0. */
let consumers = 0;
let timer: ReturnType<typeof setInterval> | null = null;

/**
 * The sweep in flight, or `null`.
 *
 * Deduplication, not bookkeeping: mounting the second panel while the first
 * one's read is still out must not start a second `gh`, and a tick that lands
 * on a slow sweep must not stack a third.
 */
let inFlight: Promise<void> | null = null;

/** A tick was skipped because the window was hidden. Caught up on re-show. */
let missed = false;

/**
 * The store's action, captured on mount.
 *
 * Held in the module rather than passed to the timer so the interval callback
 * has nothing bound to a particular component's render.
 */
let refresh: (() => Promise<void>) | null = null;

/** Whether this environment can tell a hidden window from a visible one. */
const canSeeVisibility = (): boolean => typeof document !== 'undefined';

function sweep(): void {
  if (inFlight !== null || refresh === null) return;

  inFlight = refresh().finally(() => {
    inFlight = null;
  });
}

function tick(): void {
  /*
    A hidden window is not worth a `gh` process. The flag is what makes this
    *deferral* rather than a dropped read: whatever changed while the user was
    elsewhere is exactly what they want to see when they come back, so the next
    visibility change collects it immediately instead of waiting out the rest of
    the minute.
  */
  if (canSeeVisibility() && document.hidden) {
    missed = true;
    return;
  }

  sweep();
}

function onVisibilityChange(): void {
  if (document.hidden || !missed) return;
  missed = false;
  sweep();
}

/**
 * Subscribe this component to the shared poller.
 *
 * Mount reads immediately **only when it is the first consumer**. With a panel
 * already open the data is at most a minute old and the timer is already
 * running, so opening the second one would be spending a process to re-learn
 * what is on screen.
 */
export function usePrRefresh(): void {
  const refreshPrs = useRefreshPrs();

  useEffect(() => {
    refresh = refreshPrs;
    consumers += 1;

    if (consumers === 1) {
      if (canSeeVisibility()) {
        document.addEventListener('visibilitychange', onVisibilityChange);
      }
      timer = setInterval(tick, INTERVAL_MS);
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
    };
  }, [refreshPrs]);
}
