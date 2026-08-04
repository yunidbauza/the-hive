import { cn } from '@/lib/utils';
import { isAgent } from '@/types/entity';

import { Icon } from '@components/ui/icon';
import { useEntity } from '@stores/hive-store';
import { useActiveTab, useOpenTab } from '@stores/ui-store';

interface AgentRowProps {
  id: string;
}

/**
 * One background agent: avatar tile, id, and what it watches.
 *
 * Renders nothing for an id that is not an agent, matching the session rows in
 * 031/032 — panels stay defensive about a store that other stories mutate
 * underneath them.
 */
export function AgentRow({ id }: AgentRowProps) {
  const entity = useEntity(id);
  const activeTab = useActiveTab();
  const openTab = useOpenTab();

  if (!entity || !isAgent(entity)) return null;

  const active = activeTab === id;

  return (
    <button
      type="button"
      onClick={() => openTab(id)}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'flex items-center gap-2.5 rounded-lg px-2.5 py-[var(--cc-row-py)]',
        active ? 'bg-active' : 'hover:bg-hover',
      )}
    >
      <span className="relative flex size-7 shrink-0 items-center justify-center rounded-lg bg-chip">
        <Icon name={entity.icon} size={15} className="text-brand" />

        {/*
          Not `StatusDot`: that atom is a 7px unringed dot, and this one is 9px
          with a 2px panel-coloured ring so it reads as lifted off the tile.
        */}
        <span
          aria-hidden="true"
          className="absolute -right-0.5 -bottom-0.5 size-[9px] rounded-full border-2 border-panel bg-green"
        />
      </span>

      <span className="flex min-w-0 flex-1 flex-col text-left">
        <span className="truncate font-mono text-[12.5px]">{entity.id}</span>
        <span className="truncate text-[11px] text-subtle">{entity.sub}</span>
        {/*
          Last, so the row announces "slack-agent … online" rather than leading
          with its status. Agents are always online in this phase, but the state
          still may not be carried by the green dot's colour alone.
        */}
        <span className="sr-only">online</span>
      </span>
    </button>
  );
}
