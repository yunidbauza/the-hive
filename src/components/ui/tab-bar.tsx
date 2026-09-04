import type { Icon } from '@phosphor-icons/react';

import { cn } from '@/lib/utils';

import { Badge, type BadgeTone } from '@components/ui/badge';
import { STATUS_FILL, type DotStatus } from '@components/ui/status-dot';
import { Tooltip, TooltipContent, TooltipTrigger } from '@components/ui/tooltip';

export interface Tab<Id extends string = string> {
  id: Id;
  label: string;
  /**
   * The tab's glyph — what it becomes when its rail collapses to a strip.
   *
   * Required, not optional: both tab bars in this app live in a rail that can
   * collapse, so a tab without an icon is a tab that vanishes when its rail
   * does. Optional would make that a runtime hole; required makes it a type
   * error, and there are exactly six call sites.
   */
  icon: Icon;
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
  /**
   * How loud the count is. The left rail's work count is an inventory and stays
   * `muted`; the activity rail's unread count means agents are blocked on the
   * user, and story 050 asks for red. Defaults to `muted`.
   */
  badgeTone?: BadgeTone;
  /**
   * A live state to mark on the glyph — the second, orthogonal signal.
   *
   * `badgeCount` answers *how many things are in there*; this answers *is
   * anything happening right now*. They move on different clocks, so a tab
   * carries both rather than overloading one number: the Agents tab counts the
   * agents you have and lights this when one of them is working, asking or
   * broken. Omitted leaves the glyph bare, which is the resting case and must
   * stay silent.
   *
   * `status` picks the fill, from `STATUS_FILL` and never from a colour passed
   * in here, so a tab's summary can never drift from the rows it summarises.
   *
   * **One object rather than the two optional fields `badgeCount`/`badgeLabel`
   * are.** The pair would make `status` without `label` representable, and that
   * combination is a coloured, pulsing, entirely unannounced mark — state
   * carried by colour alone, which is the one rule `status-dot.ts` exists to
   * hold. A badge at least has a visible digit to fall back on; a dot has
   * nothing. Required inside an optional object makes the bad half a type
   * error instead of a convention in a doc comment.
   */
  dot?: {
    status: DotStatus;
    /** What it means, in words — e.g. `'an agent is working'`. */
    label: string;
  };
}

/** The DOM id `TabBar` gives a tab, for a panel's `aria-labelledby`. */
export const tabId = (id: string) => `tab-${id}`;

interface TabBarProps<Id extends string> {
  tabs: Tab<Id>[];
  active: Id;
  onSelect: (id: Id) => void;
  /** Names the tablist for screen readers — e.g. `'Rail sections'`. */
  label: string;
  /**
   * `strip` is what a collapsed rail renders: a vertical column of icon-only
   * buttons, no labels, no bottom rule, the active one marked with a bar on
   * the outer edge rather than an underline.
   */
  orientation?: 'horizontal' | 'strip';
  /**
   * A click on the tab that is *already* active.
   *
   * A second callback rather than a widened `onSelect`, because `onSelect`
   * firing only for a genuine change is what every existing caller relies on —
   * and what stops a click on the current tab from writing the state it already
   * holds. The rails pass `toggleRailCollapsed` here; nobody else passes it.
   */
  onActiveSelect?: () => void;
  /**
   * Which way a strip tab's tooltip opens. Only meaningful in `strip`
   * orientation — an expanded tab has a visible label and gets no tooltip.
   *
   * A rail on the left edge opens its tooltips rightward, into the screen; a
   * rail on the right edge opens leftward, for the same reason. Getting this
   * backwards runs the tooltip off-screen, which is invisible in a unit test
   * and only shows up in a real browser — see `rail-collapse.spec.ts`.
   */
  tooltipSide?: 'left' | 'right';
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
  orientation = 'horizontal',
  onActiveSelect,
  tooltipSide,
  className,
}: TabBarProps<Id>) {
  const strip = orientation === 'strip';

  return (
    <div
      role="tablist"
      aria-label={label}
      aria-orientation={strip ? 'vertical' : 'horizontal'}
      /*
        The two orientations space themselves differently, and the difference is
        not cosmetic. A horizontal tab carries a label, so 2px of gap is already
        a word's worth of separation. A strip tab is a bare 20px glyph in a 34px
        tile: at the same 2px the three icons read as one column of marks rather
        than as three destinations, which is what a 44px rail is reduced to when
        it collapses. 16px is what gives each glyph its own airspace while the
        active tile still reads as a single object.
      */
      className={cn(
        'flex',
        strip
          ? 'flex-col items-center gap-4'
          : 'gap-0.5 border-b border-border-soft',
        className,
      )}
    >
      {tabs.map((tab) => {
        const selected = tab.id === active;
        const TabIcon = tab.icon;
        const count = tab.badgeCount ?? 0;

        /*
          The count reaches a screen reader through the name in strip mode,
          because the visible chip is gone. `Badge` carries it in horizontal
          mode, so doubling it up here would announce it twice. The dot's
          phrase joins it the same way — in both modes the mark is silent
          without one.
        */
        const stripName = [
          tab.label,
          count > 0 && tab.badgeLabel ? `${count} ${tab.badgeLabel}` : undefined,
          tab.dot?.label,
        ]
          .filter((part) => part !== undefined)
          .join(', ');

        /*
          Sized and positioned per mode. Horizontal lifts a 9px ringed dot off
          the corner of the glyph — the mark an agent row already wears on its
          avatar tile — while the strip reuses the 6px corner pip the count
          used to own, because 34px has no room for a ring.
        */
        const dot =
          tab.dot === undefined ? null : (
            <span
              aria-hidden="true"
              data-slot="tab-dot"
              className={cn(
                'absolute rounded-full',
                strip
                  ? 'top-1 right-1 size-1.5'
                  : '-right-0.5 -bottom-0.5 size-[9px] border-2 border-panel',
                STATUS_FILL[tab.dot.status],
                // The one state that earns motion, as everywhere else.
                tab.dot.status === 'working' && 'animate-ccpulse',
              )}
            />
          );

        const button = (
          <button
            // Only the strip branch below needs a key of its own (on the
            // `Tooltip` it returns); giving this one too would either be
            // redundant or, worse, collide as a duplicate key in the DOM.
            key={strip ? undefined : tab.id}
            type="button"
            role="tab"
            id={tabId(tab.id)}
            aria-selected={selected}
            aria-label={strip ? stripName : undefined}
            onClick={() => (selected && onActiveSelect ? onActiveSelect() : onSelect(tab.id))}
            className={
              strip
                ? cn(
                    'relative flex size-[34px] items-center justify-center rounded-md',
                    selected ? 'bg-hover text-ink' : 'text-subtle hover:bg-hover hover:text-ink',
                  )
                : cn(
                    '-mb-px flex items-center gap-1.5 border-b-2 px-2.5 pt-1.5 pb-[9px] text-[11px] font-semibold uppercase tracking-[0.08em]',
                    selected
                      ? 'border-brand text-ink'
                      : 'border-transparent text-subtle hover:text-ink',
                  )
            }
          >
            {strip ? (
              <TabIcon size={20} aria-hidden="true" />
            ) : (
              /*
                The dot is positioned against the glyph, not the tab, so it
                sits on the icon rather than floating beside the label. The
                wrapper is inert when no dot is asked for.
              */
              <span className="relative inline-flex">
                <TabIcon size={16} aria-hidden="true" />
                {dot}
              </span>
            )}

            {strip ? (
              /*
                One mark, and the live state outranks the count for it: an
                inventory says nothing about whether anything is happening,
                which is the only thing worth interrupting a 44px column for.
              */
              (dot ??
                (count > 0 ? (
                  <span
                    aria-hidden="true"
                    data-slot="tab-dot"
                    className={cn(
                      'absolute top-1 right-1 size-1.5 rounded-full',
                      (tab.badgeTone ?? 'muted') === 'danger' ? 'bg-danger-solid' : 'bg-muted',
                    )}
                  />
                ) : null))
            ) : (
              <>
                {tab.label}
                <Badge count={count} tone={tab.badgeTone ?? 'muted'} label={tab.badgeLabel} />
                {/*
                  Never colour alone: the dot's meaning reaches a screen reader
                  through the tab's own name, which is built from its content.
                */}
                {tab.dot === undefined ? null : (
                  <span className="sr-only">{tab.dot.label}</span>
                )}
              </>
            )}
          </button>
        );

        /*
          Strip only: an expanded tab already shows its label and needs no
          tooltip. The tooltip's text is `stripName` — the very string already
          passed to `aria-label` above, not a second one computed for display,
          so the tooltip can never say something different from what a screen
          reader announces.
        */
        return strip ? (
          <Tooltip key={tab.id}>
            <TooltipTrigger asChild>{button}</TooltipTrigger>
            <TooltipContent side={tooltipSide}>{stripName}</TooltipContent>
          </Tooltip>
        ) : (
          button
        );
      })}
    </div>
  );
}
