import { Brain } from '@phosphor-icons/react';

import {
  contextMeter,
  contextPct,
  DEFAULT_EFFORT,
  modelLabel,
  utilisationPct,
} from '@/lib/session-metrics';
import { isSession } from '@/types/entity';

import { Chip } from '@components/ui/chip';
import { useActiveEntity } from '@stores/hive-store';

/**
 * The active session's model, effort, context meter, and weekly utilisation.
 *
 * Renders nothing unless the active tab *is* a session: the orchestrator has no
 * model of its own, and agents are long-lived workers rather than a metered
 * conversation. Returning null rather than an empty chip keeps the header's
 * gap from opening a hole next to the wordmark.
 *
 * All four numbers are mock and derived — see `lib/session-metrics.ts`.
 */
export function ModelChip() {
  const entity = useActiveEntity();

  if (!entity || !isSession(entity)) return null;

  const pct = contextPct(entity.id, entity.branch);
  const label = `${modelLabel(entity.model)} (1M) · ${entity.effort ?? DEFAULT_EFFORT}`;

  return (
    <Chip title={`${label} — ${pct}% of context used`}>
      <Brain size={13} weight="regular" className="shrink-0 text-brand" />
      {`${label} | ${contextMeter(pct)} ${pct}% | ${utilisationPct(entity.id)}% · resets 02:30 PM`}
    </Chip>
  );
}
