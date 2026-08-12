/**
 * What a session reports about its own usage (HIVE-79).
 *
 * ## Where these numbers come from
 *
 * Claude Code runs a **status line** command on a cadence — session start, each
 * assistant message, `/compact`, and a `refreshInterval` timer — and pipes a
 * JSON document to it on stdin. That document carries the model, the reasoning
 * effort, how full the context window is, and the subscriber rate limits. The
 * Hive injects its own status line into every session it spawns, so this is the
 * session describing itself rather than the app inferring anything.
 *
 * ## Why the status line and not the transcript
 *
 * The transcript JSONL would give context usage — the last assistant turn's
 * `usage` block — and nothing else. **Rate limits appear in no file on disk.**
 * `/usage` renders them inside the CLI and the status line payload carries them
 * as data; there is no third source. One payload for all four numbers also means
 * one cadence and one moment of observation, so the chip can never show a
 * context percentage from one turn beside a limit from another.
 *
 * ## Why every field is optional
 *
 * Because every field is genuinely absent sometimes, and a default would be a
 * lie in each case:
 *
 * - `rate_limits` is present only for Claude.ai subscribers, only **after the
 *   first API response** of a session, and never when the session authenticated
 *   with `ANTHROPIC_API_KEY`. Each window may be absent independently.
 * - `context_window.used_percentage` is `null` before the first API call and
 *   again after `/compact` until the next one.
 * - `effort` is absent for models with no reasoning-effort parameter.
 *
 * The renderer **renders no stat at all** for a value it does not have — no
 * gauge, no percentage, no separator. It used to pair each absence with an em
 * dash, which was the same refusal to invent a zero in a shape that reserved
 * space for a number that may never come. Zero would assert something false
 * about a limit the user may be close to; a placeholder asserts that an answer
 * is imminent.
 *
 * ## Absent, and absent again: why one field says `null` out loud
 *
 * A field omitted from a patch means "this payload did not carry it", and the
 * store keeps whatever it last knew. That is right for the rate limits, which
 * are account-global, move slowly, and simply stop being reported under API-key
 * auth — the last reading is still the best one available.
 *
 * It is wrong for the context percentage, which is a fact **about this
 * conversation** and goes null again after `/compact`. Preserving the last
 * reading there would show the pre-compact number — the one thing the user just
 * changed — as though it were current. So {@link SessionMetrics.contextPct}
 * carries an explicit `null` for "the session reported, and reported that it
 * does not know", which the store writes through and the chip renders as no
 * stat. Omission and `null` are different messages and this is the field that
 * needs both.
 *
 * Types and constants only — both processes import it.
 */

/** One observation of a session's usage. Every field independently absent. */
export interface SessionMetrics {
  /** `model.display_name`, e.g. `Opus 4.5`. */
  model?: string;
  /** `effort.level` — `low` … `max`. */
  effort?: string;
  /**
   * `context_window.used_percentage`, 0–100.
   *
   * **`null` is a value here, not an absence.** It means the payload carried a
   * `context_window` whose percentage the session could not state — before the
   * first assistant turn, and again after `/compact` — and it clears whatever
   * the store last knew. The key is omitted only when the payload carried no
   * `context_window` at all.
   */
  contextPct?: number | null;
  /** `context_window.context_window_size` in tokens — 200000, or 1000000 extended. */
  contextWindow?: number;
  /** `rate_limits.five_hour.used_percentage`, 0–100. */
  fiveHourPct?: number;
  /** `rate_limits.five_hour.resets_at` — **epoch seconds**, not milliseconds. */
  fiveHourResetsAt?: number;
  /** `rate_limits.seven_day.used_percentage`, 0–100. */
  sevenDayPct?: number;
  /** `rate_limits.seven_day.resets_at` — **epoch seconds**, not milliseconds. */
  sevenDayResetsAt?: number;
}

/**
 * Main telling the renderer what a session reported.
 *
 * Its own channel rather than a field on `SessionStatusEvent`, for the reason
 * `session:branch` has one: these arrive on a completely different cadence from
 * status ticks, and folding them together would make every status change carry
 * numbers nobody observed on that tick.
 */
export interface SessionMetricsEvent {
  entityId: string;
  metrics: SessionMetrics;
}

/**
 * The receiver path the injected status line POSTs to.
 *
 * A second path on the socket `hook-contract.ts` already describes, with the
 * same per-launch token and the same `x-hive-session` correlation. It is
 * separate from {@link HOOK_PATH} because the bodies are unrelated shapes and a
 * single endpoint would have to sniff which one it got.
 */
export const METRICS_PATH = '/statusline';

/**
 * The largest status line body the receiver will read.
 *
 * Much smaller than the hook cap. A hook payload carries `tool_input`, which for
 * an Edit is a whole file; a status line payload is a fixed set of scalars and a
 * few paths. Anything approaching this is not the document this endpoint is for.
 */
export const METRICS_MAX_BODY_BYTES = 16 * 1024;

/**
 * How often the injected status line re-runs while a session is idle, in seconds.
 *
 * Claude Code's own triggers are event-driven — a new assistant message,
 * `/compact`, a permission-mode change — and they go quiet exactly when the user
 * is most likely to be *looking* at the header rather than typing into the
 * terminal. Without a timer a session that finished ten minutes ago would still
 * be showing the reset times it reported then.
 *
 * Thirty seconds: the numbers move slowly (a five-hour window and a seven-day
 * one), and each tick is one short-lived `curl` per live session.
 */
export const METRICS_REFRESH_SECONDS = 30;
