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
 * ## What gives when the header narrows: the words, then the chip
 *
 * The counts zone in `header.tsx` takes whatever width the model chip leaves,
 * and is a size container. Below `44ch` (see `Word`) it drops the four words and
 * reads `1 · 0 · 0 · 20`: the colours already say which number is which, and
 * the chip beside it keeps its context and limit stats. It used to be the other
 * way round, the counts `shrink-0` and the chip clipped, which cost the stats
 * the user actually glances at to keep four words they learn in a day.
 *
 * The words go `sr-only`, not `hidden`, so a screen reader still hears
 * `1 working`; the `title` keeps the full sentence for a pointer.
 *
 * `truncate` keeps this to one line and is only a backstop: the zone's floor is
 * the compact form, and past that it is the chip that clips.
 *
 * ## Where its right edge lands
 *
 * On the activity rail's leading edge, which `header.tsx` arranges by giving the
 * control cluster the rail's own width, and which `rail-alignment.spec.ts`
 * measures in a real browser. The alignment is the reason there is no right
 * padding here, and adding some would quietly undo it.
 */
export function StatusCounts() {
  const { working, waiting, idle, done, terminated } = useCounts();
  const { agents, script } = useIdleDetailCounts();

  // The tooltip's sentence. The spans split each of these into a number and a
  // `Word`, so the two can only drift in the words, which are literals.
  const workingText = `${working} working`;
  const waitingText = `${waiting} waiting`;
  const endedText = `${done + terminated} ended`;

  /**
   * The breakdown lives in the tooltip, not on screen (HIVE-83).
   *
   * The visible tally stays five numbers — widening it was the thing this
   * story deliberately did not do — and the detail costs no width here. The
   * working figure is the one number deliberately different in each place,
   * carrying the
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
      <span className="text-green">
        {working}
        <Word> working</Word>
      </span>
      {' · '}
      <span className="text-amber">
        {waiting}
        <Word> waiting</Word>
      </span>
      {` · ${idle}`}
      <Word> idle</Word>
      {` · ${done + terminated}`}
      <Word> ended</Word>
    </p>
  );
}

/**
 * A label that leaves the screen, not the accessibility tree, when narrow.
 *
 * `44ch` is the full sentence with two-digit counts all round;
 * `1 working · 0 waiting · 0 idle · 20 ended` is 41, so at worst this compacts
 * a few characters early rather than ellipsising. `ch`, because a container
 * query resolves it in the container's own font, which `header.tsx` sets to
 * this mono size.
 */
function Word({ children }: { children: string }) {
  return <span className="@max-[44ch]:sr-only">{children}</span>;
}
