import { cn } from '@/lib/utils';

/** Where the arc changes colour. Below the first is calm; at or above the second is urgent. */
export const GAUGE_WARN_PCT = 60;
export const GAUGE_CRITICAL_PCT = 85;

/** The tone a percentage earns. Exported so callers can colour their own text to match. */
export function gaugeTone(pct: number): 'brand' | 'amber' | 'red' {
  if (pct >= GAUGE_CRITICAL_PCT) return 'red';
  if (pct >= GAUGE_WARN_PCT) return 'amber';
  return 'brand';
}

const TONE_TEXT = {
  brand: 'text-brand',
  amber: 'text-amber',
  red: 'text-red',
} as const;

interface GaugeRingProps {
  /** 0–100, or `null` when the number is not known yet. */
  pct: number | null;
  /** Names the quantity for assistive tech — "context", "session limit", "weekly limit". */
  label: string;
  /** Diameter in px. */
  size?: number;
  className?: string;
}

/**
 * A small arc gauge — the header's context and rate-limit meters (HIVE-79).
 *
 * ## Why this replaced a block-glyph bar
 *
 * The chip used to render `███░░░░░░░` from `contextMeter()`. Two problems, and
 * only the second is cosmetic: a glyph bar's width is a **font** property, so it
 * changed size between the app's mono stack and any fallback, and at ten
 * characters it cost more horizontal room than the three gauges here do
 * together. The header has one row and the counts want the rest of it.
 *
 * ## Why SVG and not a div with a width
 *
 * A ring reads as a proportion at 14px where a 14px bar reads as a smudge, and
 * the arc's length carries the value without needing a track long enough to
 * measure against.
 *
 * ## Colour
 *
 * From `currentColor` on two circles rather than from props, so the palette
 * stays in `tokens.css` where the design system can assert it — a hex here
 * would be the exact thing AGENTS.md bans. The track is `text-border`; the arc
 * takes {@link gaugeTone}, which is also what the neighbouring percentage text
 * uses so the two can never disagree.
 *
 * ## The unknown case
 *
 * `pct === null` renders the **track only**, dimmed. That is not a styling
 * nicety: `rate_limits` is absent from Claude Code's status line payload until
 * the first API response of a session, and absent entirely when a session
 * authenticates with an API key rather than a subscription. A ring at zero
 * would assert "you have used none of your weekly limit", which is a different
 * and possibly false claim. Callers pair this with an em dash instead of a
 * number, so nothing on screen invents a value.
 */
export function GaugeRing({ pct, label, size = 14, className }: GaugeRingProps) {
  const stroke = 2;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;

  const known = pct !== null;
  // Clamped rather than trusted: the payload is a number from another process,
  // and a value outside 0–100 would render as an arc wrapping past itself.
  const value = known ? Math.min(Math.max(pct, 0), 100) : 0;
  const offset = circumference * (1 - value / 100);

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={known ? `${label}: ${Math.round(value)}%` : `${label}: unknown`}
      className={cn('shrink-0', className)}
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={stroke}
        className={known ? 'text-border' : 'text-border-soft'}
      />
      {known ? (
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          /* Starts the sweep at twelve o'clock; SVG's own zero is three. */
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          className={TONE_TEXT[gaugeTone(value)]}
        />
      ) : null}
    </svg>
  );
}
