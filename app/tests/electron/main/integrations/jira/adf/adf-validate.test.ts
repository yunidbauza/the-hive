// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { validateAdf } from '../../../../../../electron/main/integrations/jira/adf/adf-validate';

/**
 * The local ADF validator (HIVE-71).
 *
 * Ported from `jira-writer`'s `adf-validate.mjs` tests, which are node scripts
 * vitest does not run.
 *
 * Every rule below is one Jira enforces **silently** — the 400 it answers with
 * does not say which node was wrong. So the thing worth asserting is not just
 * that a bad document is refused, but that the refusal *names* something: a
 * rule, a path, and the index of the block the problem is inside.
 */

const doc = (content: unknown[]): unknown => ({
  type: 'doc',
  version: 1,
  content,
});

describe('the document shape', () => {
  it('accepts a well-formed empty document', () => {
    expect(validateAdf(doc([]))).toEqual({ ok: true });
  });

  it('refuses anything that is not a doc', () => {
    for (const bad of [null, undefined, 'doc', [], 42, {}]) {
      const result = validateAdf(bad);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.rule).toBe('doc_shape');
    }
  });

  it('refuses a doc with no version, or no content array', () => {
    expect(validateAdf({ type: 'doc', content: [] }).ok).toBe(false);
    expect(validateAdf({ type: 'doc', version: 1 }).ok).toBe(false);
  });
});

describe('mark exclusivity', () => {
  it('refuses code beside strong', () => {
    const result = validateAdf(
      doc([
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'x',
              marks: [{ type: 'code' }, { type: 'strong' }],
            },
          ],
        },
      ]),
    );

    expect(result.ok).toBe(false);
    expect(!result.ok && result.rule).toBe('mark_exclusivity');
    // The path is the point: "content[0].content[0]" is findable, "invalid
    // document" is not.
    expect(!result.ok && result.path).toBe('content[0].content[0]');
    expect(!result.ok && result.blockIndex).toBe(0);
    expect(!result.ok && result.message).toContain('code');
  });

  it('accepts code alone, and strong beside em', () => {
    expect(
      validateAdf(
        doc([
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'a', marks: [{ type: 'code' }] },
              {
                type: 'text',
                text: 'b',
                marks: [{ type: 'strong' }, { type: 'em' }],
              },
            ],
          },
        ]),
      ),
    ).toEqual({ ok: true });
  });
});

describe('task nodes need a localId', () => {
  it('refuses a taskList without one', () => {
    const result = validateAdf(doc([{ type: 'taskList', content: [] }]));
    expect(!result.ok && result.rule).toBe('missing_localId');
  });

  it('refuses a taskItem without one', () => {
    const result = validateAdf(
      doc([
        {
          type: 'taskList',
          attrs: { localId: 'a' },
          content: [{ type: 'taskItem', attrs: {}, content: [] }],
        },
      ]),
    );
    expect(!result.ok && result.rule).toBe('missing_localId');
    expect(!result.ok && result.path).toBe('content[0].content[0]');
  });

  it('accepts both when present', () => {
    expect(
      validateAdf(
        doc([
          {
            type: 'taskList',
            attrs: { localId: 'a' },
            content: [
              { type: 'taskItem', attrs: { localId: 'b' }, content: [] },
            ],
          },
        ]),
      ),
    ).toEqual({ ok: true });
  });
});

describe('table cells need an attrs object', () => {
  it('refuses a cell without one, even though it may be empty', () => {
    const result = validateAdf(
      doc([
        {
          type: 'table',
          content: [
            { type: 'tableRow', content: [{ type: 'tableCell', content: [] }] },
          ],
        },
      ]),
    );
    expect(!result.ok && result.rule).toBe('missing_table_attrs');
  });

  it('accepts an empty attrs object', () => {
    expect(
      validateAdf(
        doc([
          {
            type: 'table',
            content: [
              {
                type: 'tableRow',
                content: [{ type: 'tableHeader', attrs: {}, content: [] }],
              },
            ],
          },
        ]),
      ),
    ).toEqual({ ok: true });
  });
});

describe('paragraphs hold inline content only', () => {
  it('refuses a block inside a paragraph', () => {
    const result = validateAdf(
      doc([
        {
          type: 'paragraph',
          content: [{ type: 'paragraph', content: [] }],
        },
      ]),
    );
    expect(!result.ok && result.rule).toBe('inline_in_block');
    expect(!result.ok && result.message).toContain('paragraph');
  });

  it('accepts text, hardBreak, mention, emoji and inlineCard', () => {
    expect(
      validateAdf(
        doc([
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'a' },
              { type: 'hardBreak' },
              { type: 'mention', attrs: {} },
              { type: 'emoji', attrs: {} },
              { type: 'inlineCard', attrs: {} },
            ],
          },
        ]),
      ),
    ).toEqual({ ok: true });
  });
});

describe('locating the problem', () => {
  it('reports the index of the top-level block it is inside', () => {
    const result = validateAdf(
      doc([
        { type: 'paragraph', content: [{ type: 'text', text: 'fine' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'also fine' }] },
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'bad',
              marks: [{ type: 'code' }, { type: 'em' }],
            },
          ],
        },
      ]),
    );

    // "the third thing you wrote" is actionable; a path alone is not.
    expect(!result.ok && result.blockIndex).toBe(2);
    expect(!result.ok && result.path).toBe('content[2].content[0]');
  });

  it('refuses a node that is not an object at all', () => {
    const result = validateAdf(doc(['nope']));
    expect(!result.ok && result.rule).toBe('node_shape');
  });

  it('stops at the first problem rather than collecting them', () => {
    // One named problem is actionable; a list of twelve is a wall.
    const result = validateAdf(
      doc([
        { type: 'taskList', content: [] },
        { type: 'taskItem', content: [] },
      ]),
    );
    expect(!result.ok && result.blockIndex).toBe(0);
  });
});
