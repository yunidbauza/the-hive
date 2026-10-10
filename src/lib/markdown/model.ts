/**
 * The preview's own model of a markdown document.
 *
 * The preview renders this and never `marked`'s tokens. The token types are a
 * third party's and move between majors; which raw HTML renders and which
 * links navigate are this app's decisions, made once in `lib/markdown/` and
 * carried here as data.
 */

/** The inline tags raw HTML may produce. Attributes are never carried. */
export type InlineTag = 'kbd' | 'sub' | 'sup';

export type MdInline =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; children: MdInline[] }
  | { kind: 'em'; children: MdInline[] }
  | { kind: 'del'; children: MdInline[] }
  | { kind: 'code'; text: string }
  | { kind: 'link'; href: string; children: MdInline[] }
  /** Rendered as a placeholder chip: nothing is fetched. */
  | { kind: 'image'; src: string; alt: string }
  | { kind: 'br' }
  | { kind: 'tag'; tag: InlineTag; children: MdInline[] };

export type MdAlign = 'left' | 'center' | 'right' | null;

export interface MdListItem {
  task: boolean;
  checked: boolean;
  blocks: MdBlock[];
}

/**
 * `line` is the 0-based source line a block starts on. Only top-level blocks
 * carry a precise one; nested blocks share their container's, because split
 * view syncs on top-level blocks.
 */
export type MdBlock =
  | { kind: 'heading'; line: number; depth: number; id: string; children: MdInline[] }
  | { kind: 'paragraph'; line: number; children: MdInline[] }
  | { kind: 'code'; line: number; lang: string; text: string }
  | { kind: 'quote'; line: number; blocks: MdBlock[] }
  | { kind: 'list'; line: number; ordered: boolean; start: number; items: MdListItem[] }
  | {
      kind: 'table';
      line: number;
      align: MdAlign[];
      header: MdInline[][];
      rows: MdInline[][][];
    }
  | { kind: 'hr'; line: number }
  | { kind: 'details'; line: number; open: boolean; summary: MdInline[]; blocks: MdBlock[] }
  /** Raw HTML outside the allowlist, shown as its literal source. */
  | { kind: 'raw'; line: number; text: string };

export interface MdDocument {
  blocks: MdBlock[];
}
