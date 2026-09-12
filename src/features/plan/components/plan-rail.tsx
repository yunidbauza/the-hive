import { PushPin, PushPinSlash } from '@phosphor-icons/react';

import { cn } from '@/lib/utils';

import type { PlanTaskStatus, SessionPlan } from '@shared/plan-contract';

import { PlanGlyph } from './plan-glyph';

interface PlanRailProps {
  plan: SessionPlan;
  /** Docked beside the terminal rather than peeking over it. */
  pinned: boolean;
  onPinnedChange: (pinned: boolean) => void;
}

const TITLE_TONE: Record<PlanTaskStatus, string> = {
  completed: 'text-subtle',
  in_progress: 'text-ink',
  pending: 'text-muted',
};

/**
 * The plan panel (HIVE-181): a 34px glyph rail at the terminal's right edge.
 *
 * At rest it is one button — a `done/total` count and a ring per task — whose
 * label carries the whole summary, so its rings are hidden from assistive tech
 * rather than read twice. On hover or focus a 232px drawer peeks over the
 * terminal; that is CSS only (`group-hover`, `group-focus-within`), so the
 * terminal's box never changes size. Pinned, the rail itself becomes the 232px
 * drawer, and the terminal refits once through the ResizeObserver it already
 * has.
 *
 * Props in: the slice reads no store. The composition root hands it the plan
 * and the pin.
 */
export function PlanRail({ plan, pinned, onPinnedChange }: PlanRailProps) {
  const done = plan.tasks.filter((task) => task.status === 'completed').length;
  const total = plan.tasks.length;
  const count = plan.allDone ? 'all done' : `${String(done)}/${String(total)}`;
  const summary = plan.allDone ? 'Plan, all done' : `Plan, ${String(done)} of ${String(total)} done`;
  const proposed = plan.source === 'plan-mode';

  return (
    <div
      className={cn(
        'group relative flex shrink-0 flex-col border-l border-border bg-panel motion-safe:transition-[width]',
        pinned ? 'w-[232px]' : 'w-[34px]',
      )}
    >
      {pinned ? null : (
        <button type="button" aria-label={summary} className="flex h-full w-full flex-col items-center">
          <span className="flex h-[30px] items-center font-mono text-[10px] text-green tabular-nums">
            {plan.allDone ? '✓' : count}
          </span>
          <span aria-hidden className="flex flex-col items-center">
            {plan.tasks.map((task, index) => (
              <span key={task.id} className="grid h-[26px] place-items-center">
                <PlanGlyph index={index} status={task.status} proposed={proposed} />
              </span>
            ))}
          </span>
        </button>
      )}
      <section
        aria-label="Plan"
        className={cn(
          'w-[232px] bg-panel',
          pinned
            ? 'block h-full'
            : 'absolute inset-y-0 right-full z-10 hidden border-l border-border shadow-lg group-focus-within:block group-hover:block',
        )}
      >
        <header className="flex h-[30px] items-center justify-between px-2.5 font-mono text-[10.5px] tracking-[.07em] text-subtle uppercase">
          <span>Plan</span>
          <span className="flex items-center gap-2 tracking-normal normal-case">
            <b className="font-semibold text-green tabular-nums">{count}</b>
            <button
              type="button"
              aria-pressed={pinned}
              aria-label={pinned ? 'Unpin plan' : 'Pin plan'}
              onClick={() => onPinnedChange(!pinned)}
              className="grid size-5 place-items-center rounded text-subtle hover:bg-hover hover:text-ink"
            >
              {pinned ? <PushPinSlash size={12} aria-hidden /> : <PushPin size={12} aria-hidden />}
            </button>
          </span>
        </header>
        <ul className="grid">
          {plan.tasks.map((task, index) => (
            <li
              key={task.id}
              title={task.title}
              className={cn(
                'flex h-[26px] min-w-0 items-center gap-2 px-2.5',
                task.status === 'in_progress' && 'bg-active',
              )}
            >
              <PlanGlyph index={index} status={task.status} proposed={proposed} />
              <span className={cn('truncate font-mono text-[12px]', TITLE_TONE[task.status])}>
                {task.title}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
