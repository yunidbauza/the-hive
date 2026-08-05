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
 * keeps this to one line, and it is load-bearing for the header's centred model
 * chip rather than mere defensiveness. Centring the chip on the header's true
 * midpoint means both side tracks size to the *wider* of the two, and this
 * cluster is the wider one; at 1440 that costs 113px more than the bar has. If
 * this paragraph cannot give, the deficit lands on the chip instead — so the
 * counts ellipsise from the tail (`done`, the least urgent number) and the chip
 * stays whole and centred. Above roughly 1553px nothing truncates at all. The
 * full string stays in the tooltip.
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
