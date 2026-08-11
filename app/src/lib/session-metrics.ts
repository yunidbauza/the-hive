import type { Model } from '@/types/entity';

import type { SessionMetrics } from '@shared/metrics-contract';


/**
 * The numbers behind the header's model chip.
 *
 * ## They used to be invented, and now they are observed (HIVE-79)
 *
 * Every value here was once *derived* from the session's own identifiers —
 * `5 + ((id.length * 7 + branch.length * 13) % 60)` and friends. That was an
 * honest choice while there was no meter to read: a stored percentage would have
 * needed a fake clock to move it, and a random one would have jittered on every
 * render. It was also, on screen, indistinguishable from a real number, which is
 * what made it worth removing rather than improving.
 *
 * The real source is Claude Code's **status line payload**. A status line
 * command receives a JSON document on stdin carrying `context_window`,
 * `rate_limits`, `model` and `effort`, and the Hive injects its own status line
 * into every session it spawns — see `electron/main/hooks/settings.ts`. So the
 * chip now reports what the session reports about itself.
 *
 * ## What absence means, and why it is not zero
 *
 * `rate_limits` appears only for Claude.ai subscribers, and only **after the
 * first API response** of a session. It is absent entirely when a session
 * authenticates with `ANTHROPIC_API_KEY`. Each window may be independently
 * absent. So every accessor here answers `null` rather than a default, and the
 * chip renders an em dash: "we have not been told" and "you have used none of
 * it" are different claims and only one of them is safe to make up.
 */

/** Model id → the name shown to the user, for a session that has not reported one. */
const MODEL_LABELS: Record<Model, string> = {
  opus: 'Opus 4.5',
  sonnet: 'Sonnet 4.5',
  haiku: 'Haiku 4.5',
  fable: 'Fable 1',
};

/** Sessions with no explicit model are Opus at high effort, as in the concept. */
export const DEFAULT_MODEL: Model = 'opus';
export const DEFAULT_EFFORT = 'high';

/** What the chip renders in place of a number nobody has reported. */
export const UNKNOWN = '—';

/**
 * A context window worth naming in the label.
 *
 * Only the extended window earns a suffix: `Opus 4.5 (1M)` says something the
 * user cannot otherwise see, where `Opus 4.5 (200k)` would just be the default
 * restated on every chip. The threshold is halfway between the two documented
 * sizes so a future window lands on the right side of it without an edit.
 */
const EXTENDED_WINDOW_TOKENS = 600_000;

/**
 * The earliest `resets_at` worth believing.
 *
 * `0` is the value a null becomes when it passes through something that
 * defaults, and it renders as a perfectly plausible `12a` — a confident wrong
 * time in the one place the design insists on an em dash. Anything before this
 * app existed is not a reset time; it is a bug upstream or a field that meant
 * nothing. 2020-01-01, chosen because it needs only to be *after* the epoch and
 * *before* any real reset.
 */
const EARLIEST_PLAUSIBLE_RESET = 1_577_836_800;

export function modelLabel(model: Model = DEFAULT_MODEL): string {
  return MODEL_LABELS[model];
}

/**
 * The model, effort and window, preferring what the session said about itself.
 *
 * The session's own `model.display_name` wins over the id the picker recorded,
 * because a session can change model mid-conversation with `/model` and the
 * entity would still carry whatever it was started with. Same for `effort`,
 * which `/effort` changes. The entity is the fallback, not the source.
 */
export function chipLabel(
  metrics: SessionMetrics | undefined,
  model: Model | undefined,
  effort: string | undefined,
): string {
  const name = metrics?.model ?? modelLabel(model);
  const level = metrics?.effort ?? effort ?? DEFAULT_EFFORT;
  /*
    Derived, not the literal `(1M)` this first shipped as. The threshold is
    documented as future-proof — a later window "lands on the right side of it
    without an edit" — which was only half true while the *label* was hardcoded:
    a 2M window would have been announced as 1M, wrong, in the one place the
    user cannot otherwise see the size.
  */
  const size = metrics?.contextWindow;
  const window =
    size !== undefined && size >= EXTENDED_WINDOW_TOKENS
      ? ` (${Math.round(size / 1_000_000)}M)`
      : '';
  return `${name}${window} · ${level}`;
}

/** A percentage the payload carried, clamped, or `null` when it carried none. */
export function pctOrNull(value: number | undefined): number | null {
  if (value === undefined || !Number.isFinite(value)) return null;
  return Math.min(Math.max(Math.round(value), 0), 100);
}

/** `46%`, or the em dash. */
export function pctLabel(pct: number | null): string {
  return pct === null ? UNKNOWN : `${pct}%`;
}

/**
 * `2:30p` — the compact clock the chip uses for the five-hour window.
 *
 * Deliberately terser than a locale time string. This sits in a one-row header
 * beside two other stats, and `2:30 PM` costs three more characters in the zone
 * that truncates first. The meridiem keeps a single lowercase letter because
 * that is enough to disambiguate and reads as a unit rather than a word.
 *
 * `resets_at` is **epoch seconds**, not milliseconds — the multiplication is the
 * one thing in this file that silently produces a date in 1970 if forgotten.
 */
export function clockLabel(epochSeconds: number | undefined): string | null {
  if (epochSeconds === undefined || !Number.isFinite(epochSeconds)) return null;
  // See EARLIEST_PLAUSIBLE_RESET: `0` would otherwise render as a confident
  // `12a`, which is exactly the fabricated value this module refuses to emit.
  if (epochSeconds < EARLIEST_PLAUSIBLE_RESET) return null;
  const at = new Date(epochSeconds * 1000);
  if (Number.isNaN(at.getTime())) return null;

  const hours = at.getHours();
  const minutes = at.getMinutes();
  const meridiem = hours < 12 ? 'a' : 'p';
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return minutes === 0
    ? `${hour12}${meridiem}`
    : `${hour12}:${String(minutes).padStart(2, '0')}${meridiem}`;
}

/**
 * `Thu 5p` — the same clock with the weekday, for the seven-day window.
 *
 * The day is what makes a weekly reset actionable: "resets 5p" on a Monday and
 * on a Friday are the same string and completely different news. The five-hour
 * window never needs it, because it always lands inside today or tomorrow
 * morning and the time alone is unambiguous enough at a glance.
 */
export function dayClockLabel(epochSeconds: number | undefined): string | null {
  const clock = clockLabel(epochSeconds);
  if (clock === null || epochSeconds === undefined) return null;
  const day = new Date(epochSeconds * 1000).toLocaleDateString(undefined, {
    weekday: 'short',
  });
  return `${day} ${clock}`;
}
