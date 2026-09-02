/**
 * Terminal transcript primitives.
 *
 * These live in `types/` rather than in `lib/terminal/` because the store holds
 * transcripts and the store may not depend on library internals. `ansi.ts`
 * imports `TermColor` from here so there is exactly one definition.
 */

/** Colour names a transcript line may carry. */
export type TermColor =
  | 'ink'
  | 'dim'
  | 'green'
  | 'blue'
  | 'amber'
  | 'red'
  | 'cyan';

/** One line of terminal transcript. */
export interface TermLine {
  text: string;
  color: TermColor;
  /**
   * This line is the last of its turn — the run log's `● turn ended` fold.
   *
   * Set only by agent run-log lines (`RunLine.endsTurn`, which main writes) and
   * ignored by every terminal transcript, which has no notion of a turn. It
   * lives on the wider type because an agent's buffer *is* a `TermLine[]` — the
   * browser demo appends acknowledgement lines to it in colours `RunLineColor`
   * does not have — so a reader of that buffer can only see the marker if this
   * type carries it.
   *
   * A **field**, deliberately, and not the fold's `cyan`. The run log splits its
   * buffer into turns to draw them newest-first, and `agent-contract.ts` warns
   * in as many words that keying that split on the colour is "wrong the moment
   * the fold gains a second cyan line". Colour is presentation; a boundary is
   * structure.
   */
  endsTurn?: true;
  /** The agent run that wrote it — `RunLine.run` (HIVE-128). */
  run?: string;
}
