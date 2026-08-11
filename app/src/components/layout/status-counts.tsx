import { useCounts } from '@stores/hive-store';

/**
 * Fleet-wide session counts — the one place the whole hive's health is visible
 * at a glance.
 *
 * The numbers are derived in the `useCounts()` selector, never stored, so a
 * status change anywhere updates this and nothing else re-renders. Working and
 * waiting are coloured because they are the two that want the user's attention;
 * idle and ended stay muted on purpose.
 *
 * `done` and `terminated` are summed into one **ended** number (story 108). The
 * two are worth telling apart on a row, where the user is deciding what to do
 * about one session; in a fleet-wide tally they answer the same question — how
 * much of the hive is no longer running — and a fifth number would cost the
 * header width it does not have (see below).
 *
 * `truncate` (with the `min-w-0` that actually lets a flex item shrink) is what
 * keeps this to one line, and it is load-bearing rather than defensive: this
 * paragraph is the widest thing in the header after the model chip, and the two
 * of them share whatever the brand and the control cluster leave.
 *
 * The ellipsis eats the **tail** — `ended`, the least urgent number — and the
 * full string stays in the `title`. That ordering is why `idle` and `ended` are
 * the pair that got merged into one `restText`: they are the two the user is
 * least likely to be missing when the window is narrow.
 *
 * ## Where its right edge lands
 *
 * On the activity rail's leading edge, which `header.tsx` arranges by giving the
 * control cluster the rail's own width. Nothing in this file participates in
 * that beyond being shrinkable — but the alignment is the reason there is no
 * right padding here, and adding some would quietly undo it.
 */
export function StatusCounts() {
  const { working, waiting, idle, done, terminated } = useCounts();

  // Built once and reused for both the spans and the tooltip: two copies of the
  // same sentence drift the moment a separator changes on one of them.
  const workingText = `${working} working`;
  const waitingText = `${waiting} waiting`;
  const restText = `${idle} idle · ${done + terminated} ended`;

  return (
    <p
      /* Named so `chip-alignment.spec.ts` can measure this element's right edge
         against the activity rail's border directly. */
      data-testid="status-counts"
      title={`${workingText} · ${waitingText} · ${restText}`}
      className="min-w-0 truncate font-mono text-xs text-muted"
    >
      <span className="text-green">{workingText}</span>
      {' · '}
      <span className="text-amber">{waitingText}</span>
      {` · ${restText}`}
    </p>
  );
}
