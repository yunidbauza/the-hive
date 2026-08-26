import { cn } from '@/lib/utils';
import { branchLabel, entityLabel, isSession } from '@/types/entity';

import { StatusDot, statusLabel, statusText } from '@components/ui/status-dot';
import { useEntity, useOpenEntity } from '@stores/hive-store';
import { useActiveTab } from '@stores/ui-store';

interface SessionRowProps {
  id: string;
}

/**
 * One session beneath its project.
 *
 * Two lines: status dot + id + status label, then the branch indented under it.
 * The 26px left padding aligns the dot with the project name above rather than
 * with its caret, so the tree reads as one column of names.
 *
 * Renders nothing for an id the store does not know. The simulation (061) and
 * the spawn flow (044) both add and remove entities underneath open panels, so
 * a row that insists its entity exists is a crash waiting for a race.
 */
export function SessionRow({ id }: SessionRowProps) {
  const entity = useEntity(id);
  const activeTab = useActiveTab();
  const openEntity = useOpenEntity();

  if (!entity || !isSession(entity)) return null;

  const active = activeTab === id;

  return (
    <button
      type="button"
      onClick={() => openEntity(id)}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'flex flex-col rounded-lg py-[3px] pr-2.5 pl-[26px] leading-[1.35]',
        active ? 'bg-active' : 'hover:bg-hover',
      )}
    >
      <span className="flex w-full items-center gap-2">
        {/* No `label`: the status label sits right beside it. */}
        <StatusDot status={entity.status} detail={entity.idleDetail} />
        <span className="flex-1 truncate text-left font-mono text-[12.5px]">
          {entityLabel(entity)}
        </span>
        <span
          className={cn(
            'shrink-0 text-[10.5px] font-semibold',
            statusText(entity.status, entity.idleDetail),
          )}
        >
          {statusLabel(entity.status, entity.idleDetail)}
        </span>
      </span>

      <span className="w-full truncate pl-[15px] text-left font-mono text-[10.5px] text-subtle">
        {branchLabel(entity)}
      </span>
    </button>
  );
}
