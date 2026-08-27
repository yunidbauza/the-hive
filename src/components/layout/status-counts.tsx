import { useCounts, useIdleDetailCounts } from '@stores/hive-store';

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
 * `truncate` keeps this to one line. It is a backstop rather than the usual
 * mechanism now: the chip beside it is what gives when the header narrows, so
 * these numbers ordinarily render whole. If it ever does run out, the ellipsis
 * eats the **tail** — `ended`, the least urgent number — and the full string
 * stays in the `title`. That ordering is why `idle` and `ended` were merged into
 * one `restText`: they are the two the user is least likely to be missing.
 *
 * ## Where its right edge lands
 *
 * On the activity rail's leading edge, which `header.tsx` arranges by giving the
 * control cluster the rail's own width, and which `rail-alignment.spec.ts`
 * measures in a real browser. The alignment is the reason there is no right
 * padding here, and adding some would quietly undo it.
 *
 * This zone does **not** shrink — `header.tsx` marks it `shrink-0`. The model
 * chip absorbs a narrow window instead, because it carries its full string in a
 * `title` and these numbers carry nothing.
 */
export function StatusCounts() {
  const { working, waiting, idle, done, terminated } = useCounts();
  const { agents, script } = useIdleDetailCounts();

  // Built once and reused for both the spans and the tooltip: two copies of the
  // same sentence drift the moment a separator changes on one of them.
  const workingText = `${working} working`;
  const waitingText = `${waiting} waiting`;
  const endedText = `${done + terminated} ended`;
  const restText = `${idle} idle · ${endedText}`;

  /**
   * The breakdown lives in the tooltip, not on screen (HIVE-83).
   *
   * The visible tally stays five numbers — widening it was the thing this
   * story deliberately did not do — and the detail costs no width here. Unlike
   * `endedText`, the working figure is *not* reused verbatim for the span: it
   * is the one number deliberately different in each place, carrying the
   * breakdown only where there is room for it.
   */
  const idleDetailText =
    agents + script === 0
      ? ''
      : ` (${[
          agents === 0 ? null : `${agents} with agents`,
          script === 0 ? null : `${script} with a script`,
        ]
          .filter((part) => part !== null)
          .join(', ')})`;

  /**
   * The breakdown hangs off **working**, because that is the tally those
   * sessions are now in.
   *
   * It used to hang off `idle`, and that was right while a quiet session with
   * subagents running was both labelled and counted as idle. `useCounts` now
   * buckets those rows as working — so that the header stops contradicting the
   * green `working (agents)` rows beneath it — and leaving the breakdown here
   * moved the contradiction into the tooltip instead of removing it: a header
   * reading `3 working … 0 idle` with a title explaining `0 idle (3 with
   * agents)`, which is a breakdown of a number those rows are not part of.
   */
  const idleText = `${idle} idle`;

  return (
    <p
      /* Named so `chip-alignment.spec.ts` can measure this element's right edge
         against the activity rail's border directly. */
      data-testid="status-counts"
      title={`${workingText}${idleDetailText} · ${waitingText} · ${idleText} · ${endedText}`}
      className="min-w-0 truncate font-mono text-xs text-muted"
    >
      <span className="text-green">{workingText}</span>
      {' · '}
      <span className="text-amber">{waitingText}</span>
      {` · ${restText}`}
    </p>
  );
}
