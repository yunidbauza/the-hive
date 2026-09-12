import { Check } from '@phosphor-icons/react';

import { cn } from '@/lib/utils';

import type { PlanTaskStatus } from '@shared/plan-contract';

const LABEL: Record<PlanTaskStatus, string> = {
  pending: 'pending',
  in_progress: 'in progress',
  completed: 'done',
};

interface PlanGlyphProps {
  /** 0-based position in the plan; the ring shows `index + 1`. */
  index: number;
  status: PlanTaskStatus;
  /** A plan-mode plan: nothing has started, so a pending task reads "proposed". */
  proposed?: boolean;
}

/**
 * One task's ring (HIVE-181): numbered on the track colour while pending,
 * green and pulsing while current, a filled green check once done.
 *
 * Status is never colour alone — the label carries it — so the pulse is
 * decoration and collapses under reduced motion.
 */
export function PlanGlyph({ index, status, proposed = false }: PlanGlyphProps) {
  const done = status === 'completed';
  const label = proposed && status === 'pending' ? 'proposed' : LABEL[status];
  return (
    <span
      role="img"
      aria-label={`Task ${String(index + 1)}, ${label}`}
      className={cn(
        'inline-grid size-4 shrink-0 place-items-center rounded-full border-[1.5px] font-mono text-[9px] leading-none font-semibold',
        done && 'border-green bg-green text-panel',
        status === 'in_progress' && 'border-green text-green motion-safe:animate-ccpulse',
        status === 'pending' && 'border-term-track text-subtle',
      )}
    >
      {done ? <Check size={10} weight="bold" aria-hidden /> : index + 1}
    </span>
  );
}
