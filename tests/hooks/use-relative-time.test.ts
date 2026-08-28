import { act, render } from '@testing-library/react';
import { createElement, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  formatLastUsed,
  formatRelativeTime,
  useLastUsed,
} from '@hooks/use-relative-time';

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

/**
 * The fleet table's `LAST USED` column reads in words rather than in the
 * inbox's abbreviations: `5 min ago`, not `5m`.
 *
 * The vocabulary is capped at weeks and then months on purpose. A session-history
 * row from last spring has to fit the same 80px column as `59 min ago`, and
 * `412 days ago` does not — the cap is what keeps the longest value at ten
 * characters, which is the width the column is measured against.
 */
const lastUsed = (ms: number) => formatLastUsed(AT, AT + ms);

const MIN = 60_000;
const HR = 60 * MIN;
const DAY = 24 * HR;

describe('formatLastUsed', () => {
  it('reads as now under a minute', () => {
    expect(lastUsed(0)).toBe('now');
    expect(lastUsed(59_000)).toBe('now');
  });

  it('counts minutes up to the hour', () => {
    expect(lastUsed(MIN)).toBe('1 min ago');
    expect(lastUsed(5 * MIN)).toBe('5 min ago');
    expect(lastUsed(59 * MIN)).toBe('59 min ago');
  });

  it('counts hours up to the day', () => {
    expect(lastUsed(HR)).toBe('1 hr ago');
    expect(lastUsed(23 * HR)).toBe('23 hr ago');
  });

  /**
   * Elapsed, not calendar. Something from 11pm last night reads `10 hr ago` at
   * 9am rather than `yesterday`, which is the more precise of the two answers
   * and keeps this a pure function of two numbers — no timezone, no `Date`.
   */
  it('reads the second day as yesterday', () => {
    expect(lastUsed(DAY)).toBe('yesterday');
    expect(lastUsed(2 * DAY - 1)).toBe('yesterday');
  });

  it('counts days up to the week', () => {
    expect(lastUsed(2 * DAY)).toBe('2 days ago');
    expect(lastUsed(6 * DAY)).toBe('6 days ago');
  });

  /**
   * Where the cap starts doing its work: without it the next value is
   * `7 days ago` and it keeps growing a character every few months.
   */
  it('counts weeks, then months, so the longest value stays ten characters', () => {
    expect(lastUsed(7 * DAY)).toBe('1 wk ago');
    expect(lastUsed(29 * DAY)).toBe('4 wk ago');
    expect(lastUsed(30 * DAY)).toBe('1 mo ago');
    expect(lastUsed(400 * DAY)).toBe('13 mo ago');
  });

  it('reads a future timestamp as now rather than as a negative age', () => {
    expect(formatLastUsed(AT, AT - 5_000)).toBe('now');
  });
});

/**
 * The label keeps itself current, which is the whole reason this is a hook.
 *
 * The shape it replaced stored the string: a row said `4 min ago` and went on
 * saying it for as long as the app was open. React has no reason to re-render
 * a fleet row just because a minute passed, so the ticking has to live here —
 * and a test that never advances a clock cannot tell the two shapes apart.
 */
let renders = 0;

function Harness({ usedAt }: { usedAt: number }): ReactElement {
  renders += 1;
  return createElement('span', { 'data-testid': 'label' }, useLastUsed(usedAt));
}

const label = (): string =>
  document.querySelector('[data-testid="label"]')?.textContent ?? '';

describe('useLastUsed', () => {
  beforeEach(() => {
    renders = 0;
    vi.useFakeTimers();
    vi.setSystemTime(AT);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('repaints the label as the session ages', () => {
    render(createElement(Harness, { usedAt: AT }));
    expect(label()).toBe('now');

    act(() => {
      vi.advanceTimersByTime(3 * MIN);
    });

    expect(label()).toBe('3 min ago');
  });

  /**
   * A fleet of thirteen day-old rows must not wake the renderer every fifteen
   * seconds to change nothing. The cadence widens with the age, so an hour-old
   * row is on the five-minute schedule.
   *
   * The assertion counts renders rather than reading the label, because the
   * label cannot tell the two cadences apart: `3 hr ago` still says `3 hr ago`
   * after four minutes whether it was recomputed once or sixteen times, so a
   * hook that regressed to the fifteen-second schedule would pass a text
   * assertion while waking the renderer fifty times a minute for a fleet.
   *
   * The two halves also prove each other. A counter that never moved would
   * pass the first and fail the second; one wired to every tick fails the
   * first. Only the five-minute schedule passes both.
   */
  it('leaves an hours-old row alone between its slower ticks', () => {
    render(createElement(Harness, { usedAt: AT - 3 * HR }));
    expect(label()).toBe('3 hr ago');

    const atMount = renders;

    act(() => {
      vi.advanceTimersByTime(4 * MIN);
    });

    /**
     * Zero, exactly. React batches a synchronous burst of `setNow` calls into
     * one render, so a regressed hook's sixteen fifteen-second ticks show up
     * here as a single extra render rather than sixteen — which is why the
     * assertion is `atMount` and not a ceiling. Not repainting at all is the
     * claim; how many repaints a regression costs is React's business.
     */
    expect(renders).toBe(atMount);
    expect(label()).toBe('3 hr ago');

    act(() => {
      vi.advanceTimersByTime(MIN);
    });

    expect(renders).toBeGreaterThan(atMount);
    expect(label()).toBe('3 hr ago');

    act(() => {
      vi.advanceTimersByTime(56 * MIN);
    });

    expect(label()).toBe('4 hr ago');
  });
});
