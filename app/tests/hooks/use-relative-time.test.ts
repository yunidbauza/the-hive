import { describe, expect, it } from 'vitest';

import { formatRelativeTime } from '@hooks/use-relative-time';

const AT = 1_700_000_000_000;
const at = (ms: number) => formatRelativeTime(AT, AT + ms);

describe('formatRelativeTime', () => {
  it('reads as now under a minute', () => {
    expect(at(0)).toBe('now');
    expect(at(59_000)).toBe('now');
  });

  it('counts whole minutes, then whole hours, then whole days', () => {
    expect(at(60_000)).toBe('1m');
    expect(at(59 * 60_000)).toBe('59m');
    expect(at(60 * 60_000)).toBe('1h');
    expect(at(23 * 3_600_000)).toBe('23h');
    expect(at(24 * 3_600_000)).toBe('1d');
  });

  /**
   * Main stamps the event and the renderer reads its own clock, so skew is
   * real. "in -3s" is a bug report; "now" is merely imprecise.
   */
  it('reads a future timestamp as now rather than as a negative age', () => {
    expect(formatRelativeTime(AT, AT - 5_000)).toBe('now');
  });
});
