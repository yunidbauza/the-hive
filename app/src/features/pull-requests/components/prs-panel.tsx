import { PrCard } from '@features/pull-requests/components/pr-card';
import { usePrs } from '@stores/hive-store';

/**
 * Every PR the fleet has open — what is shippable, and what is blocked.
 *
 * Reads the global `prs` collection, which is the single source of truth the
 * work panel (032) resolves against too. A second list here would let the two
 * surfaces disagree about the same number the moment the simulation moved one.
 */
export function PrsPanel() {
  const prs = usePrs();

  return (
    <div data-panel="prs" className="flex flex-col gap-[var(--cc-list-gap-sm)]">
      {prs.map((pr) => (
        <PrCard key={pr.n} pr={pr} />
      ))}
    </div>
  );
}
