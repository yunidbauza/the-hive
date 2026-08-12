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
}
