import { cn } from '@/lib/utils';

export type BadgeTone = 'danger' | 'brand' | 'muted' | 'green';

const TONE_FILL: Record<BadgeTone, string> = {
  // `on-danger`, not `on-brand`: one token cannot be legible on both fills.
  danger: 'bg-danger-solid text-on-danger',
  brand: 'bg-brand-fill text-on-brand',
  // The tab-bar count (story 030): a quiet chip, not an alert.
  muted: 'bg-chip text-muted',
  /*
    Plan progress on a session row (HIVE-182). A tint, not a solid fill: it
    sits beside a status dot that keeps priority, and green text on its own
    15% tint reads in both themes with no "on-green" token to invent.
  */
  green: 'bg-green/15 text-green',
};

interface BadgeProps {
  count: number;
  tone?: BadgeTone;
  /**
   * Drawn and announced in place of `count`, for a count that is not a single
   * number — plan progress reads `3/7` (HIVE-182). `count` still decides
   * whether the badge renders at all.
   */
  text?: string;
  /**
   * What the number means, for screen readers — e.g. `'unread notifications'`.
   * A bare digit is meaningless out of visual context.
   *
   * **Omit it when the badge sits inside an already-labelled control.** An
   * `aria-label` on an ancestor replaces its descendants' text entirely, so a
   * label here would never be announced; the badge becomes decoration and is
   * hidden from the accessibility tree instead of quietly duplicating.
   */
  label?: string;
  className?: string;
}

/**
 * A count badge. Renders nothing at zero — an empty badge is visual noise, and
 * every caller so far ("3 unread", "2 open PRs") means *nothing to see* by it.
 *
 * `min-w-4` with horizontal padding keeps single digits circular and lets
 * three-digit counts grow into a lozenge rather than clipping.
 */
export function Badge({ count, tone = 'danger', text, label, className }: BadgeProps) {
  if (count <= 0) return null;
  const shown = text ?? String(count);

  return (
    <span
      aria-hidden={label ? undefined : 'true'}
      className={cn(
        'inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold leading-none',
        TONE_FILL[tone],
        className,
      )}
    >
      {label ? <span aria-hidden="true">{shown}</span> : shown}
      {label ? <span className="sr-only">{`${shown} ${label}`}</span> : null}
    </span>
  );
}
