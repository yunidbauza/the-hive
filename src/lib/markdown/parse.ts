import { Lexer, type Token, type Tokens } from 'marked';

import { MAX_HTML_NESTING, hasAttribute, scanHtml } from '@lib/markdown/html';
import { convertInlines, plainText, unescapeHtml } from '@lib/markdown/inline';
import type { MdBlock, MdDocument, MdInline } from '@lib/markdown/model';
import { createSlugger } from '@lib/markdown/slug';

/**
 * Markdown text → {@link MdDocument}.
 *
 * `marked` is imported statically: the PR conversation's renderer
 * (`features/shared/components/markdown.tsx`) already puts it in the main
 * bundle, so a lazy import here saved nothing and only drew a build warning.
 * The function stays async so the preview's loading and failure paths do not
 * depend on that, and a parse that throws (marked overflows its own stack on a
 * few thousand nested quotes) rejects rather than crashing the caller.
 */
export async function parseMarkdown(text: string): Promise<MdDocument> {
  // marked normalises line endings itself; doing it first keeps `raw` findable.
  const source = text.replace(/\r\n?/g, '\n');
  const tokens = Lexer.lex(source, { gfm: true });
  const blocks = convertBlocks(tokens, lineLocator(source));
  assignIds(blocks, createSlugger());
  return { blocks };
}

/** Fills each heading's anchor, in document order, through containers. */
function assignIds(blocks: MdBlock[], slug: (text: string) => string): void {
  for (const block of blocks) {
    if (block.kind === 'heading') block.id = slug(plainText(block.children));
    else if (block.kind === 'quote' || block.kind === 'details') assignIds(block.blocks, slug);
    else if (block.kind === 'list') for (const item of block.items) assignIds(item.blocks, slug);
  }
}

/**
 * Where each top-level token starts, as a 0-based source line.
 *
 * Found by searching for the token's `raw` from a moving cursor, not by summing
 * `raw` lengths: marked consumes a link-reference definition (`[a]: http://x`)
 * without emitting a token, so a running sum drifts by every definition above
 * the block. A `raw` that cannot be found keeps the previous line, which costs
 * sync precision and nothing else.
 */
function lineLocator(source: string): (raw: string) => number {
  let cursor = 0;
  let line = 0;

  const advance = (to: number) => {
    for (let index = cursor; index < to; index += 1) {
      if (source.charCodeAt(index) === 10) line += 1;
    }
    cursor = to;
  };

  return (raw) => {
    const at = source.indexOf(raw, cursor);
    if (at === -1) return line;
    advance(at);
    const start = line;
    advance(at + raw.length);
    return start;
  };
}

interface DetailsFrame {
  line: number;
  open: boolean;
  summary: MdInline[];
  blocks: MdBlock[];
  inSummary: boolean;
}

const closeDetails = (frame: DetailsFrame): MdBlock => ({
  kind: 'details',
  line: frame.line,
  open: frame.open,
  summary: frame.summary,
  blocks: frame.blocks,
});

function convertBlocks(tokens: Token[], at: (raw: string) => number): MdBlock[] {
  const root: MdBlock[] = [];
  /** Open `<details>`; blocks land in the innermost. */
  const stack: DetailsFrame[] = [];
  const push = (block: MdBlock) => (stack.at(-1)?.blocks ?? root).push(block);

  for (const token of tokens) {
    // Every token goes through the locator, `space` included, so the cursor moves.
    const line = at(token.raw);
    if (token.type === 'html') {
      blockHtml(token.raw, line, stack, push);
      continue;
    }
    const block = convertBlock(token, line);
    if (block) push(block);
  }

  // An unclosed <details> still renders what it wrapped.
  for (let frame = stack.pop(); frame; frame = stack.pop()) push(closeDetails(frame));
  return root;
}

/**
 * One block of raw HTML: `<details>`/`<summary>` structure is consumed, and
 * everything else accumulates as literal text and becomes one `raw` block.
 */
function blockHtml(
  raw: string,
  line: number,
  stack: DetailsFrame[],
  push: (block: MdBlock) => void,
): void {
  let literal = '';
  const flush = () => {
    const text = literal.trim();
    if (text !== '') push({ kind: 'raw', line, text });
    literal = '';
  };

  for (const piece of scanHtml(raw)) {
    const frame = stack.at(-1);
    if (piece.kind === 'comment') continue;
    if (piece.kind === 'open' && piece.tag === 'details' && stack.length < MAX_HTML_NESTING) {
      flush();
      stack.push({
        line,
        open: hasAttribute(piece.attrs, 'open'),
        summary: [],
        blocks: [],
        inSummary: false,
      });
    } else if (piece.kind === 'close' && piece.tag === 'details' && frame) {
      flush();
      stack.pop();
      push(closeDetails(frame));
    } else if (piece.kind === 'open' && piece.tag === 'summary' && frame) {
      flush();
      frame.inSummary = true;
    } else if (piece.kind === 'close' && piece.tag === 'summary' && frame) {
      frame.inSummary = false;
    } else {
      const text = piece.kind === 'text' ? piece.text : piece.raw;
      // Summary text is HTML source, so `&amp;` means `&`; tags in it stay literal.
      if (frame?.inSummary) {
        frame.summary.push({ kind: 'text', text: piece.kind === 'text' ? unescapeHtml(text) : text });
      }
      else literal += text;
    }
  }
  flush();
}

function convertBlock(token: Token, line: number): MdBlock | null {
  switch (token.type) {
    case 'heading': {
      const heading = token as Tokens.Heading;
      return {
        kind: 'heading',
        line,
        depth: heading.depth,
        id: '',
        children: convertInlines(heading.tokens),
      };
    }
    case 'paragraph':
      return {
        kind: 'paragraph',
        line,
        children: convertInlines((token as Tokens.Paragraph).tokens),
      };
    case 'text': {
      // A list item's body, and stray top-level text.
      const text = token as Tokens.Text;
      return {
        kind: 'paragraph',
        line,
        children: text.tokens
          ? convertInlines(text.tokens)
          : [{ kind: 'text', text: unescapeHtml(text.text) }],
      };
    }
    case 'code': {
      const code = token as Tokens.Code;
      // The info string's first word: ```ts title="x" is TypeScript.
      return {
        kind: 'code',
        line,
        lang: (code.lang ?? '').trim().split(/\s+/)[0] ?? '',
        text: code.text,
      };
    }
    case 'blockquote':
      return {
        kind: 'quote',
        line,
        blocks: convertBlocks((token as Tokens.Blockquote).tokens, () => line),
      };
    case 'list': {
      const list = token as Tokens.List;
      return {
        kind: 'list',
        line,
        ordered: list.ordered,
        start: typeof list.start === 'number' ? list.start : 1,
        items: list.items.map((item) => ({
          task: item.task,
          checked: item.checked ?? false,
          blocks: convertBlocks(item.tokens, () => line),
        })),
      };
    }
    case 'table': {
      const table = token as Tokens.Table;
      return {
        kind: 'table',
        line,
        align: table.align,
        header: table.header.map((cell) => convertInlines(cell.tokens)),
        rows: table.rows.map((row) => row.map((cell) => convertInlines(cell.tokens))),
      };
    }
    case 'hr':
      return { kind: 'hr', line };
    default:
      // `space`, and the kinds later tasks add.
      return null;
  }
}
