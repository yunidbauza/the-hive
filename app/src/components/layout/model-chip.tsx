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
 * conversation. Returning null rather than an empty chip lets the header's
 * centre track collapse to zero width instead of holding an empty pill.
 *
 * The chip sits in the header's centre track. It is the *last* zone to give up
 * width, not the first — the counts absorb the header's deficit first (see
 * `header.tsx`) — but it still has to be able to, so the text carries
 * `min-w-0 truncate`. `Chip` is `whitespace-nowrap` by contract and expects
 * callers that can overflow to truncate. The text needs its own element to
 * ellipsise: as a bare child of the chip's flex row it would be an anonymous
 * item next to the icon, and `text-overflow` would have nothing to act on.
 * `min-w-0` is what actually permits the shrink — `truncate` alone leaves a
 * flex item at its content width. The full string stays reachable in the
 * `title` tooltip either way.
 *
 * All four numbers are mock and derived — see `lib/session-metrics.ts`.
 */
export function ModelChip() {
  const entity = useActiveEntity();

  if (!entity || !isSession(entity)) return null;

  const pct = contextPct(entity.id, entity.branch);
  const label = `${modelLabel(entity.model)} (1M) · ${entity.effort ?? DEFAULT_EFFORT}`;
  const text = `${label} | ${contextMeter(pct)} ${pct}% | ${utilisationPct(entity.id)}% · resets 02:30 PM`;

  return (
    // The tooltip carries the whole string, not just the label, so a truncated
    // chip loses nothing but pixels.
    <Chip title={`${text} — ${pct}% of context used`} className="min-w-0">
      <Brain size={13} weight="regular" className="shrink-0 text-brand" />
      <span className="min-w-0 truncate">{text}</span>
    </Chip>
  );
}
