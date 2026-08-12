// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { adfToBlocks } from '../../../../../../electron/main/integrations/jira/adf/adf-to-blocks';
import { convertMarkdown } from '../../../../../../electron/main/integrations/jira/adf/markdown-to-adf';

/**
 * ADF back to displayable blocks (HIVE-71).
 *
 * The two properties worth pinning:
 *
 * 1. **An unrecognised node renders as text, never as nothing.** A comment
 *    containing a Jira panel macro is still a comment the user needs to read.
 * 2. **No markup crosses.** The output is text and mark *names*; there is
 *    nothing here a renderer could inject, which is what keeps every Jira
 *    project this app can read from being a path into the app.
 */

const doc = (content: unknown[]): unknown => ({
  type: 'doc',
  version: 1,
  content,
});

const para = (text: string): unknown => ({
  type: 'paragraph',
  content: [{ type: 'text', text }],
});

describe('the document', () => {
  it('answers an empty list for anything that is not one', () => {
    for (const bad of [null, undefined, 'doc', 42, {}, { content: 'x' }]) {
      expect(adfToBlocks(bad)).toEqual([]);
    }
  });

  it('never throws, whatever it is handed', () => {
    const nasty = [
      doc([null]),
      doc([{ type: 'paragraph', content: 'nope' }]),
      doc([{ type: 'text' }]),
      JSON.parse('{"type":"doc","version":1,"content":[{"__proto__":{}}]}'),
    ];
    for (const value of nasty) {
      expect(() => adfToBlocks(value)).not.toThrow();
    }
  });
});

describe('blocks', () => {
  it('maps a paragraph', () => {
    expect(adfToBlocks(doc([para('hello')]))).toEqual([
      { kind: 'paragraph', runs: [{ text: 'hello', marks: [] }] },
    ]);
  });

  it('maps a heading with a clamped level', () => {
    const blocks = adfToBlocks(
      doc([
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'h' }] },
        { type: 'heading', attrs: { level: 99 }, content: [{ type: 'text', text: 'x' }] },
      ]),
    );
    expect(blocks[0]?.level).toBe(3);
    // Clamped rather than trusted: a level of 99 would style as nothing.
    expect(blocks[1]?.level).toBe(6);
  });

  it('maps a code block, keeping its language', () => {
    expect(
      adfToBlocks(
        doc([
          {
            type: 'codeBlock',
            attrs: { language: 'ts' },
            content: [{ type: 'text', text: 'const a = 1;\n' }],
          },
        ]),
      ),
    ).toEqual([
      {
        kind: 'code',
        language: 'ts',
        runs: [{ text: 'const a = 1;\n', marks: [] }],
      },
    ]);
  });

  it('maps a rule and a quote', () => {
    expect(adfToBlocks(doc([{ type: 'rule' }]))[0]?.kind).toBe('rule');
    expect(
      adfToBlocks(doc([{ type: 'blockquote', content: [para('q')] }]))[0],
    ).toEqual({ kind: 'quote', runs: [{ text: 'q', marks: [] }] });
  });
});

describe('lists', () => {
  it('flattens a bullet list into one block per item', () => {
    const blocks = adfToBlocks(
      doc([
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [para('a')] },
            { type: 'listItem', content: [para('b')] },
          ],
        },
      ]),
    );

    expect(blocks).toHaveLength(2);
    expect(blocks.every((block) => block.kind === 'bullet')).toBe(true);
    expect(blocks.every((block) => block.depth === 0)).toBe(true);
  });

  it('records nesting depth so the renderer can indent', () => {
    const blocks = adfToBlocks(
      doc([
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                para('outer'),
                {
                  type: 'bulletList',
                  content: [{ type: 'listItem', content: [para('inner')] }],
                },
              ],
            },
          ],
        },
      ]),
    );

    expect(blocks.map((block) => [block.runs[0]?.text, block.depth])).toEqual([
      ['outer', 0],
      ['inner', 1],
    ]);
  });

  it('keeps ordered separate from bullet', () => {
    const blocks = adfToBlocks(
      doc([
        {
          type: 'orderedList',
          content: [{ type: 'listItem', content: [para('one')] }],
        },
      ]),
    );
    expect(blocks[0]?.kind).toBe('ordered');
  });
});

describe('runs', () => {
  it('carries the marks the app renders', () => {
    const blocks = adfToBlocks(
      doc([
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'b', marks: [{ type: 'strong' }] },
            { type: 'text', text: 'i', marks: [{ type: 'em' }] },
            { type: 'text', text: 'c', marks: [{ type: 'code' }] },
            { type: 'text', text: 's', marks: [{ type: 'strike' }] },
          ],
        },
      ]),
    );

    expect(blocks[0]?.runs.map((run) => run.marks)).toEqual([
      ['strong'],
      ['em'],
      ['code'],
      ['strike'],
    ]);
  });

  it('drops a mark the app does not render, keeping the text', () => {
    const blocks = adfToBlocks(
      doc([
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'x', marks: [{ type: 'textColor' }] },
          ],
        },
      ]),
    );

    // The text survives; the unknown mark is dropped rather than passed through
    // to a renderer that would not know what to do with it.
    expect(blocks[0]?.runs).toEqual([{ text: 'x', marks: [] }]);
  });

  it('turns a link mark into an href on the run', () => {
    const blocks = adfToBlocks(
      doc([
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'docs',
              marks: [
                { type: 'link', attrs: { href: 'https://example.invalid' } },
              ],
            },
          ],
        },
      ]),
    );

    expect(blocks[0]?.runs[0]).toEqual({
      text: 'docs',
      marks: [],
      href: 'https://example.invalid',
    });
  });

  it('renders a hard break as a newline run', () => {
    const blocks = adfToBlocks(
      doc([
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'a' },
            { type: 'hardBreak' },
            { type: 'text', text: 'b' },
          ],
        },
      ]),
    );

    expect(blocks[0]?.runs.map((run) => run.text)).toEqual(['a', '\n', 'b']);
  });
});

describe('an unrecognised node renders as text', () => {
  it('flattens a panel rather than dropping it', () => {
    const blocks = adfToBlocks(
      doc([
        {
          type: 'panel',
          attrs: { panelType: 'info' },
          content: [para('Deploy is frozen until Monday.')],
        },
      ]),
    );

    // Losing this because somebody used a Jira macro would be the worse failure
    // by far — a comment the app cannot fully render is still one to read.
    expect(blocks).toEqual([
      {
        kind: 'unknown',
        runs: [{ text: 'Deploy is frozen until Monday.', marks: [] }],
      },
    ]);
  });

  it('contributes nothing when there is no text under it', () => {
    expect(adfToBlocks(doc([{ type: 'mediaGroup', content: [] }]))).toEqual([]);
  });
});

describe('the round trip', () => {
  it('survives markdown → ADF → blocks with its text intact', () => {
    const markdown =
      '# Title\n\nSome **bold** and a [link](https://example.invalid).\n\n- one\n- two';
    const blocks = adfToBlocks(convertMarkdown(markdown));

    const text = blocks
      .flatMap((block) => block.runs.map((run) => run.text))
      .join(' ');

    expect(text).toContain('Title');
    expect(text).toContain('bold');
    expect(text).toContain('link');
    expect(text).toContain('one');
    expect(text).toContain('two');
    expect(blocks.some((block) => block.kind === 'heading')).toBe(true);
    expect(blocks.some((block) => block.kind === 'bullet')).toBe(true);
  });
});
