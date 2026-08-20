import { createPoller } from '@hooks/create-poller';
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
 *
 * The shared-timer, dedup and deferral mechanics live in `create-poller.ts`.
 */

/** The cadence. One minute — CI and reviews move on that timescale. */
const INTERVAL_MS = 60_000;

const usePoller = createPoller({ intervalMs: INTERVAL_MS });

export function usePrRefresh(): void {
  usePoller(useRefreshPrs());
}
