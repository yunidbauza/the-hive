/**
 * Ambient types for the vendored `marked` bundle (HIVE-71).
 *
 * `marked.esm.mjs` is copied verbatim from upstream (13.0.3) and ships no
 * declarations, so this describes **only the surface this app uses** —
 * `marked.lexer`, and the token fields `markdown-to-adf.ts` reads. Declaring
 * the whole library would be a second, worse copy of upstream's own types with
 * nothing keeping it honest.
 *
 * Named `.d.mts` rather than `.d.ts` because the import specifier ends in
 * `.mjs`, and that is the sibling declaration TypeScript looks for.
 *
 * Every field is optional on purpose. This is a hand-written description of
 * someone else's runtime output, and the converter treats a missing field as
 * absent rather than trusting the shape.
 */

export interface MarkedToken {
  type: string;
  /** Present on most leaf tokens. */
  text?: string;
  /** Nested inline or block tokens. */
  tokens?: MarkedToken[];
  /** `heading`. */
  depth?: number;
  /** `link`. */
  href?: string;
  /** `code`. */
  lang?: string;
  /** `list`. */
  ordered?: boolean;
  items?: MarkedListItem[];
  /** `table`. */
  header?: MarkedTableCell[];
  rows?: MarkedTableCell[][];
}

export interface MarkedListItem {
  task?: boolean;
  checked?: boolean;
  tokens?: MarkedToken[];
}

export interface MarkedTableCell {
  tokens?: MarkedToken[];
}

export declare const marked: {
  lexer(source: string): MarkedToken[];
};
