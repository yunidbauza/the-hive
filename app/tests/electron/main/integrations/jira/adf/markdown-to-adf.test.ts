// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { convertMarkdown } from '../../../../../../electron/main/integrations/jira/adf/markdown-to-adf';
import { validateAdf } from '../../../../../../electron/main/integrations/jira/adf/adf-validate';
import type { AdfNode } from '../../../../../../electron/shared/jira-contract';

/**
 * The markdown → ADF converter (HIVE-71).
 *
 * Ported from `jira-writer`'s own tests, which are node scripts vitest does not
 * run — so "keeps its own tests" means these, not a copied runner.
 *
 * Every rule under test is one Jira enforces silently: a document that breaks
 * it comes back as a 400 naming nothing. The round-trip through `validateAdf`
 * at the end of most cases is deliberate — the converter's output must satisfy
 * the validator that guards the write path, or one of them is wrong.
 */

const blocks = (md: string): AdfNode[] => convertMarkdown(md).content;
const first = (md: string): AdfNode => blocks(md)[0] as AdfNode;

describe('the document shape', () => {
  it('is a doc, version 1', () => {
    expect(convertMarkdown('hello')).toEqual({
      type: 'doc',
      version: 1,
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'hello' }] },
      ],
    });
  });

  it('produces an empty document from empty input', () => {
    expect(convertMarkdown('')).toEqual({
      type: 'doc',
      version: 1,
      content: [],
    });
  });

  it('drops blank lines rather than emitting empty paragraphs', () => {
    // An empty paragraph is a visible gap in the rendered comment.
    expect(blocks('a\n\n\n\nb')).toHaveLength(2);
  });
});

describe('inline marks', () => {
  it('carries strong, em and strike', () => {
    expect(first('**bold** *it* ~~gone~~').content).toEqual([
      { type: 'text', text: 'bold', marks: [{ type: 'strong' }] },
      { type: 'text', text: ' ' },
      { type: 'text', text: 'it', marks: [{ type: 'em' }] },
      { type: 'text', text: ' ' },
      { type: 'text', text: 'gone', marks: [{ type: 'strike' }] },
    ]);
  });

  it('carries a link as a mark, not a node', () => {
    expect(first('[docs](https://example.invalid)').content).toEqual([
      {
        type: 'text',
        text: 'docs',
        marks: [{ type: 'link', attrs: { href: 'https://example.invalid' } }],
      },
    ]);
  });

  it('nests strong inside em', () => {
    const runs = first('*a **b***').content ?? [];
    const both = runs.find((run) => (run.marks?.length ?? 0) > 1);
    expect(both?.marks?.map((m) => m.type).sort()).toEqual(['em', 'strong']);
  });

  /**
   * ADF's `code` mark is exclusive. Jira rejects the whole document rather than
   * dropping the extra mark, so the converter resolves it here.
   */
  it('drops a competing mark when code is already present', () => {
    const runs = first('**`bold code`**').content ?? [];
    for (const run of runs) {
      const types = run.marks?.map((m) => m.type) ?? [];
      if (types.includes('code')) expect(types).toEqual(['code']);
    }
    expect(validateAdf(convertMarkdown('**`bold code`**')).ok).toBe(true);
  });

  it('clears existing marks when code arrives', () => {
    const doc = convertMarkdown('[`linked code`](https://example.invalid)');
    expect(validateAdf(doc).ok).toBe(true);
  });

  it('unescapes the entities marked introduces', () => {
    expect(first('a < b & c > d').content?.[0]?.text).toBe('a < b & c > d');
  });

  it('turns a hard break into a hardBreak node', () => {
    const runs = first('one  \ntwo').content ?? [];
    expect(runs.some((run) => run.type === 'hardBreak')).toBe(true);
  });
});

describe('blocks', () => {
  it('maps headings with their level', () => {
    expect(first('### three')).toEqual({
      type: 'heading',
      attrs: { level: 3 },
      content: [{ type: 'text', text: 'three' }],
    });
  });

  it('maps a fenced code block, keeping its language', () => {
    expect(first('```ts\nconst a = 1;\n```')).toEqual({
      type: 'codeBlock',
      attrs: { language: 'ts' },
      content: [{ type: 'text', text: 'const a = 1;\n' }],
    });
  });

  it('omits attrs entirely for an unlabelled fence', () => {
    // `language: null` is rejected; the key must be absent, not empty.
    const node = first('```\nplain\n```');
    expect(node.attrs).toBeUndefined();
  });

  it('ensures a code block ends with a newline', () => {
    expect(first('```\nno trailing\n```').content?.[0]?.text).toBe(
      'no trailing\n',
    );
  });

  it('maps a bullet list and an ordered list', () => {
    expect(first('- a\n- b').type).toBe('bulletList');
    expect(first('1. a\n2. b').type).toBe('orderedList');
    expect(first('- a\n- b').content).toHaveLength(2);
  });

  it('maps a blockquote', () => {
    expect(first('> quoted').type).toBe('blockquote');
  });

  it('maps a horizontal rule', () => {
    expect(first('---')).toEqual({ type: 'rule' });
  });

  it('maps a table with its canonical attrs', () => {
    const table = first('| a | b |\n| --- | --- |\n| 1 | 2 |');
    expect(table.type).toBe('table');
    expect(table.attrs).toEqual({
      isNumberColumnEnabled: false,
      layout: 'default',
    });
    expect(table.content?.[0]?.content?.[0]?.type).toBe('tableHeader');
    // Required, and may be empty. Jira rejects a cell without it.
    expect(table.content?.[0]?.content?.[0]?.attrs).toEqual({});
  });
});

describe('task lists', () => {
  it('maps checkboxes to a taskList with localIds', () => {
    const list = first('- [ ] todo\n- [x] done');
    expect(list.type).toBe('taskList');
    expect(typeof list.attrs?.localId).toBe('string');
    expect(list.content?.[0]?.attrs?.state).toBe('TODO');
    expect(list.content?.[1]?.attrs?.state).toBe('DONE');
    expect(typeof list.content?.[0]?.attrs?.localId).toBe('string');
  });

  it('gives every task item a distinct localId', () => {
    const list = first('- [ ] a\n- [ ] b');
    const ids = list.content?.map((item) => item.attrs?.localId);
    expect(new Set(ids).size).toBe(2);
  });

  it('falls back to a bullet list when the items are mixed', () => {
    // A taskList would force the plain item into a checkbox it never had.
    expect(first('- [ ] task\n- plain').type).toBe('bulletList');
  });

  it('validates', () => {
    expect(validateAdf(convertMarkdown('- [ ] a\n- [x] b')).ok).toBe(true);
  });
});

describe('what the converter produces always validates', () => {
  const documents = [
    '# Title\n\nSome **bold** and a [link](https://example.invalid).',
    '- one\n- two\n  - nested\n\n1. first\n2. second',
    '```json\n{"a": 1}\n```',
    '> quoted **text**\n\n---\n\n| a | b |\n| --- | --- |\n| 1 | 2 |',
    '- [ ] unchecked\n- [x] checked',
    'Inline `code` beside **bold** and *em*.',
  ];

  for (const [index, markdown] of documents.entries()) {
    it(`document ${index + 1}`, () => {
      const validation = validateAdf(convertMarkdown(markdown));
      // If this ever fails, one of the two ported modules is wrong about a rule
      // Jira enforces — which is exactly the pairing worth testing.
      expect(validation).toEqual({ ok: true });
    });
  }
});
