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
  /** 0–100. A ring is only ever drawn for a number somebody reported. */
  pct: number;
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
 * ## There is no unknown case, and that is the point
 *
 * This used to accept `null` and render the **track only**, dimmed, beside an em
 * dash — the honest refusal to draw a ring at zero for a number nobody had
 * reported. `rate_limits` is absent from Claude Code's status line payload until
 * a session's first API response and absent for good under API-key auth, and
 * `context_window.used_percentage` is null until the first assistant turn, so
 * the empty ring was the *common* first impression of every session.
 *
 * The refusal now happens one level up: `model-chip.tsx` renders no stat at all
 * for a number it does not have, so no caller has an unknown to pass. Taking
 * `number` rather than `number | null` is what keeps it that way — a future
 * caller cannot reintroduce the placeholder by handing this a null.
 */
export function GaugeRing({ pct, label, size = 14, className }: GaugeRingProps) {
  const stroke = 2;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;

  // Clamped rather than trusted: the payload is a number from another process,
  // and a value outside 0–100 would render as an arc wrapping past itself.
  const value = Math.min(Math.max(pct, 0), 100);
  const offset = circumference * (1 - value / 100);

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={`${label}: ${Math.round(value)}%`}
      className={cn('shrink-0', className)}
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={stroke}
        className="text-border"
      />
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
    </svg>
  );
}
