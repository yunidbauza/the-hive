import { cn } from '@/lib/utils';
import { isAgent } from '@/types/entity';

import { Icon } from '@components/ui/icon';
import { STATUS_FILL, STATUS_LABEL } from '@components/ui/status-dot';
import { useEntity, useOpenEntity } from '@stores/hive-store';
import { useActiveTab } from '@stores/ui-store';

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
  const openEntity = useOpenEntity();

  if (!entity || !isAgent(entity)) return null;

  const active = activeTab === id;
  const broken = entity.invalid !== undefined;

  return (
    <button
      type="button"
      onClick={() => openEntity(id)}
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

          The fill is the agent's real state rather than a hardcoded green
          (HIVE-114). It used to be green unconditionally, which described a
          fixture: an agent is a definition on disk, and between two wakes
          there is no process to be online. An unparseable definition takes
          amber, matching how the Skills pane marks a file it could not read.
        */}
        <span
          aria-hidden="true"
          className={cn(
            'absolute -right-0.5 -bottom-0.5 size-[9px] rounded-full border-2 border-panel',
            broken ? 'bg-amber' : STATUS_FILL[entity.status],
          )}
        />
      </span>

      <span className="flex min-w-0 flex-1 flex-col text-left">
        <span className="truncate font-mono text-[12.5px]">{entity.id}</span>
        {/*
          The reason it is broken, in place of the description — a definition
          that failed to parse has no description to show, and the reason is
          the one thing that helps.
        */}
        <span
          className={cn(
            'truncate text-[11px]',
            broken ? 'text-amber' : 'text-subtle',
          )}
        >
          {broken ? entity.invalid : entity.sub}
        </span>
        {/*
          Last, so the row announces "slack-watcher … sleeping" rather than
          leading with its status — and present at all because the state may
          never be carried by the dot's colour alone.
        */}
        <span className="sr-only">
          {broken ? 'invalid' : STATUS_LABEL[entity.status]}
        </span>
      </span>
    </button>
  );
}
