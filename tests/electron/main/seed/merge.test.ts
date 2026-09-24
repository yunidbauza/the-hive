// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  baseOf,
  hashPart,
  mergeParts,
  parseParts,
} from '../../../../electron/main/seed/merge';

/**
 * A shipped AGENT.md or SKILL.md, split into the parts the seed merges one at
 * a time: each top-level key, each child of a flat block (`limits.parallel`),
 * any other block whole, and the body.
 */

const agent = `---
name: shipper
model: sonnet
wake:
  every: 10m
  on: [ledger]
limits:
  turns: 60
  parallel: 3
---

Body line.
`;

describe('parseParts', () => {
  it('splits a flat block into one part per child', () => {
    const parsed = parseParts(agent);

    expect([...(parsed?.parts.keys() ?? [])]).toEqual([
      'name',
      'model',
      'wake.every',
      'wake.on',
      'limits.turns',
      'limits.parallel',
    ]);
    expect(parsed?.parts.get('limits.parallel')).toBe('  parallel: 3');
    expect([...(parsed?.blocks ?? [])]).toEqual(['wake', 'limits']);
  });

  it('keeps everything after the closing fence as the body', () => {
    expect(parseParts(agent)?.body).toBe('\nBody line.\n');
  });

  it('keeps a nested block whole, comments and all', () => {
    const parsed = parseParts(
      '---\nname: goal-on\nhooks:\n  Stop:\n    - hooks:\n        # the floor\n        - type: command\n---\nbody\n',
    );

    expect([...(parsed?.parts.keys() ?? [])]).toEqual(['name', 'hooks']);
    expect(parsed?.parts.get('hooks')).toBe(
      'hooks:\n  Stop:\n    - hooks:\n        # the floor\n        - type: command',
    );
    expect(parsed?.blocks.size).toBe(0);
  });

  it('keeps lines before the first key as a preamble', () => {
    expect(parseParts('---\n# mine\nname: a\n---\n')?.preamble).toEqual(['# mine']);
  });

  it('keeps a key written twice as one whole part, both copies in it', () => {
    const parsed = parseParts('---\nwake:   # mine\n  every: 5m\nname: a\nwake:\n  on: [ledger]\n---\n');

    expect([...(parsed?.parts.keys() ?? [])]).toEqual(['wake', 'name']);
    expect(parsed?.parts.get('wake')).toBe('wake:   # mine\n  every: 5m\nwake:\n  on: [ledger]');
    expect(parsed?.blocks.size).toBe(0);
  });

  it('reads a CRLF file the way it reads an LF one', () => {
    expect([...(parseParts('---\r\nname: a\r\nmodel: opus\r\n---\r\nbody\r\n')?.parts.keys() ?? [])]).toEqual([
      'name',
      'model',
    ]);
  });

  it('refuses a file without a closed frontmatter fence', () => {
    expect(parseParts('name: a\n')).toBeNull();
    expect(parseParts('---\nname: a\n')).toBeNull();
  });
});

describe('hashPart', () => {
  it('ignores trailing whitespace, and nothing else', () => {
    expect(hashPart('model: opus  \n')).toBe(hashPart('model: opus'));
    expect(hashPart('model: opus')).not.toBe(hashPart('model: sonnet'));
    expect(hashPart('model: opus')).toHaveLength(16);
  });
});

/** An agent file from its frontmatter lines and a body. */
const file = (lines: string[], body = 'Prompt v1.\n'): string =>
  `---\n${lines.join('\n')}\n---\n${body}`;

const v1 = file(['name: a', 'model: opus', 'limits:', '  turns: 60', '  parallel: 2']);

describe('mergeParts', () => {
  it('leaves an untouched file identical to what ships', () => {
    const result = mergeParts(v1, v1, baseOf(v1));

    expect(result.text).toBe(v1);
    expect(result.customised).toEqual([]);
    expect(result.held).toBe(false);
  });

  it('gives an untouched key the new shipped value', () => {
    const v2 = file(['name: a', 'model: sonnet', 'limits:', '  turns: 60', '  parallel: 2']);

    expect(mergeParts(v1, v2, baseOf(v1)).text).toBe(v2);
  });

  it('brings a new shipped key into a file the user edited', () => {
    const mine = file(['name: a', 'model: opus', 'limits:', '  turns: 60', '  parallel: 5']);
    const v2 = file(['name: a', 'model: opus', 'lane: thread', 'limits:', '  turns: 60', '  parallel: 2']);

    const result = mergeParts(mine, v2, baseOf(v1));

    expect(result.text).toBe(
      file(['name: a', 'model: opus', 'lane: thread', 'limits:', '  turns: 60', '  parallel: 5']),
    );
    expect(result.customised).toEqual([
      { path: 'limits.parallel', yours: '5', shipped: '2' },
    ]);
    expect(result.moved).toEqual([]);
  });

  it('keeps an edited key when the shipped value moved too, and flags it', () => {
    const mine = file(['name: a', 'model: haiku', 'limits:', '  turns: 60', '  parallel: 2']);
    const v2 = file(['name: a', 'model: sonnet', 'limits:', '  turns: 60', '  parallel: 2']);

    const result = mergeParts(mine, v2, baseOf(v1));

    expect(result.text).toBe(mine);
    expect(result.moved).toEqual(['model']);
    // The old base stays, so the next seed flags it again.
    expect(result.base.keys.model).toBe(baseOf(v1).keys.model);
  });

  it('keeps a deleted key deleted, even when its shipped value changes', () => {
    const mine = file(['name: a', 'model: opus', 'limits:', '  turns: 60']);
    const v2 = file(['name: a', 'model: opus', 'limits:', '  turns: 60', '  parallel: 3']);

    const result = mergeParts(mine, v2, baseOf(v1));

    expect(result.text).toBe(mine);
    expect(result.deleted).toEqual(['limits.parallel']);
    expect(result.base.keys['limits.parallel']).toBe(baseOf(v1).keys['limits.parallel']);
  });

  it('drops a key the app stopped shipping when the user never touched it', () => {
    const v2 = file(['name: a', 'limits:', '  turns: 60', '  parallel: 2']);

    expect(mergeParts(v1, v2, baseOf(v1)).text).toBe(v2);
  });

  it('keeps a key only the user has, at the end of its block', () => {
    const mine = file(['name: a', 'model: opus', 'limits:', '  turns: 60', '  parallel: 2', '  daily_usd: 5', 'extra: yes']);
    const v2 = file(['name: a', 'model: opus', 'limits:', '  turns: 90', '  parallel: 2', 'lane: repo']);

    expect(mergeParts(mine, v2, baseOf(v1)).text).toBe(
      file(['name: a', 'model: opus', 'limits:', '  turns: 90', '  parallel: 2', '  daily_usd: 5', 'lane: repo', 'extra: yes']),
    );
  });

  it('keeps a user-only block whole, header and all', () => {
    const mine = file(['name: a', 'model: opus', 'limits:', '  turns: 60', '  parallel: 2', 'wake:', '  every: 5m']);

    expect(mergeParts(mine, v1, baseOf(v1)).text).toBe(mine);
  });

  it('upgrades a body the user never touched', () => {
    const v2 = file(['name: a', 'model: opus', 'limits:', '  turns: 60', '  parallel: 2'], 'Prompt v2.\n');

    expect(mergeParts(v1, v2, baseOf(v1)).text).toBe(v2);
  });

  it('keeps an edited body without holding anything when the shipped body did not move', () => {
    const mine = file(['name: a', 'model: opus', 'limits:', '  turns: 60', '  parallel: 2'], 'Mine.\n');

    const result = mergeParts(mine, v1, baseOf(v1));

    expect(result.text).toBe(mine);
    expect(result.bodyEdited).toBe(true);
    expect(result.held).toBe(false);
  });

  it('holds a new shipped body over an edited one, and keeps the old base', () => {
    const mine = file(['name: a', 'model: opus', 'limits:', '  turns: 60', '  parallel: 2'], 'Mine.\n');
    const v2 = file(['name: a', 'model: sonnet', 'limits:', '  turns: 60', '  parallel: 2'], 'Prompt v2.\n');

    const result = mergeParts(mine, v2, baseOf(v1));

    expect(result.text).toBe(
      file(['name: a', 'model: sonnet', 'limits:', '  turns: 60', '  parallel: 2'], 'Mine.\n'),
    );
    expect(result.held).toBe(true);
    expect(result.base.body).toBe(baseOf(v1).body);
  });

  it('with no base, treats every difference as the user\'s and flags it', () => {
    const mine = file(['name: a', 'model: haiku'], 'Mine.\n');
    const v2 = file(['name: a', 'model: sonnet', 'lane: thread'], 'Prompt v2.\n');

    const result = mergeParts(mine, v2, null);

    expect(result.text).toBe(file(['name: a', 'model: haiku', 'lane: thread'], 'Mine.\n'));
    expect(result.moved).toEqual(['model']);
    expect(result.held).toBe(true);
  });

  it('treats a block one side wrote inline as one part on both sides', () => {
    const mine = file(['name: a', 'model: opus', 'limits: { turns: 5 }']);

    const result = mergeParts(mine, v1, baseOf(v1));

    expect(result.text).toBe(mine);
    expect(result.customised.map((part) => part.path)).toEqual(['limits']);
  });

  it('keeps a key written twice whole, as the user\'s', () => {
    const mine = file(['name: a', 'model: opus', 'limits:', '  turns: 60', 'limits:', '  parallel: 2']);

    const result = mergeParts(mine, v1, baseOf(v1));

    expect(result.text).toContain('  turns: 60\nlimits:\n  parallel: 2');
    expect(result.customised.map((part) => part.path)).toEqual(['limits']);
  });

  it('folds the user\'s split block when the shipped file writes it inline', () => {
    const inline = file(['name: a', 'model: opus', 'limits: { turns: 60 }']);

    const result = mergeParts(v1, inline, baseOf(v1));

    expect(result.text).toBe(v1);
    expect(result.customised).toEqual([
      { path: 'limits', yours: 'turns: 60\n  parallel: 2', shipped: '{ turns: 60 }' },
    ]);
  });

  it('keeps and flags a key the user changed after the app stopped shipping it', () => {
    const mine = file(['name: a', 'model: haiku', 'limits:', '  turns: 60', '  parallel: 2']);
    const v2 = file(['name: a', 'limits:', '  turns: 60', '  parallel: 2']);

    const result = mergeParts(mine, v2, baseOf(v1));

    expect(result.text).toBe(file(['name: a', 'limits:', '  turns: 60', '  parallel: 2', 'model: haiku']));
    expect(result.customised).toEqual([{ path: 'model', yours: 'haiku', shipped: null }]);
    expect(result.moved).toEqual(['model']);
    expect(result.base.keys.model).toBe(baseOf(v1).keys.model);
  });

  it('keeps the user\'s text when it differs from shipped only in trailing spaces', () => {
    const mine = v1.replace('model: opus', 'model: opus  ');

    expect(mergeParts(mine, v1, baseOf(v1)).text).toBe(mine);
  });

  it('holds a body with no base, and records no base for it', () => {
    const result = mergeParts(file(['name: a'], 'Mine.\n'), file(['name: a']), null);

    expect(result.held).toBe(true);
    expect(result.base.body).toBe('');
  });

  it('keeps the user\'s preamble comment', () => {
    const mine = v1.replace('---\n', '---\n# pinned\n');

    expect(mergeParts(mine, v1, baseOf(v1)).text).toBe(mine);
  });
});
