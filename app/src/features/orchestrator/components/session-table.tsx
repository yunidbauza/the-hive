import { cn } from '@/lib/utils';
import { entityLabel, isSession } from '@/types/entity';

import { STATUS_LABEL, STATUS_TEXT } from '@components/ui/status-dot';
import { prStateText } from '@features/shared/pr-presentation';
import {
  useActiveSessions,
  useEndedSessions,
  useEntity,
  useNavOrder,
  useOpenEntity,
} from '@stores/hive-store';
import { useActiveTab, useSelIdx, useSetSelIdx } from '@stores/ui-store';

/**
 * The orchestrator's fleet table (story 041).
 *
 * **DOM, not xterm.** The transcript below it goes through the terminal, but
 * these rows have to stay clickable and focusable, which a canvas of text
 * cannot be. That split is the whole reason the console is two surfaces rather
 * than one.
 *
 * Column widths mirror the concept: a fixed caret and status, a fixed-ish
 * session name, and `project · branch` taking whatever is left.
 */
export function SessionTable() {
  const active = useActiveSessions();
  const ended = useEndedSessions();

  return (
    <div className="shrink-0 overflow-y-auto bg-term-bg px-[18px] pt-4 font-mono text-[12.5px]">
      <div className="flex gap-2.5 px-2 pb-1.5 text-[11px] tracking-[0.06em] text-term-head">
        <span className="w-3 shrink-0" />
        <span className="min-w-[70px] shrink basis-[130px] truncate">SESSION</span>
        <span className="w-[90px] shrink-0 truncate">STATUS</span>
        <span className="min-w-0 flex-1 truncate">PROJECT · BRANCH</span>
        <span className="w-[34px] shrink-0">PR</span>
      </div>

      {active.map((id) => (
        <SessionTableRow key={id} id={id} />
      ))}

      {/*
        "ENDED", not "COMPLETED" (story 108). The group now holds two different
        endings — work that finished and a process that quit — and only one of
        them was ever completed. The row's own status word says which.
      */}
      {ended.length > 0 ? (
        <>
          <div className="flex items-center gap-2 px-2 pt-3.5 pb-1.5">
            <span className="shrink-0 text-[11px] tracking-[0.06em] text-term-head">
              ENDED
            </span>
            <span className="flex-1 border-t border-border" />
          </div>
          {ended.map((id) => (
            <SessionTableRow key={id} id={id} />
          ))}
        </>
      ) : null}
    </div>
  );
}

/**
 * One row.
 *
 * It owns its own subscription rather than taking the session as a prop: a
 * status change should repaint one row, not the whole table. Same rule the
 * header's chips follow.
 */
function SessionTableRow({ id }: { id: string }) {
  const entity = useEntity(id);
  const navOrder = useNavOrder();
  const selIdx = useSelIdx();
  const setSelIdx = useSetSelIdx();
  const openEntity = useOpenEntity();
  const activeTab = useActiveTab();

  if (!entity || !isSession(entity)) return null;

  const index = navOrder.indexOf(id);
  const selected = index === selIdx;
  /**
   * A terminated row still reads, still selects, and does not open (story 108).
   *
   * `disabled` rather than a silently ignored click. The row's whole job on this
   * screen is to say what happened to a session, so it stays legible and stays
   * in the list — but a button that looks live and does nothing is worse than
   * one that says it is spent, and `disabled` is the only version of that a
   * screen reader hears too. The `title` supplies the *why*, which the status
   * word alone does not.
   */
  const terminated = entity.status === 'terminated';

  return (
    <button
      type="button"
      disabled={terminated}
      title={terminated ? `${entityLabel(entity)} has terminated — its process is gone` : undefined}
      onClick={() => {
        // Click both selects and opens: the caret should follow the user's
        // last action, or the keyboard and the mouse end up disagreeing about
        // where "here" is.
        setSelIdx(index);
        openEntity(id);
      }}
      aria-current={activeTab === id ? 'true' : undefined}
      className={cn(
        'flex w-full items-center gap-2.5 rounded px-2 py-[3px] text-left',
        selected ? 'bg-term-row-active' : 'hover:bg-term-row-hover',
        terminated && 'opacity-60',
      )}
    >
      <span
        aria-hidden="true"
        className={cn('w-3 shrink-0 text-green', selected ? 'visible' : 'invisible')}
      >
        ▸
      </span>
      <span className="min-w-[70px] shrink basis-[130px] truncate text-ink">
        {entityLabel(entity)}
      </span>
      <span className={cn('w-[90px] shrink-0 truncate', STATUS_TEXT[entity.status])}>
        {STATUS_LABEL[entity.status]}
      </span>
      <span className="min-w-0 flex-1 truncate text-subtle">
        {`${entity.project} · ${entity.branch}`}
      </span>
      {/*
        The column is 34px wide, so the PR *state* cannot be visible text here
        the way it is on the meta bar. It still must not be carried by colour
        alone — a hue is no signal to a colour-blind user, and none at all to a
        screen reader — so the state rides along as a title and an sr-only word.
      */}
      <span
        title={entity.pr ? `#${entity.pr.n} · ${entity.pr.state}` : 'no pull request'}
        className={cn(
          'w-[34px] shrink-0',
          entity.pr ? prStateText(entity.pr.state) : 'text-subtle',
        )}
      >
        {entity.pr ? `#${entity.pr.n}` : '—'}
        <span className="sr-only">
          {entity.pr ? ` ${entity.pr.state}` : ' no pull request'}
        </span>
      </span>
    </button>
  );
}
