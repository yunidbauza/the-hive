import { cn } from '@/lib/utils';

export type BadgeTone = 'danger' | 'brand' | 'muted';

const TONE_FILL: Record<BadgeTone, string> = {
  // `on-danger`, not `on-brand`: one token cannot be legible on both fills.
  danger: 'bg-danger-solid text-on-danger',
  brand: 'bg-brand-fill text-on-brand',
  // The tab-bar count (story 030): a quiet chip, not an alert.
  muted: 'bg-chip text-muted',
};

interface BadgeProps {
  count: number;
  tone?: BadgeTone;
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
export function Badge({ count, tone = 'danger', label, className }: BadgeProps) {
  if (count <= 0) return null;

  return (
    <span
      aria-hidden={label ? undefined : 'true'}
      className={cn(
        'inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold leading-none',
        TONE_FILL[tone],
        className,
      )}
    >
      {label ? <span aria-hidden="true">{count}</span> : count}
      {label ? <span className="sr-only">{`${count} ${label}`}</span> : null}
    </span>
  );
}
