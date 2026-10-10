import { describe, expect, it } from 'vitest';

import { imgAttributes, isInlineTag, scanHtml } from '@lib/markdown/html';

describe('scanHtml', () => {
  it('splits tags, text and comments, lowercasing names', () => {
    expect(scanHtml('<Details open>x<!-- c --></details><br/>')).toEqual([
      { kind: 'open', tag: 'details', attrs: ' open', raw: '<Details open>', selfClosing: false },
      { kind: 'text', text: 'x' },
      { kind: 'comment' },
      { kind: 'close', tag: 'details', raw: '</details>' },
      { kind: 'open', tag: 'br', attrs: '', raw: '<br/>', selfClosing: true },
    ]);
  });

  /*
    The input is an untrusted README, scanned on the renderer's thread. A tag
    pattern whose attribute run and trailing whitespace both match spaces
    backtracks quadratically: 40k spaces took over a second, 200 KB half a
    minute. Each case here is linear now; quadratic would blow the budget.
  */
  it.each([
    ['spaces before a stray character', `<a ${' '.repeat(100_000)}b`],
    ['an unterminated quote', `<a x="${'y'.repeat(100_000)}`],
    ['open angles with no close', '<a '.repeat(30_000)],
  ])('scans %s in linear time', (_label, html) => {
    const started = performance.now();
    scanHtml(html);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('keeps a quoted > inside an attribute', () => {
    expect(scanHtml('<img alt=">" src="a.png">')).toEqual([
      { kind: 'open', tag: 'img', attrs: ' alt=">" src="a.png"', raw: '<img alt=">" src="a.png">', selfClosing: false },
    ]);
  });

  it('reads <br /> as self-closing, and <!--> as a comment', () => {
    expect(scanHtml('<br />')[0]).toMatchObject({ kind: 'open', tag: 'br', selfClosing: true });
    expect(scanHtml('<!-->x<!--->')).toEqual([
      { kind: 'comment' },
      { kind: 'text', text: 'x' },
      { kind: 'comment' },
    ]);
  });

  it('treats a stray < as text', () => {
    expect(scanHtml('a < b')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'text', text: '<' },
      { kind: 'text', text: ' b' },
    ]);
  });
});

describe('isInlineTag', () => {
  it('admits kbd, sub and sup only', () => {
    expect(['kbd', 'sub', 'sup', 'script', 'a', 'img'].map(isInlineTag)).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
    ]);
  });
});

describe('imgAttributes', () => {
  it('reads src and alt and nothing else', () => {
    expect(imgAttributes(' src="a.png" alt=\'A\' onerror="boom()"')).toEqual({
      src: 'a.png',
      alt: 'A',
    });
    expect(imgAttributes(' onerror="x"')).toEqual({ src: '', alt: '' });
  });

  it('reads the real src, not data-src, and unquoted values', () => {
    expect(imgAttributes(' data-src="evil" src="real"')).toEqual({ src: 'real', alt: '' });
    expect(imgAttributes(' src=a.png alt=A')).toEqual({ src: 'a.png', alt: 'A' });
  });
});
