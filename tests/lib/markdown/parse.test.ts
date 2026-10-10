import { describe, expect, it } from 'vitest';

import { MAX_HTML_NESTING } from '@lib/markdown/html';
import type { MdBlock } from '@lib/markdown/model';
import { parseMarkdown } from '@lib/markdown/parse';

describe('parseMarkdown', () => {
  it('maps headings, paragraphs, fences and rules with their source lines', async () => {
    const { blocks } = await parseMarkdown(
      '# Title\n\nPara\n\n```ts title\nconst a = 1;\n```\n\n---\n',
    );

    expect(blocks).toEqual([
      {
        kind: 'heading',
        line: 0,
        depth: 1,
        id: expect.any(String),
        children: [{ kind: 'text', text: 'Title' }],
      },
      { kind: 'paragraph', line: 2, children: [{ kind: 'text', text: 'Para' }] },
      { kind: 'code', line: 4, lang: 'ts', text: 'const a = 1;' },
      { kind: 'hr', line: 8 },
    ]);
  });

  /*
    marked consumes a link-reference definition without emitting a token, so a
    running sum of `raw` lengths would put every later block two lines early.
  */
  it('keeps lines true below a link-reference definition', async () => {
    const { blocks } = await parseMarkdown('[a]: http://x\n\n# H\n\npara\n');
    expect(blocks.map((block) => block.line)).toEqual([2, 4]);
  });

  it('counts CRLF documents by line, not by byte', async () => {
    const { blocks } = await parseMarkdown('# A\r\n\r\nb\r\n');
    expect(blocks.map((block) => block.line)).toEqual([0, 2]);
  });

  it('maps lists, task items and ordered starts', async () => {
    const [bullets] = (await parseMarkdown('- a\n- b\n')).blocks;
    expect(bullets).toMatchObject({
      kind: 'list',
      ordered: false,
      start: 1,
      items: [{ task: false }, { task: false }],
    });

    const [ordered] = (await parseMarkdown('3. a\n4. b\n')).blocks;
    expect(ordered).toMatchObject({ kind: 'list', ordered: true, start: 3 });

    const [tasks] = (await parseMarkdown('- [x] done\n- [ ] todo\n')).blocks;
    expect(tasks).toMatchObject({
      kind: 'list',
      items: [
        {
          task: true,
          checked: true,
          blocks: [{ kind: 'paragraph', children: [{ kind: 'text', text: 'done' }] }],
        },
        { task: true, checked: false },
      ],
    });
  });

  it('maps a quote with its own blocks', async () => {
    const [quote] = (await parseMarkdown('> q\n')).blocks;
    expect(quote).toEqual({
      kind: 'quote',
      line: 0,
      blocks: [{ kind: 'paragraph', line: 0, children: [{ kind: 'text', text: 'q' }] }],
    });
  });

  it('maps a table with alignment and inline cells', async () => {
    const [table] = (await parseMarkdown('| a | b | c |\n|:-|:-:|-:|\n| `c` | d | e |\n')).blocks;
    expect(table).toEqual({
      kind: 'table',
      line: 0,
      align: ['left', 'center', 'right'],
      header: [
        [{ kind: 'text', text: 'a' }],
        [{ kind: 'text', text: 'b' }],
        [{ kind: 'text', text: 'c' }],
      ],
      rows: [
        [[{ kind: 'code', text: 'c' }], [{ kind: 'text', text: 'd' }], [{ kind: 'text', text: 'e' }]],
      ],
    });
  });

  it('gives every heading a unique anchor, nested ones included', async () => {
    const { blocks } = await parseMarkdown('# Intro\n\n> ## Intro\n\n- ## Intro\n');
    const ids = [
      blocks[0],
      blocks[1]?.kind === 'quote' ? blocks[1].blocks[0] : null,
      blocks[2]?.kind === 'list' ? blocks[2].items[0]?.blocks[0] : null,
    ].map((block) => (block?.kind === 'heading' ? block.id : null));
    expect(ids).toEqual(['intro', 'intro-1', 'intro-2']);
  });

  /*
    A blank line inside <details> splits it into three block tokens: the
    opening HTML, the markdown body, and the closing HTML. The converter pairs
    them so the body renders as markdown inside the disclosure.
  */
  it('pairs <details> across the blocks between its tags', async () => {
    const { blocks } = await parseMarkdown(
      '<details>\n<summary>S</summary>\n\nbody\n</details>\n\nafter\n',
    );
    expect(blocks).toEqual([
      {
        kind: 'details',
        line: 0,
        open: false,
        summary: [{ kind: 'text', text: 'S' }],
        blocks: [{ kind: 'paragraph', line: 3, children: [{ kind: 'text', text: 'body' }] }],
      },
      { kind: 'paragraph', line: 6, children: [{ kind: 'text', text: 'after' }] },
    ]);
  });

  it('honours open, and closes an unclosed <details> at the end', async () => {
    const [details] = (await parseMarkdown('<details open><summary>S</summary>\n\nbody\n')).blocks;
    expect(details).toMatchObject({
      kind: 'details',
      open: true,
      blocks: [{ kind: 'paragraph' }],
    });
  });

  it('shows any other block HTML as its literal source', async () => {
    expect((await parseMarkdown('<script>alert(1)</script>\n')).blocks).toEqual([
      { kind: 'raw', line: 0, text: '<script>alert(1)</script>' },
    ]);
    expect((await parseMarkdown('<div align="center">\n\nhi\n\n</div>\n')).blocks).toEqual([
      { kind: 'raw', line: 0, text: '<div align="center">' },
      { kind: 'paragraph', line: 2, children: [{ kind: 'text', text: 'hi' }] },
      { kind: 'raw', line: 4, text: '</div>' },
    ]);
  });

  it('drops an HTML comment block', async () => {
    expect((await parseMarkdown('<!-- note -->\n\nx\n')).blocks).toEqual([
      { kind: 'paragraph', line: 2, children: [{ kind: 'text', text: 'x' }] },
    ]);
  });

  /*
    Each container pairs its own tags: a </details> inside a list item cannot
    close a disclosure opened at the top level, so `after` stays inside it.
  */
  it('pairs <details> only within one container', async () => {
    const { blocks } = await parseMarkdown('<details>\n\n- x\n\n  </details>\n\nafter\n');
    expect(blocks).toHaveLength(1);
    const [details] = blocks;
    expect(details).toMatchObject({
      kind: 'details',
      blocks: [
        {
          kind: 'list',
          items: [
            {
              blocks: [
                { kind: 'paragraph', children: [{ kind: 'text', text: 'x' }] },
                { kind: 'raw', text: '</details>' },
              ],
            },
          ],
        },
        { kind: 'paragraph', children: [{ kind: 'text', text: 'after' }] },
      ],
    });
  });

  it('shows a stray </details> as its source', async () => {
    expect((await parseMarkdown('</details>\n')).blocks).toEqual([
      { kind: 'raw', line: 0, text: '</details>' },
    ]);
  });

  it('keeps tags inside a summary as text, and unescapes its entities', async () => {
    const [details] = (
      await parseMarkdown('<details><summary><b>Q &amp; A</b></summary>\n\nbody\n</details>\n')
    ).blocks;
    expect(details).toMatchObject({
      kind: 'details',
      summary: [
        { kind: 'text', text: '<b>' },
        { kind: 'text', text: 'Q & A' },
        { kind: 'text', text: '</b>' },
      ],
    });
  });

  it('opens only on an `open` attribute, not on one that merely contains the word', async () => {
    const [closed] = (await parseMarkdown('<details data-open title="open me">\n<summary>S</summary>\n\nx\n</details>\n')).blocks;
    expect(closed).toMatchObject({ kind: 'details', open: false });
    const [open] = (await parseMarkdown('<details open="">\n<summary>S</summary>\n\nx\n</details>\n')).blocks;
    expect(open).toMatchObject({ kind: 'details', open: true });
  });

  it('caps <details> nesting, keeping the rest as source text', async () => {
    const depthOf = (blocks: MdBlock[]): number =>
      Math.max(0, ...blocks.map((block) => (block.kind === 'details' ? 1 + depthOf(block.blocks) : 0)));
    const { blocks } = await parseMarkdown(`${'<details>\n\n'.repeat(200)}x\n`);
    expect(depthOf(blocks)).toBe(MAX_HTML_NESTING);
  });
});
