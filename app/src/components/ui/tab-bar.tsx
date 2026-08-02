import { cn } from '@/lib/utils';

import { Badge } from '@components/ui/badge';

export interface Tab {
  id: string;
  label: string;
  /** Rendered as a muted chip. Omitted or zero renders no badge at all. */
  badgeCount?: number;
}

interface TabBarProps {
  tabs: Tab[];
  active: string;
  onSelect: (id: string) => void;
  /** Names the tablist for screen readers — e.g. `'Rail sections'`. */
  label: string;
  className?: string;
}

/**
 * The rails' tab bar — the left rail (030) and the activity rail (050).
 *
 * Domain-agnostic by contract: it takes `{ id, label, badgeCount }` and hands
 * back an id. It knows nothing about projects, tickets, or notifications, which
 * is exactly what lets both rails share one implementation.
 *
 * `-mb-px` pulls each tab's 2px underline over the container's 1px bottom
 * border, so the active indicator sits *on* the rule rather than below it.
 */
export function TabBar({
  tabs,
  active,
  onSelect,
  label,
  className,
}: TabBarProps) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn('flex gap-0.5 border-b border-border-soft', className)}
    >
      {tabs.map((tab) => {
        const selected = tab.id === active;

        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`tab-${tab.id}`}
            aria-selected={selected}
            onClick={() => onSelect(tab.id)}
            className={cn(
              '-mb-px flex items-center gap-1.5 border-b-2 px-2.5 pt-1.5 pb-[9px] text-[11px] font-semibold uppercase tracking-[0.08em]',
              selected
                ? 'border-brand text-ink'
                : 'border-transparent text-subtle hover:text-ink',
            )}
          >
            {tab.label}
            {/*
              No `label` prop: the count sits inside an already-named control,
              whose `aria-selected` tab name would replace it anyway.
            */}
            <Badge count={tab.badgeCount ?? 0} tone="muted" />
          </button>
        );
      })}
    </div>
  );
}
