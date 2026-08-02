import { isSession } from '@/types/entity';

import { StatusDot } from '@components/ui/status-dot';
import { useEntity } from '@stores/hive-store';
import { useOpenTab } from '@stores/ui-store';

interface TicketSessionRowProps {
  id: string;
}

/**
 * One session attached to a ticket.
 *
 * Renders nothing for an id the store does not know — tickets name sessions the
 * simulation may never create, and the story asks for those to be skipped
 * silently rather than leaving a hole in the card.
 *
 * The negative margin lets the hover highlight bleed to the card's padding edge
 * while the text still lines up with the title above it.
 */
export function TicketSessionRow({ id }: TicketSessionRowProps) {
  const entity = useEntity(id);
  const openTab = useOpenTab();

  if (!entity || !isSession(entity)) return null;

  return (
    <button
      type="button"
      onClick={() => openTab(id)}
      className="-mx-1.5 flex items-center gap-2 rounded-md px-1.5 py-[3px] hover:bg-hover"
    >
      {/*
        Labelled, unlike the projects panel: this row has no visible status
        text, so without it the dot would carry status by colour alone.
      */}
      <StatusDot status={entity.status} label={`${entity.id} status`} />

      <span className="flex-1 truncate text-left font-mono text-[12px] text-muted">
        {entity.id}
      </span>

      <span className="shrink-0 font-mono text-[10px] text-subtle">
        {entity.project}
      </span>
    </button>
  );
}
