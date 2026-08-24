import { cn } from '@/lib/utils';
import type { SessionStatus } from '@/types/entity';

import type { IdleDetail } from '@shared/hook-contract';

/** Sessions have four states; agents are always `online`. */
export type DotStatus = SessionStatus | 'online';

/**
 * `terminated` is muted, not blue, and not `subtle` either (story 108).
 *
 * Blue is `done` — this palette's "there is something here" colour, and a
 * finished session is something: a PR to read, a diff to merge. A terminated one
 * is a row explaining an absence, so it takes the neutral grey. It is
 * deliberately *not* `subtle`, which `idle` already owns: idle and terminated
 * are the two states most easily confused — both quiet, one still alive — and
 * giving them the same dot would erase the only distinction that matters when
 * deciding whether to go look.
 */
const STATUS_FILL: Record<DotStatus, string> = {
  working: 'bg-green',
  waiting: 'bg-amber',
  idle: 'bg-subtle',
  done: 'bg-brand',
  terminated: 'bg-muted',
  online: 'bg-green',
};

/**
 * The same colours as text, for the label beside the dot.
 *
 * Paired with `STATUS_FILL` deliberately: a dot and its label drifting to
 * different colours is the exact bug this file exists to prevent. Stories 031
 * and 041 render the label; 032 has no visible label and uses the dot alone.
 */
export const STATUS_TEXT: Record<DotStatus, string> = {
  working: 'text-green',
  waiting: 'text-amber',
  idle: 'text-subtle',
  done: 'text-brand',
  terminated: 'text-muted',
  online: 'text-green',
};

/**
 * The words that go with the colours.
 *
 * Exported because status is never carried by colour alone: the projects panel
 * (031) and the orchestrator table (041) render these as visible labels, and
 * re-deriving the `waiting → "needs input"` rename in three places is how the
 * three drift apart.
 */
export const STATUS_LABEL: Record<DotStatus, string> = {
  working: 'working',
  waiting: 'needs input',
  idle: 'idle',
  done: 'done',
  terminated: 'terminated',
  online: 'online',
};

/**
 * The hollow variant: a ring in the same colour, for a session that is quiet
 * but not empty (HIVE-83).
 *
 * Filled means nothing is running; hollow means something is. It costs no new
 * colour and no new glyph, and the one genuinely free session is then the only
 * solid grey dot on the panel — which is the glance the fleet view exists to
 * serve. A ring is a border rather than a fill, so it survives the light theme
 * where a lightened grey washes out.
 *
 * **Only ever applied to grey.** `waiting` keeps its solid amber so "something
 * needs you" stays the loudest thing on screen.
 */
const STATUS_RING: Record<DotStatus, string> = {
  working: 'border-green',
  waiting: 'border-amber',
  idle: 'border-subtle',
  done: 'border-brand',
  terminated: 'border-muted',
  online: 'border-green',
};

/**
 * The word beside the dot, including what is still running.
 *
 * A function rather than a sixth entry in `STATUS_LABEL`, because the detail is
 * orthogonal to the status: the detail rides alongside `SessionStatus` rather
 * than multiplying its members, and the dot's palette is unchanged by it.
 */
export function statusLabel(status: DotStatus, detail?: IdleDetail): string {
  if (status === 'idle' && detail !== undefined) return `idle (${detail})`;
  return STATUS_LABEL[status];
}

interface StatusDotProps {
  status: DotStatus;
  /** Defaults to pulsing only while `working`. Pass `false` to force it off. */
  pulse?: boolean;
  /**
   * What the dot describes — e.g. `'lead-form status'`, which is announced as
   * `"lead-form status: needs input"`.
   *
   * **Omit it when a visible status label sits beside the dot**, which is the
   * common case; the dot is then decoration and is hidden from the
   * accessibility tree rather than duplicating the text next to it.
   */
  label?: string;
  /**
   * What a quiet session is still running (HIVE-83), folded into the sr-only
   * text alongside `label`.
   *
   * Without this, a labelled dot on a hollow `idle` session announced plain
   * "idle" — the exact distinction the ring exists to carry, dropped for the
   * one audience that cannot see the ring at all.
   */
  detail?: IdleDetail;
  className?: string;
}

/**
 * A 7px status dot.
 *
 * The pulse is `animate-ccpulse` from `global.css` — never a hand-written
 * keyframe, so one definition drives every pulsing surface in the app.
 */
export function StatusDot({
  status,
  pulse,
  label,
  detail,
  className,
}: StatusDotProps) {
  const pulsing = pulse ?? status === 'working';
  /**
   * Derived, not passed in (HIVE-83 review fix). A caller used to hand-compute
   * this from `idleDetail` alone, which could not see `status` — a `done` row
   * with a stale `idleDetail` (see `hive-store.ts`'s `/clear` retirement) would
   * then draw a hollow ring in `STATUS_RING.done`, the brand colour, instead of
   * the solid fill. Gating on `status === 'idle'` here makes a hollow non-grey
   * dot unrepresentable regardless of what the caller passes.
   */
  const hollow = status === 'idle' && detail !== undefined;

  return (
    <span
      aria-hidden={label ? undefined : 'true'}
      className={cn(
        'inline-flex size-[7px] shrink-0 rounded-full',
        hollow ? `border-[1.5px] ${STATUS_RING[status]}` : STATUS_FILL[status],
        pulsing && 'animate-ccpulse',
        className,
      )}
    >
      {label ? (
        <span className="sr-only">{`${label}: ${statusLabel(status, detail)}`}</span>
      ) : null}
    </span>
  );
}
