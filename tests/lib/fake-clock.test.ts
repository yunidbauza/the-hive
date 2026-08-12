import { beforeEach, describe, expect, it } from 'vitest';

import { FAKE_CLOCK_START, peek, reset, stamp } from '@lib/fake-clock';

/**
 * A module, not a module-level counter, precisely so tests can reset it. Story
 * 053 calls that out: without `reset()` the first test to push a feed item
 * would leak its time into every test after it.
 */
beforeEach(() => {
  reset();
});

describe('fake clock', () => {
  it('starts at 14:38', () => {
    expect(FAKE_CLOCK_START).toBe('14:38');
    expect(peek()).toBe('14:38');
  });

  it('advances one minute per stamp', () => {
    expect(stamp()).toBe('14:38');
    expect(stamp()).toBe('14:39');
    expect(stamp()).toBe('14:40');
  });

  it('rolls the hour over', () => {
    for (let i = 0; i < 22; i += 1) stamp();
    expect(stamp()).toBe('15:00');
  });

  it('wraps past midnight rather than reaching 24:00', () => {
    for (let i = 0; i < 9 * 60 + 22; i += 1) stamp();
    expect(stamp()).toBe('00:00');
  });

  it('pads single digits to HH:MM', () => {
    for (let i = 0; i < 9 * 60 + 23; i += 1) stamp();
    expect(stamp()).toBe('00:01');
  });

  it('returns to the start on reset', () => {
    stamp();
    stamp();
    reset();
    expect(peek()).toBe('14:38');
  });

  it('does not advance when peeked', () => {
    expect(peek()).toBe('14:38');
    expect(peek()).toBe('14:38');
  });
});
