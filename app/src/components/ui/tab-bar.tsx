import { cn } from '@/lib/utils';

import { Badge } from '@components/ui/badge';

export interface Tab<Id extends string = string> {
  id: Id;
  label: string;
  /** Rendered as a muted chip. Omitted or zero renders no badge at all. */
  badgeCount?: number;
  /**
   * What the count means, for screen readers — e.g. `'work items'`, announced
   * as `"Work 8 work items"`.
   *
   * Unlike a badge inside an `aria-label`led control, this one **is** announced:
   * a tab's accessible name comes from its content, so an unlabelled count would
   * be dropped from the name entirely and the number would reach nobody using a
   * screen reader. Pass it whenever `badgeCount` is set.
   */
  badgeLabel?: string;
}

/** The DOM id `TabBar` gives a tab, for a panel's `aria-labelledby`. */
export const tabId = (id: string) => `tab-${id}`;

interface TabBarProps<Id extends string> {
  tabs: Tab<Id>[];
  active: Id;
  onSelect: (id: Id) => void;
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
 * Generic over the id type so a caller with a union (`LeftTab`, `RailTab`) gets
 * that union back in `onSelect` — the alternative is an `as` cast at every call
 * site, which would silently accept an id the union never had.
 *
 * `-mb-px` pulls each tab's 2px underline over the container's 1px bottom
 * border, so the active indicator sits *on* the rule rather than below it.
 */
export function TabBar<Id extends string>({
  tabs,
  active,
  onSelect,
  label,
  className,
}: TabBarProps<Id>) {
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
            id={tabId(tab.id)}
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
            <Badge
              count={tab.badgeCount ?? 0}
              tone="muted"
              label={tab.badgeLabel}
            />
          </button>
        );
      })}
    </div>
  );
}
