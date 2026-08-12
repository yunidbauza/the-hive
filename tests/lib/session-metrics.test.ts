import { describe, expect, it } from 'vitest';

import {
  chipLabel,
  clockLabel,
  dayClockLabel,
  DEFAULT_EFFORT,
  modelLabel,
  pctLabel,
  pctOrNull,
} from '@/lib/session-metrics';

/**
 * These used to assert a *derivation* — that `contextPct('sess-01')` was stable
 * for an id. There is nothing left to derive: the numbers arrive from Claude
 * Code's status line, so what is worth testing is the boundary between "we were
 * told" and "we were not", and the formatting that has to survive both.
 */
describe('pctOrNull', () => {
  it('rounds a reported percentage', () => {
    expect(pctOrNull(46.4)).toBe(46);
    expect(pctOrNull(46.6)).toBe(47);
  });

  it('clamps a value outside 0–100 rather than trusting it', () => {
    // The number crossed a process boundary; a 140% arc would wrap past itself.
    expect(pctOrNull(140)).toBe(100);
    expect(pctOrNull(-3)).toBe(0);
  });

  /**
   * `null` is in this list for a different reason than the rest: it is what the
   * session says when it reports a context window it cannot put a percentage on
   * (after `/compact`), rather than a value that failed to parse. By the time it
   * reaches a gauge the two mean the same thing — not known — and only the store
   * needs to tell them apart.
   */
  it.each([undefined, null, Number.NaN, Number.POSITIVE_INFINITY])(
    'answers null for %s — absence must never become a number',
    (value) => {
      expect(pctOrNull(value)).toBeNull();
    },
  );
});

describe('pctLabel', () => {
  it('renders a known percentage', () => {
    expect(pctLabel(46)).toBe('46%');
  });

  /**
   * A reported zero is still a fact and still renders.
   *
   * The em-dash case that used to live here is gone with the `null` argument
   * with it: the refusal to invent a number moved up to `model-chip.tsx`,
   * which renders no stat at all rather than a labelled empty one. What must
   * never happen — an unreported limit reading `0%` — is now unrepresentable
   * here rather than defended against.
   */
  it('renders a reported zero, which is not the same as no report', () => {
    expect(pctLabel(0)).toBe('0%');
  });
});

describe('clockLabel', () => {
  /**
   * Built from local components rather than a fixed epoch, because the label is
   * local-time by design and a hardcoded instant would assert the runner's
   * timezone instead of the formatting.
   */
  const at = (hours: number, minutes: number): number =>
    new Date(2026, 7, 11, hours, minutes, 0, 0).getTime() / 1000;

  it('drops the minutes when a reset lands on the hour', () => {
    expect(clockLabel(at(17, 0))).toBe('5p');
  });

  it('keeps them, zero-padded, when it does not', () => {
    expect(clockLabel(at(14, 30))).toBe('2:30p');
    expect(clockLabel(at(9, 5))).toBe('9:05a');
  });

  it('renders both noon and midnight as 12 rather than 0', () => {
    expect(clockLabel(at(12, 0))).toBe('12p');
    expect(clockLabel(at(0, 0))).toBe('12a');
  });

  /**
   * `resets_at` is epoch **seconds**. Forgetting the multiplication is the one
   * mistake in this area that silently produces a plausible-looking time in
   * 1970, so the seconds-to-milliseconds conversion is asserted directly.
   */
  it('reads its input as seconds, not milliseconds', () => {
    const seconds = at(14, 30);
    expect(clockLabel(seconds)).toBe('2:30p');
    // The same number read as milliseconds would land in January 1970.
    expect(new Date(seconds * 1000).getFullYear()).toBe(2026);
  });

  it.each([undefined, Number.NaN])('answers null for %s', (value) => {
    expect(clockLabel(value)).toBeNull();
  });

  /**
   * `0` is what a null becomes on its way through anything that defaults, and
   * it renders as a perfectly plausible `12a`. A confident wrong time is worse
   * than an em dash in the one module whose whole discipline is refusing to
   * invent numbers.
   */
  it('refuses epoch 0 rather than rendering it as midnight', () => {
    expect(clockLabel(0)).toBeNull();
    expect(dayClockLabel(0)).toBeNull();
  });

  it('refuses any timestamp from before this app could have produced one', () => {
    // 2019-06-01 — well before the earliest plausible reset.
    expect(clockLabel(1_559_347_200)).toBeNull();
  });
});

describe('dayClockLabel', () => {
  it('prefixes the weekday, because a weekly reset without one is not news', () => {
    // 2026-08-13 is a Thursday.
    const at = new Date(2026, 7, 13, 17, 0, 0, 0).getTime() / 1000;
    expect(dayClockLabel(at)).toBe('Thu 5p');
  });

  it('answers null when the five-hour label would', () => {
    expect(dayClockLabel(undefined)).toBeNull();
  });
});

describe('chipLabel', () => {
  it('prefers what the session says about itself over what it was started with', () => {
    // `/model` and `/effort` change mid-conversation; the entity does not.
    expect(
      chipLabel({ model: 'Sonnet 4.5', effort: 'low' }, 'opus', 'high'),
    ).toBe('Sonnet 4.5 · low');
  });

  it('falls back to the entity, then to the concept defaults', () => {
    expect(chipLabel(undefined, 'haiku', 'low')).toBe('Haiku 4.5 · low');
    expect(chipLabel(undefined, undefined, undefined)).toBe(
      `${modelLabel()} · ${DEFAULT_EFFORT}`,
    );
  });

  /**
   * `(1M)` used to be hardcoded into the chip and was therefore wrong for every
   * 200k session. It is now a fact the session reports.
   */
  it('names the extended window only when the session reports one', () => {
    expect(chipLabel({ contextWindow: 1_000_000 }, 'opus', 'high')).toContain(
      '(1M)',
    );
    expect(chipLabel({ contextWindow: 200_000 }, 'opus', 'high')).not.toContain(
      '(1M)',
    );
    expect(chipLabel({}, 'opus', 'high')).not.toContain('(1M)');
  });

  /**
   * The suffix is derived, not the literal `(1M)` this first shipped as. The
   * threshold is documented as future-proof; a hardcoded label would have made
   * that only half true, announcing a 2M window as 1M in the one place the user
   * cannot otherwise see the size.
   */
  it('derives the size rather than hardcoding one megatoken', () => {
    expect(chipLabel({ contextWindow: 2_000_000 }, 'opus', 'high')).toContain(
      '(2M)',
    );
  });
});
