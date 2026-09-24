// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { hashPart, parseParts } from '../../../../electron/main/seed/merge';

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
