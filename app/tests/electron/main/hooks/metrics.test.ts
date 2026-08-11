// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { parseMetrics } from '../../../../electron/main/hooks/metrics';

/**
 * The payload is produced by another program on a schedule this app does not
 * control, so the interesting cases are all about **absence** — which the docs
 * say happens in four distinct ways — rather than about the happy path.
 */
describe('parseMetrics', () => {
  /** A complete payload, trimmed to the fields this app reads. */
  const full = {
    model: { id: 'claude-opus-4-5', display_name: 'Opus 4.5' },
    effort: { level: 'high' },
    context_window: {
      used_percentage: 46.2,
      context_window_size: 1_000_000,
      total_input_tokens: 92_000,
    },
    rate_limits: {
      five_hour: { used_percentage: 12, resets_at: 1_786_000_000 },
      seven_day: { used_percentage: 63, resets_at: 1_786_200_000 },
    },
    session_id: 'uuid',
    version: '2.1.227',
  };

  it('reads every field the chip renders', () => {
    expect(parseMetrics(JSON.stringify(full))).toEqual({
      model: 'Opus 4.5',
      effort: 'high',
      contextPct: 46.2,
      contextWindow: 1_000_000,
      fiveHourPct: 12,
      fiveHourResetsAt: 1_786_000_000,
      sevenDayPct: 63,
      sevenDayResetsAt: 1_786_200_000,
    });
  });

  it('ignores the many fields it has no use for', () => {
    const parsed = parseMetrics(JSON.stringify(full));

    // `transcript_path`, `cost`, `workspace` and the rest never cross the wire.
    expect(Object.keys(parsed ?? {}).sort()).toEqual([
      'contextPct',
      'contextWindow',
      'effort',
      'fiveHourPct',
      'fiveHourResetsAt',
      'model',
      'sevenDayPct',
      'sevenDayResetsAt',
    ]);
  });

  /**
   * The documented absence, and the one that matters most: a subscriber's
   * limits do not exist until the first API response, and never exist at all
   * under API-key auth.
   */
  it('omits both windows when rate_limits is absent', () => {
    const { rate_limits: _omitted, ...withoutLimits } = full;

    const parsed = parseMetrics(JSON.stringify(withoutLimits));

    expect(parsed).not.toHaveProperty('fiveHourPct');
    expect(parsed).not.toHaveProperty('sevenDayPct');
    expect(parsed?.contextPct).toBe(46.2);
  });

  it('omits one window independently of the other', () => {
    const parsed = parseMetrics(
      JSON.stringify({
        ...full,
        rate_limits: { five_hour: { used_percentage: 12, resets_at: 1 } },
      }),
    );

    expect(parsed?.fiveHourPct).toBe(12);
    expect(parsed).not.toHaveProperty('sevenDayPct');
  });

  /**
   * `used_percentage` is documented as **null** — not absent — before the first
   * assistant turn and again after `/compact`.
   *
   * It is reported onward as an explicit `null`, which is the one place this
   * parser does not simply omit what it could not read. The store preserves a
   * field a payload omitted, and preserving *this* one leaves the pre-compact
   * percentage on screen as though it were current — the single number the user
   * just changed. A null says "gone", and the store clears it.
   */
  it('reports a null percentage as null, so the store can clear it', () => {
    const parsed = parseMetrics(
      JSON.stringify({
        ...full,
        context_window: { used_percentage: null, context_window_size: 200_000 },
      }),
    );

    expect(parsed).toHaveProperty('contextPct', null);
    expect(parsed?.contextWindow).toBe(200_000);
  });

  /**
   * The distinction the null rests on. No `context_window` at all is not a
   * report of ignorance — it is silence, and silence preserves what is known.
   */
  it('omits the key entirely when the payload carried no context window', () => {
    const parsed = parseMetrics(
      JSON.stringify({ model: { display_name: 'Opus 4.5' } }),
    );

    expect(parsed).not.toHaveProperty('contextPct');
  });

  it('never emits a key holding undefined, which the store would treat as a value', () => {
    const parsed = parseMetrics('{}');

    expect(parsed).toEqual({});
    expect(Object.keys(parsed ?? {})).toHaveLength(0);
  });

  it.each([
    ['malformed JSON', '{ not json'],
    ['a JSON scalar', '42'],
    ['a JSON string', '"hello"'],
    ['null', 'null'],
  ])('answers null for %s', (_label, body) => {
    expect(parseMetrics(body)).toBeNull();
  });

  it('ignores a field of the wrong type instead of publishing it', () => {
    const parsed = parseMetrics(
      JSON.stringify({
        context_window: { used_percentage: '46' },
        model: { display_name: '' },
        rate_limits: { five_hour: { used_percentage: Number.NaN } },
      }),
    );

    // `contextPct` is null rather than absent: a `context_window` arrived, and
    // an unreadable percentage inside one is a report that the number is gone.
    expect(parsed).toEqual({ contextPct: null });
  });

  it('accepts a well-formed payload that simply carries nothing yet', () => {
    // An early-session payload is not an error; the store drops an empty patch.
    expect(parseMetrics(JSON.stringify({ session_id: 'uuid' }))).toEqual({});
  });
});
