/**
 * The WORK panel while the Jira read is in flight.
 *
 * ## Why a skeleton and not a spinner
 *
 * This panel used to boot with eight seeded tickets on screen, so a real read
 * arrived as a *replacement*: sample rows for a frame, then the truth. The fix
 * is not a faster read — it is having nothing false to show in the first place,
 * and then saying so in the shape of the thing being fetched.
 *
 * A centred spinner would have said "wait" without saying what for, and the
 * panel would still jump when cards landed. These blocks mirror
 * `ticket-card.tsx`'s geometry exactly — same `rounded-xl` border, same
 * `px-3 py-[var(--cc-card-py)]`, same `gap-[7px]` — so the list settles into
 * place rather than reflowing.
 *
 * ## Why three
 *
 * Enough to read as a list rather than a stalled single row, few enough that it
 * does not imply a count the query has not returned yet. The widths below are
 * deliberately uneven for the same reason: three identical bars read as a
 * loading *graphic*, three ragged ones read as text that has not arrived.
 *
 * `aria-hidden` on the blocks with a single live region above them: a screen
 * reader should hear "Loading tickets" once, not nine anonymous boxes.
 */
function SkeletonBar({ className }: { className: string }) {
  return <span className={`block h-2.5 rounded-full bg-chip ${className}`} />;
}

/**
 * One placeholder card, matching `TicketCard`'s box exactly.
 *
 * A `div`, deliberately, even though the real card is an `article` and copying
 * it would be the obvious way to match. `aria-hidden` keeps a placeholder out
 * of the accessibility tree but does nothing to a CSS selector, and both the
 * e2e suite and any future one count `article` to ask "how many tickets are on
 * screen?". Three skeletons answering that question with "three" is the same
 * class of lie as the seeded data this replaced.
 */
function SkeletonCard({ titleWidth }: { titleWidth: string }) {
  return (
    <div
      aria-hidden
      data-testid="work-skeleton-card"
      className="flex animate-pulse flex-col gap-[7px] rounded-xl border border-border-soft px-3 py-[var(--cc-card-py)]"
    >
      {/* The key/status row: a short key on the left, a status pill hard right. */}
      <div className="flex items-center gap-2">
        <SkeletonBar className="w-16" />
        <span className="flex-1" />
        <SkeletonBar className="w-14" />
      </div>

      {/* The title line, ragged across the three cards. */}
      <SkeletonBar className={titleWidth} />
    </div>
  );
}

export function TicketListSkeleton() {
  return (
    <div
      data-testid="work-skeleton"
      role="status"
      aria-label="Loading tickets"
      className="flex flex-col gap-[var(--cc-list-gap)]"
    >
      <SkeletonCard titleWidth="w-[78%]" />
      <SkeletonCard titleWidth="w-[62%]" />
      <SkeletonCard titleWidth="w-[70%]" />
    </div>
  );
}
