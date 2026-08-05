import { cn } from '@/lib/utils';
import type { SessionStatus } from '@/types/entity';

/** Sessions have five states; agents are always `online`. */
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
 * The same six colours as text, for the label beside the dot.
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
  className?: string;
}

/**
 * A 7px status dot.
 *
 * The pulse is `animate-ccpulse` from `global.css` — never a hand-written
 * keyframe, so one definition drives every pulsing surface in the app.
 */
export function StatusDot({ status, pulse, label, className }: StatusDotProps) {
  const pulsing = pulse ?? status === 'working';

  return (
    <span
      aria-hidden={label ? undefined : 'true'}
      className={cn(
        'inline-flex size-[7px] shrink-0 rounded-full',
        STATUS_FILL[status],
        pulsing && 'animate-ccpulse',
        className,
      )}
    >
      {label ? (
        <span className="sr-only">{`${label}: ${STATUS_LABEL[status]}`}</span>
      ) : null}
    </span>
  );
}
