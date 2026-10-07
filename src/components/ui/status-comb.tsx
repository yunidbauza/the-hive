import { Hexagon } from '@phosphor-icons/react';

import { cn } from '@/lib/utils';
import type { SessionStatus } from '@/types/entity';

import { statusText } from '@components/ui/status-dot';
import type { AgentStatus } from '@shared/agent-contract';
import type { IdleDetail } from '@shared/hook-contract';

/** Quiet states: the comb goes hollow. */
const HOLLOW: ReadonlySet<string> = new Set(['idle', 'sleeping']);

/**
 * The status comb (HIVE-229): an 11px hexagon in the status colour, filled
 * while busy and hollow when idle or asleep, pulsing only while `working`.
 * So `working (agents)` is a hollow green comb beside a solid one (HIVE-83's
 * distinction, carried by the glyph). Decoration: a status label always sits
 * in the same row.
 */
export function StatusComb({
  status,
  detail,
  className,
}: {
  status: SessionStatus | AgentStatus;
  detail?: IdleDetail;
  className?: string;
}) {
  const hollow = HOLLOW.has(status);
  return (
    <Hexagon
      size={11}
      weight={hollow ? 'bold' : 'fill'}
      aria-hidden="true"
      data-shape={hollow ? 'hollow' : 'filled'}
      className={cn('shrink-0', statusText(status, detail), status === 'working' && 'animate-ccpulse', className)}
    />
  );
}
