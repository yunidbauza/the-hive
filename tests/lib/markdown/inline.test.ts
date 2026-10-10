import { Lexer, type Tokens } from 'marked';
import { describe, expect, it } from 'vitest';

import { MAX_HTML_NESTING } from '@lib/markdown/html';
import { convertInlines, plainText } from '@lib/markdown/inline';
import type { MdInline } from '@lib/markdown/model';

/** The inline nodes of a one-paragraph document. */
const inlinesOf = (source: string) =>
  convertInlines((Lexer.lex(source, { gfm: true })[0] as Tokens.Paragraph).tokens);

describe('convertInlines', () => {
  /*
    marked HTML-escapes inline text for its own renderer. React escapes on its
    own, so text that stayed escaped would render as a literal `&amp;`.
  */
  it('unescapes the text marked escaped', () => {
    expect(inlinesOf('a & b < c "q"')).toEqual([{ kind: 'text', text: 'a & b < c "q"' }]);
  });

  it('maps strong, emphasis and strikethrough', () => {
    expect(inlinesOf('**b** *i* ~~s~~')).toEqual([
      { kind: 'strong', children: [{ kind: 'text', text: 'b' }] },
      { kind: 'text', text: ' ' },
      { kind: 'em', children: [{ kind: 'text', text: 'i' }] },
      { kind: 'text', text: ' ' },
      { kind: 'del', children: [{ kind: 'text', text: 's' }] },
    ]);
  });

  it('unescapes inline code', () => {
    expect(inlinesOf('`<x> & y`')).toEqual([{ kind: 'code', text: '<x> & y' }]);
  });

  it('keeps a link’s href as written', () => {
    expect(inlinesOf('[l](a%20b.md)')).toEqual([
      { kind: 'link', href: 'a%20b.md', children: [{ kind: 'text', text: 'l' }] },
    ]);
  });

  it('turns a bare URL into a link', () => {
    expect(inlinesOf('see https://ex.com')[1]).toEqual({
      kind: 'link',
      href: 'https://ex.com',
      children: [{ kind: 'text', text: 'https://ex.com' }],
    });
  });

  it('keeps an image as source and alt, never a fetch', () => {
    expect(inlinesOf('![alt](p.png)')).toEqual([{ kind: 'image', src: 'p.png', alt: 'alt' }]);
  });

  it('maps a hard break and an escape', () => {
    expect(inlinesOf('a  \nb')).toEqual([
      { kind: 'text', text: 'a' },
      { kind: 'br' },
      { kind: 'text', text: 'b' },
    ]);
    expect(inlinesOf('\\<')).toEqual([{ kind: 'text', text: '<' }]);
  });
});

describe('plainText', () => {
  it('flattens nodes to the text a heading anchor is made from', () => {
    expect(plainText(inlinesOf('Héllo **&** `code` ![pic](p.png)'))).toBe('Héllo & code pic');
  });
});

describe('convertInlines — raw HTML', () => {
  it('renders kbd, sub and sup as themselves', () => {
    expect(inlinesOf('x <kbd>K</kbd> y')).toEqual([
      { kind: 'text', text: 'x ' },
      { kind: 'tag', tag: 'kbd', children: [{ kind: 'text', text: 'K' }] },
      { kind: 'text', text: ' y' },
    ]);
    expect(inlinesOf('H<sub>2</sub>O')[1]).toEqual({
      kind: 'tag',
      tag: 'sub',
      children: [{ kind: 'text', text: '2' }],
    });
  });

  it('maps <br> in either spelling', () => {
    expect(inlinesOf('a<br>b')[1]).toEqual({ kind: 'br' });
    expect(inlinesOf('a<br/>b')[1]).toEqual({ kind: 'br' });
  });

  it('turns <img> into a placeholder, dropping every other attribute', () => {
    expect(inlinesOf('x <img src="a.png" alt="A" onerror="boom()"> y')[1]).toEqual({
      kind: 'image',
      src: 'a.png',
      alt: 'A',
    });
  });

  it('shows any other tag as its own text', () => {
    expect(inlinesOf('x <script>alert(1)</script> y')).toEqual([
      { kind: 'text', text: 'x ' },
      { kind: 'text', text: '<script>' },
      { kind: 'text', text: 'alert(1)' },
      { kind: 'text', text: '</script>' },
      { kind: 'text', text: ' y' },
    ]);
    expect(inlinesOf('x <a href="javascript:alert(1)">t</a>')[1]).toEqual({
      kind: 'text',
      text: '<a href="javascript:alert(1)">',
    });
  });

  it('drops comments', () => {
    expect(inlinesOf('x <!-- c --> y')).toEqual([
      { kind: 'text', text: 'x ' },
      { kind: 'text', text: ' y' },
    ]);
  });

  it('closes an unclosed tag at the end, and shows an unmatched close as text', () => {
    expect(inlinesOf('x <kbd>K y')[1]).toEqual({
      kind: 'tag',
      tag: 'kbd',
      children: [{ kind: 'text', text: 'K y' }],
    });
    expect(inlinesOf('x </kbd> y')[1]).toEqual({ kind: 'text', text: '</kbd>' });
  });

  it('closes mismatched nesting into allowlisted nodes only', () => {
    expect(inlinesOf('<kbd><sub>x</kbd> y')).toEqual([
      {
        kind: 'tag',
        tag: 'kbd',
        children: [
          {
            kind: 'tag',
            tag: 'sub',
            children: [
              { kind: 'text', text: 'x' },
              { kind: 'text', text: '</kbd>' },
              { kind: 'text', text: ' y' },
            ],
          },
        ],
      },
    ]);
  });

  it('drops an allowed tag’s attributes, reads it in any case, and leaves <kbd/> as text', () => {
    expect(inlinesOf('x <KBD onclick="boom()">K</KBD>')[1]).toEqual({
      kind: 'tag',
      tag: 'kbd',
      children: [{ kind: 'text', text: 'K' }],
    });
    expect(inlinesOf('x <kbd/> y')[1]).toEqual({ kind: 'text', text: '<kbd/>' });
  });

  it('shows an inline <iframe> as text', () => {
    expect(inlinesOf('x <iframe src="https://evil.example"></iframe>')[1]).toEqual({
      kind: 'text',
      text: '<iframe src="https://evil.example">',
    });
  });

  /*
    The preview renders the model recursively; 5000 nested <kbd> overflowed
    React's stack and, with no error boundary, would blank the app. Past the
    cap an opening tag is shown as its own text instead.
  */
  it('caps tag nesting, keeping the rest as text', () => {
    const depthOf = (nodes: MdInline[]): number =>
      Math.max(0, ...nodes.map((node) => (node.kind === 'tag' ? 1 + depthOf(node.children) : 0)));
    const nodes = inlinesOf(`x ${'<kbd>'.repeat(5000)}y`);
    expect(depthOf(nodes)).toBe(MAX_HTML_NESTING);
  });
});
