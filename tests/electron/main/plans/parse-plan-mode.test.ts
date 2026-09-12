import { describe, expect, it } from 'vitest';

import { parsePlanMode } from '../../../../electron/main/plans/parse-plan-mode';

describe('parsePlanMode', () => {
  it('takes ### headings when there are any', () => {
    expect(
      parsePlanMode('# Plan\n### Add the slice\ntext\n1. not this\n### Wire it').map((t) => t.title),
    ).toEqual(['Add the slice', 'Wire it']);
  });

  it('falls back to the top-level numbered list', () => {
    expect(parsePlanMode('Intro\n1. First\n   1. nested, skipped\n2) Second')).toEqual([
      { id: '1', title: 'First', status: 'pending' },
      { id: '2', title: 'Second', status: 'pending' },
    ]);
  });

  it('neither is no plan and no error', () => {
    expect(parsePlanMode('Just do it.')).toEqual([]);
  });

  it('strips markdown emphasis from a title', () => {
    expect(parsePlanMode('1. **Bold** step')[0]?.title).toBe('Bold step');
  });

  it('reads a CRLF plan', () => {
    expect(parsePlanMode('### One\r\n### Two\r\n').map((t) => t.title)).toEqual(['One', 'Two']);
  });
});
