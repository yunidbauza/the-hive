/**
 * The PRs panel while the first sweep is in flight.
 *
 * The same argument as `ticket-card-skeleton.tsx`, applied to the rail that
 * used to be seeded: the panel booted with four sample PRs, so a real read
 * arrived as a *replacement* — fixtures for a frame, then the truth. The fix is
 * not a faster read, it is having nothing false to show, and then saying so in
 * the shape of the thing being fetched.
 *
 * Geometry mirrors `pr-card.tsx` exactly — same `rounded-xl` border, same
 * `px-3 py-[var(--cc-card-py)]`, a title row, a repo line and a badge row — so
 * the list settles into place rather than reflowing when cards land.
 *
 * Only shown for the **first** sweep. A refresh with PRs already on screen
 * keeps them: replacing content the user is reading with placeholders every
 * sixty seconds would be a far worse flicker than the one this fixed.
 */
function SkeletonBar({ className }: { className: string }) {
  return <span className={`block h-2.5 rounded-full bg-chip ${className}`} />;
}

/**
 * One placeholder card, matching `PrCard`'s box.
 *
 * A `div` with `aria-hidden`, and no `button` anywhere in it: the e2e suite
 * counts interactive elements to ask "how many PRs are on screen?", and three
 * skeletons answering "three" would be the same class of lie as the fixtures
 * this replaced.
 */
function SkeletonCard({ titleWidth }: { titleWidth: string }) {
  return (
    <div
      aria-hidden
      data-testid="prs-skeleton-card"
      className="flex animate-pulse flex-col gap-[7px] rounded-xl border border-border-soft px-3 py-[var(--cc-card-py)]"
    >
      {/* The number and title row: a short number, then the title. */}
      <div className="flex items-center gap-2">
        <SkeletonBar className="w-8" />
        <SkeletonBar className={titleWidth} />
      </div>

      {/* The repo line, always shorter than the title above it. */}
      <SkeletonBar className="w-20" />

      {/* One badge, because one is the honest minimum every state produces. */}
      <SkeletonBar className="w-24 rounded-full" />
    </div>
  );
}

export function PrListSkeleton() {
  return (
    <div
      data-testid="prs-skeleton"
      role="status"
      aria-label="Loading pull requests"
      className="flex flex-col gap-[var(--cc-list-gap-sm)]"
    >
      <SkeletonCard titleWidth="w-[58%]" />
      <SkeletonCard titleWidth="w-[44%]" />
      <SkeletonCard titleWidth="w-[52%]" />
    </div>
  );
}
