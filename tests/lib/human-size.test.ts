import { describe, expect, it } from 'vitest';

import { humanSize } from '@lib/human-size';

/**
 * A byte count a person can read (HIVE-148).
 *
 * Decimal, not binary — `humanSize`'s own docblock explains why: every cap
 * this formats (`MAX_FILE_BYTES`, `MAX_BUNDLE_FILE_BYTES`) is a round decimal
 * number, so a 1024-based formatter would render the refusal's own number as
 * something other than the number in the rule.
 */
describe('humanSize', () => {
  it('renders a byte count under 1000 verbatim, with a B suffix', () => {
    expect(humanSize(0)).toBe('0 B');
    expect(humanSize(1)).toBe('1 B');
    expect(humanSize(999)).toBe('999 B');
  });

  it('renders 1000 and up as whole kilobytes', () => {
    expect(humanSize(1000)).toBe('1 KB');
    expect(humanSize(1500)).toBe('2 KB');
    expect(humanSize(999_999)).toBe('1000 KB');
  });

  it('renders 1,000,000 and up as megabytes with one decimal place', () => {
    expect(humanSize(1_000_000)).toBe('1.0 MB');
    expect(humanSize(5_000_000)).toBe('5.0 MB');
    expect(humanSize(5_432_000)).toBe('5.4 MB');
  });

  /*
    The two numbers every caller actually cares about: `MAX_FILE_BYTES` (the
    project explorer's cap) and `MAX_BUNDLE_FILE_BYTES` (a skill bundle's).
    Pinned by value rather than by importing the constants, so a change to
    either one shows up here as a failing assertion naming the number that
    moved, not as a silent pass that no longer means what the comment claims.
  */
  it('renders the two caps callers actually format', () => {
    expect(humanSize(1_000_000)).toBe('1.0 MB'); // MAX_FILE_BYTES
    expect(humanSize(5_000_000)).toBe('5.0 MB'); // MAX_BUNDLE_FILE_BYTES
  });

  it('rounds at the KB boundary rather than truncating', () => {
    // 1999 / 1000 = 1.999, which rounds to 2, not 1.
    expect(humanSize(1_999)).toBe('2 KB');
  });
});
