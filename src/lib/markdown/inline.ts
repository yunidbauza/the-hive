import type { Token, Tokens } from 'marked';

import { MAX_HTML_NESTING, imgAttributes, isInlineTag, scanHtml } from '@lib/markdown/html';
import type { InlineTag, MdInline } from '@lib/markdown/model';

/**
 * marked's inline tokens → {@link MdInline}.
 *
 * marked escapes inline `text`, `codespan` and `escape` tokens because its own
 * renderer writes HTML strings. This app renders React elements, which escape
 * on their own, so the text is unescaped here — otherwise `a & b` would show
 * as `a &amp; b`.
 */

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};

export const unescapeHtml = (text: string): string =>
  text.replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity] ?? entity);

interface Frame {
  tag: InlineTag;
  children: MdInline[];
}

export function convertInlines(tokens: Token[] | undefined): MdInline[] {
  const root: MdInline[] = [];
  /** Open `<kbd>`/`<sub>`/`<sup>`; nodes land in the innermost. */
  const stack: Frame[] = [];
  const push = (node: MdInline) => (stack.at(-1)?.children ?? root).push(node);
  const closeTop = () => {
    const frame = stack.pop();
    if (frame) push({ kind: 'tag', tag: frame.tag, children: frame.children });
  };

  for (const token of tokens ?? []) {
    if (token.type === 'html') {
      for (const piece of scanHtml(token.raw)) {
        if (piece.kind === 'comment') continue;
        if (piece.kind === 'open' && piece.tag === 'br') push({ kind: 'br' });
        else if (piece.kind === 'open' && piece.tag === 'img') {
          push({ kind: 'image', ...imgAttributes(piece.attrs) });
        } else if (
          piece.kind === 'open' &&
          isInlineTag(piece.tag) &&
          !piece.selfClosing &&
          stack.length < MAX_HTML_NESTING
        ) {
          stack.push({ tag: piece.tag, children: [] });
        } else if (piece.kind === 'close' && stack.at(-1)?.tag === piece.tag) closeTop();
        else push({ kind: 'text', text: piece.kind === 'text' ? piece.text : piece.raw });
      }
      continue;
    }
    for (const node of convertInline(token)) push(node);
  }

  // An unclosed tag still renders what it wrapped.
  while (stack.length > 0) closeTop();
  return root;
}

function convertInline(token: Token): MdInline[] {
  switch (token.type) {
    case 'text': {
      const text = token as Tokens.Text;
      // A tight list item's text nests its own inline tokens.
      return text.tokens
        ? convertInlines(text.tokens)
        : [{ kind: 'text', text: unescapeHtml(text.text) }];
    }
    case 'escape':
      return [{ kind: 'text', text: unescapeHtml((token as Tokens.Escape).text) }];
    case 'strong':
      return [{ kind: 'strong', children: convertInlines((token as Tokens.Strong).tokens) }];
    case 'em':
      return [{ kind: 'em', children: convertInlines((token as Tokens.Em).tokens) }];
    case 'del':
      return [{ kind: 'del', children: convertInlines((token as Tokens.Del).tokens) }];
    case 'codespan':
      return [{ kind: 'code', text: unescapeHtml((token as Tokens.Codespan).text) }];
    case 'br':
      return [{ kind: 'br' }];
    case 'link': {
      const link = token as Tokens.Link;
      return [{ kind: 'link', href: link.href, children: convertInlines(link.tokens) }];
    }
    case 'image': {
      const image = token as Tokens.Image;
      return [{ kind: 'image', src: image.href, alt: image.text }];
    }
    default:
      // Anything this model has no node for shows its own source.
      return [{ kind: 'text', text: token.raw }];
  }
}

/** The text of some inline nodes, for a heading's anchor. */
export function plainText(nodes: MdInline[]): string {
  return nodes
    .map((node) => {
      switch (node.kind) {
        case 'text':
        case 'code':
          return node.text;
        case 'image':
          return node.alt;
        case 'br':
          return ' ';
        default:
          return plainText(node.children);
      }
    })
    .join('');
}
