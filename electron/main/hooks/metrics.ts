import type { SessionMetrics } from '@shared/metrics-contract';

/**
 * Read Claude Code's status line payload into {@link SessionMetrics} (HIVE-79).
 *
 * ## Everything here is defensive on purpose
 *
 * This parses a document produced by *another program*, whose shape is
 * documented but not versioned against this app. Three fields are documented as
 * possibly `null` rather than absent (`context_window.used_percentage` before
 * the first API call and again after `/compact`), and a whole subtree is
 * documented as conditionally missing (`rate_limits`, absent until a subscriber
 * session's first API response and absent forever under API-key auth).
 *
 * So every read goes through {@link numberOrUndefined}, and a field that is not
 * a finite number is **omitted** rather than defaulted. The store merges patches
 * and drops undefined keys, which means an omission preserves whatever was last
 * known — and a `0` invented here would instead be published as fact.
 *
 * `contextPct` is the single exception, and deliberately so: it emits an
 * explicit `null` when a `context_window` arrived without a usable percentage,
 * because there preserving the last value would leave a stale post-`/compact`
 * reading on screen. See the note in `metrics-contract.ts`.
 */

/** A finite number, or `undefined` for anything else — `null`, a string, `NaN`. */
function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** A non-empty string, or `undefined`. */
function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Narrow an unknown to an indexable object without asserting its shape. */
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Parse a status line body.
 *
 * Answers `null` for a body that is not an object at all — malformed JSON, or a
 * JSON scalar — which the receiver turns into a 400. A well-formed object that
 * happens to carry nothing recognisable answers an **empty** metrics object
 * rather than `null`: that is a legitimate early-session payload, not an error,
 * and the store drops an empty patch on its own.
 */
export function parseMetrics(body: string): SessionMetrics | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }

  const root = record(parsed);
  if (root === undefined) return null;

  const model = record(root.model);
  const effort = record(root.effort);
  const context = record(root.context_window);
  const limits = record(root.rate_limits);
  const fiveHour = record(limits?.five_hour);
  const sevenDay = record(limits?.seven_day);

  /*
    Built by assignment rather than as one literal, because `exactOptionalPropertyTypes`
    treats `{ model: undefined }` as a present key holding undefined — which is
    exactly the shape the store's merge is written to ignore, and exactly the
    shape a spread would produce. Omitting the key is the whole point.
  */
  const metrics: SessionMetrics = {};

  const displayName = stringOrUndefined(model?.display_name);
  if (displayName !== undefined) metrics.model = displayName;

  const level = stringOrUndefined(effort?.level);
  if (level !== undefined) metrics.effort = level;

  /*
    The one field that reports its own ignorance rather than staying quiet.

    A `context_window` in the payload means the session had something to say
    about this conversation's usage, so an unreadable `used_percentage` inside it
    is news: the number is gone, not merely unmentioned. Claude Code nulls it
    before the first assistant turn and again after `/compact`, and the store
    would otherwise keep showing the pre-compact reading — the single number the
    user just changed — as though it were current. See `metrics-contract.ts`.

    No `context_window` at all still omits the key, which preserves what is
    known. That is the shape every other field here uses.
  */
  if (context !== undefined) {
    metrics.contextPct = numberOrUndefined(context.used_percentage) ?? null;
  }

  const contextWindow = numberOrUndefined(context?.context_window_size);
  if (contextWindow !== undefined) metrics.contextWindow = contextWindow;

  const fiveHourPct = numberOrUndefined(fiveHour?.used_percentage);
  if (fiveHourPct !== undefined) metrics.fiveHourPct = fiveHourPct;

  const fiveHourResetsAt = numberOrUndefined(fiveHour?.resets_at);
  if (fiveHourResetsAt !== undefined) metrics.fiveHourResetsAt = fiveHourResetsAt;

  const sevenDayPct = numberOrUndefined(sevenDay?.used_percentage);
  if (sevenDayPct !== undefined) metrics.sevenDayPct = sevenDayPct;

  const sevenDayResetsAt = numberOrUndefined(sevenDay?.resets_at);
  if (sevenDayResetsAt !== undefined) metrics.sevenDayResetsAt = sevenDayResetsAt;

  return metrics;
}
