import { describe, expect, it } from 'vitest';

import type { RunLine } from '../../../electron/shared/agent-contract';
import type { TermLine } from '../../../src/types/terminal';

describe('RunLine', () => {
  it('is assignable to TermLine, so main needs no colour mapping', () => {
    const line: RunLine = { text: 'hello', color: 'amber' };
    // A compile-time assertion: widening a colour in RunLine that TermColor
    // does not have breaks this line, which is the point of the test.
    const asTerm: TermLine = line;

    expect(asTerm).toEqual(line);
  });
});
