import { ArrowDown, ArrowClockwise } from '@phosphor-icons/react';

import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { cn } from '@/lib/utils';

export type PullIndicatorPhase = 'idle' | 'pulling' | 'armed' | 'refreshing';

interface PullIndicatorProps {
  /** How far the list has been pulled, in pixels. Drives the height directly. */
  distance: number;
  phase: PullIndicatorPhase;
}

const LABEL: Record<Exclude<PullIndicatorPhase, 'idle'>, string> = {
  pulling: 'Pull to refresh',
  armed: 'Release to refresh',
  refreshing: 'Refreshing…',
};

/**
 * The strip that appears above a list while it is being overscrolled.
 *
 * Height is the pull distance, unsmoothed, so the strip tracks the trackpad
 * one-to-one on the way out — a transition here would lag the fingers and read
 * as the app being slow rather than as the gesture being damped. The spring
 * back is the opposite case: nothing is driving it, so that one *is* animated,
 * and the two are told apart by the phase rather than by a timer.
 *
 * ## What it says, and to whom
 *
 * `role="status"` with the label only rendered once the refresh is actually
 * running: "pull to refresh" is a caption on a gesture a screen-reader user is
 * not making, and announcing every pixel of it would be noise. That the list
 * *did* refresh is worth one polite announcement.
 *
 * Colour comes from the ordinary text tokens, so it follows every theme
 * including the six that paint from a runtime style element.
 */
export function PullIndicator({ distance, phase }: PullIndicatorProps) {
  const reduced = useReducedMotion();

  if (phase === 'idle') return null;

  const armed = phase === 'armed';
  const refreshing = phase === 'refreshing';

  return (
    <div
      role="status"
      aria-live="polite"
      data-phase={phase}
      style={{ height: distance }}
      className={cn(
        'flex shrink-0 items-end justify-center overflow-hidden',
        // Only the release is animated — see the note above.
        refreshing && !reduced && 'transition-[height] duration-200',
      )}
    >
      <div
        className={cn(
          'flex items-center gap-1.5 pb-1 text-[11px]',
          armed || refreshing ? 'text-muted' : 'text-subtle',
        )}
      >
        {refreshing ? (
          <ArrowClockwise
            size={11}
            className={cn(!reduced && 'animate-spin')}
            aria-hidden="true"
          />
        ) : (
          <ArrowDown
            size={11}
            aria-hidden="true"
            className={cn(
              'transition-transform duration-150',
              armed && 'rotate-180',
            )}
          />
        )}
        {/*
          `undefined` rather than `false`: an explicit `aria-hidden="false"` is
          valid but says nothing, and the point of the attribute here is to
          suppress the two labels that caption a gesture rather than an event.
        */}
        <span aria-hidden={refreshing ? undefined : true}>{LABEL[phase]}</span>
      </div>
    </div>
  );
}
