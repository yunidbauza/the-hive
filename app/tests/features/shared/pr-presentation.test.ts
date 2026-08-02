import { describe, expect, it } from 'vitest';

import {
  findingsDescription,
  findingsLabel,
  prStateText,
} from '@features/shared/pr-presentation';

/**
 * Pure rules, tested as pure functions. They live in `features/shared` because
 * the work panel (032) and the PRs panel (052) are separate slices that cannot
 * import each other, and both must colour a PR the same way.
 */
describe('prStateText', () => {
  it.each([
    ['open', 'text-green'],
    ['approved', 'text-green'],
    ['draft', 'text-subtle'],
    ['merged', 'text-brand'],
  ] as const)('colours %s as %s', (state, expected) => {
    expect(prStateText(state)).toBe(expected);
  });

  /** Both mean "alive, not yet landed"; 052 separates them with a badge. */
  it('gives open and approved the same colour', () => {
    expect(prStateText('open')).toBe(prStateText('approved'));
  });
});

describe('findingsLabel', () => {
  it('flags a positive count', () => {
    expect(findingsLabel(2)).toBe('⚠ 2');
  });

  it('is null at zero so the caller renders nothing', () => {
    expect(findingsLabel(0)).toBeNull();
  });

  it('is null for a negative count', () => {
    expect(findingsLabel(-1)).toBeNull();
  });
});

describe('findingsDescription', () => {
  it('spells out the count for screen readers', () => {
    expect(findingsDescription(2)).toBe('2 open findings');
  });

  it('uses the singular for one', () => {
    expect(findingsDescription(1)).toBe('1 open finding');
  });

  it('is null when there is nothing to describe', () => {
    expect(findingsDescription(0)).toBeNull();
  });
});
