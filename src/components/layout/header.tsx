import { Bell, Gear, Moon, Sun } from '@phosphor-icons/react';

import { cn } from '@/lib/utils';


import { BrandBlock } from '@components/layout/brand-block';
import { DemoChip } from '@components/layout/demo-chip';
import { ModelChip } from '@components/layout/model-chip';
import { StatusCounts } from '@components/layout/status-counts';
import { Badge } from '@components/ui/badge';
import { isDesktop } from '@config/runtime';
import {
  useRailWidthState,
  useSetRailCollapsed,
  useTheme,
  useThemeActions,
} from '@stores/appearance-store';
import { useUnreadCount } from '@stores/hive-store';
import {
  usePickerActions,
  useRevealRailTab,
  useSettingsActions,
  useShowActivityRail,
} from '@stores/ui-store';

/**
 * Persistent header — 56px, never scrolls, never collapses.
 *
 * Composition only. Every zone that reads domain state owns its own
 * subscription (`ModelChip`, `StatusCounts`), so a session changing status
 * repaints one span rather than the whole bar.
 *
 * Two zones: an identity-and-state cluster on the left, controls on the right —
 * fleet counts, theme toggle, inbox bell, New session.
 *
 * ## Nothing is centred any more, so the centring machinery is gone
 *
 * This used to be a `1fr minmax(0,auto) 1fr` grid whose entire purpose was to
 * put the model chip at the header's *true* midpoint: equal side tracks find
 * the real centre where a flex spacer would only centre the gap between two
 * unequal clusters. That was correct while the chip was meant to be centred.
 *
 * It no longer is. Both chips now start on the **left rail's trailing edge** —
 * the vertical line the center stage begins on — so a plain flex row is the
 * honest structure, and the equal-track machinery would be dead weight that
 * still cost the layout `2 x max(side)` of width.
 *
 * ## Where the width goes when the header runs out
 *
 * The brand claims exactly the rail's width (the `--cc-rail-w-left` token
 * minus this header's own `px-4`), so whatever follows it starts on that line.
 *
 * The left cluster is `min-w-0` and the right one does not shrink, so the model
 * chip is what gives when the window narrows. That is the right way round now:
 * the chip already truncates by design and carries its full text in a `title`,
 * while the fleet counts have no tooltip and would simply lose information.
 * (Under the old grid the counts absorbed the deficit instead, because the chip
 * was the thing being centred and could not be allowed to move.)
 *
 * ## Target-specific additions, both on the left
 *
 * - **browser**: the `demo` chip, so a build with no PTYs behind it is never
 *   mistaken for the real thing.
 * - **desktop**: the drag region that replaces the title bar we removed.
 *
 * The traffic lights used to be a third entry here, as a 78px inset on the
 * brand block. They now have their own row — see `title-bar.tsx` — so this bar
 * holds nothing of the OS's and the wordmark starts at the header's own `px-4`.
 */
export function Header() {
  const theme = useTheme();
  const { toggleTheme } = useThemeActions();
  const unread = useUnreadCount();
  const revealRailTab = useRevealRailTab();
  const setRailCollapsed = useSetRailCollapsed();
  /*
    Named rather than inlined, so the bell's JSX reads as what it does — and
    because it is now two actions, not one. `revealRailTab` lives in `ui-store`
    and collapse in `appearance-store`; no store may read another, so a caller
    that wants both says both. Without the second call the bell would select the
    Inbox tab on a rail showing three icons: visibly nothing happening.
  */
  const showInbox = () => {
    revealRailTab('inbox');
    setRailCollapsed('right', false);
  };
  const { openPicker } = usePickerActions();
  const { openSettings } = useSettingsActions();

  const isDark = theme === 'dark';
  const desktop = isDesktop();
  /*
    The counts anchor to the activity rail's leading edge, so they need to know
    whether there is one. With the rail unmounted there is no line to end on and
    the cluster falls back to flush right — the layout this header had before
    HIVE-79.
  */
  const showActivityRail = useShowActivityRail();
  /*
    Collapse also removes the line the cluster is meant to claim, and it lives
    in the other store from `showActivityRail` — mount and collapse are
    independent facts, so both are read here rather than one standing in for
    the other. See the cluster's own comment for why a collapsed rail cannot
    take the same branch as a mounted, expanded one.
  */
  const { railCollapsedLeft, railCollapsedRight } = useRailWidthState();

  return (
    <header
      /*
       * `-webkit-app-region: drag` makes the header the window's drag handle,
       * which `titleBarStyle: 'hiddenInset'` (story 081) requires — without a
       * native title bar there is nothing else to grab. Desktop only: in a
       * browser the property is inert, but the left inset below is not, and a
       * 78px gap in the demo surface would be a visible regression.
       */
      /*
        No `gap` at this level any more (HIVE-79).

        The counts have to end **exactly** on the activity rail's leading edge,
        and a row gap would hold them 14px short of it — an offset small enough
        to look like a mistake and large enough to see. Spacing is applied by
        the three zones themselves instead: the brand cluster keeps its own
        internal gap, the counts carry a left margin, and the control cluster
        spaces itself inside the column it owns.
      */
      className={cn(
        'flex h-14 shrink-0 items-center border-b border-border-soft bg-panel px-4',
        desktop && '[-webkit-app-region:drag]',
      )}
    >
      <div className="flex min-w-0 flex-1 items-center">
        {/*
          The brand claims exactly the left rail's width, so whatever follows it
          starts on the rail's trailing edge — the same vertical line the center
          stage begins on. Without this the chips float wherever the wordmark
          happens to end, aligned to nothing.

          The width is the rail's own token minus this header's `px-4`, since
          the rail starts at the viewport edge and the header's content box
          does not. The token, not a number: `--cc-rail-w-left` is what the
          rail paints with — 320px comfortable, 284px compact, or whatever the
          user dragged it to — and a literal here was right in one density and
          20px wrong in the other, and wrong by the drag's delta after every
          drag. Same derivation as the controls cluster on the right, and the
          same fallback: a **collapsed** rail paints the token at `RAIL_STRIP`
          (44px), and 28px cannot hold a wordmark, so collapse drops the claim
          and the brand is simply content-sized. `chip-alignment.spec.ts`
          measures the brand against the rail so the derivation cannot drift.
        */}
        <div
          /*
           * No traffic-light inset any more.
           *
           * This used to carry `pl-[78px]` on desktop, because `hiddenInset`
           * floated the lights over this bar and the wordmark started
           * underneath them. The inset was absorbed *inside* the fixed width
           * rather than applied to the zone around it, so that the chip cluster
           * still landed on the rail's edge instead of 78px past it.
           *
           * `title-bar.tsx` gives the lights their own row above, so there is
           * nothing left to clear and the brand starts at the header's own
           * `px-4` — the same 16px the lights sit at one row up. The width
           * stays, because it is what puts the chips on the rail's edge, and
           * that was never about the lights.
           */
          className={cn(
            'flex shrink-0 items-center',
            !railCollapsedLeft && 'w-[calc(var(--cc-rail-w-left)-1rem)]',
          )}
        >
          <BrandBlock />
        </div>
        {/*
          The chips get their own row so the gap between THEM does not also
          apply between the brand and the first chip — that would push the
          cluster 10px past the rail's edge and quietly undo the alignment.

          The model chip sits here too, not in a centred track. On desktop there
          is no `demo` chip, so it starts exactly on the rail's edge; in the
          browser it follows the `demo` chip. It renders nothing on the
          overmind and agent tabs, and because this is a flex row rather
          than a fixed grid, its absence simply closes the gap instead of
          leaving a hole.
        */}
        <div
          /*
           * Named so the alignment specs can measure the cluster's left edge
           * directly. Whichever chip comes first sits on that edge, and which
           * one that is depends on the target — so "the first chip" is not a
           * thing a selector can express without encoding the target too.
           */
          data-testid="header-chips"
          className="flex min-w-0 items-center gap-2.5"
        >
          <DemoChip />
          <ModelChip />
        </div>
      </div>

      {/*
        The counts are their own zone now, and they end on the rail's line.

        `ml-[14px]` is the only spacing they carry, on the side that faces the
        model chip. Nothing on the right, because the right edge *is* the
        alignment: the control cluster below claims the activity rail's width,
        so wherever the counts stop is where the rail's border rises through
        the header. `chip-alignment.spec.ts` measures the two against each
        other, the same way it already measures the chips against the left rail.

        `shrink-0`, not `shrink`. The counts are short, fixed-width and have no
        tooltip; the model chip beside them is long and carries its whole string
        in a `title`. So the chip is the right thing to absorb a narrow window,
        and it can only do that if this zone declines to. Letting both shrink is
        what made the two components' comments disagree about which one gave.
      */}
      <div className="ml-[14px] flex shrink-0 items-center">
        <StatusCounts />
      </div>

      <div
        /*
          This cluster claims the activity rail's own column, so the buttons sit
          over the rail rather than straddling its border.

          `calc(… - 1rem)` rather than a literal, for the reason the brand block
          documents at the other end of the bar: the rail begins at the viewport
          edge and this header's content box does not, so the column is the
          rail's width minus this header's own `px-4`. Written as a calc over
          the token because `--cc-rail-w-right` is 316px at comfortable density
          and 276px at compact — a hardcoded number would be right in one of
          them and silently wrong in the other.

          Measured content is ~262px against a 300px column at comfortable
          density, so nothing here is under width pressure; `shrink-0` keeps it
          that way and pushes any deficit onto the counts and the chip.

          With the rail hidden there is no column to claim, so the width drops
          away and the cluster is simply flush right.

          A **collapsed** rail needs that same fallback, not the claimed
          column. Collapse paints `--cc-rail-w-right` at `RAIL_STRIP` — 44px,
          room for one icon — because that property is also what the rail
          itself is sized with; this cluster reusing it was only ever valid
          while the value meant "the panel's own width". Claim a 44px column
          here and the ~262px of `shrink-0` children above do not shrink to
          fit it — they overflow it and land on the counts to their left. So
          the column is claimed only when the rail is both mounted **and**
          expanded; either `showActivityRail` or `railCollapsedRight` failing
          drops the width exactly like the hidden case above.
        */
        className={cn(
          'flex shrink-0 items-center justify-end gap-[14px]',
          showActivityRail &&
            !railCollapsedRight &&
            'w-[calc(var(--cc-rail-w-right)-1rem)]',
        )}
      >
        <button
          type="button"
          onClick={toggleTheme}
          aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
          className="flex size-[34px] shrink-0 items-center justify-center rounded-full border border-border text-muted hover:bg-hover hover:text-ink [-webkit-app-region:no-drag]"
        >
          {isDark ? <Sun size={17} /> : <Moon size={17} />}
        </button>

        {/*
          One of two ways into settings (story 101); the other is the picker's
          empty state. `Cmd+,` belongs with story 060's binding registry, which
          does not exist yet — and a bare window keydown listener is the
          mistake center-stage already documents making once.

          `[-webkit-app-region:no-drag]` is required, not decorative: the header
          is the window drag handle, and without it this button cannot be
          clicked at all.
        */}
        <button
          type="button"
          // Wrapped: `openSettings` now takes an optional pane, and a bare
          // handler would hand it the click event as one (HIVE-116).
          onClick={() => openSettings()}
          aria-label="Settings"
          className="flex size-[34px] shrink-0 items-center justify-center rounded-full border border-border text-muted hover:bg-hover hover:text-ink [-webkit-app-region:no-drag]"
        >
          <Gear size={17} />
        </button>

        {/*
          The bell **shows** the inbox rather than marking it read (HIVE-93).

          It still does not open a dropdown — the inbox lives in the activity
          rail (story 051) and two places to read one list is one too many — so
          this reveals that rail's INBOX tab instead of duplicating it.

          What changed is what the click *means*. Marking everything read was the
          one action that destroyed the information the badge carries, from a
          control whose icon promises navigation: a user reaching for the bell to
          see what happened cleared the record of what happened. The badge now
          survives until a card is clicked, which is the point at which the user
          has actually seen the thing — see `notification-card.tsx`.

          The bell was `markAllRead`'s only caller. The store action and its
          bridge call (`notifications.markRead(null)`) are deliberately kept —
          they are a real capability of the notification hub and still covered by
          the store's own spec — but no control invokes them today, and inventing
          a second one here would re-create the problem this removes. The list
          now drains a card at a time, which is the behaviour the cards
          themselves provide.
        */}
        <button
          type="button"
          onClick={showInbox}
          aria-label={
            unread > 0
              ? `Inbox — ${unread} unread`
              : 'Inbox — nothing unread'
          }
          className="relative flex size-[34px] shrink-0 items-center justify-center rounded-full border border-border text-muted hover:bg-hover hover:text-ink [-webkit-app-region:no-drag]"
        >
          <Bell size={17} />
          {/* No `label` — the button's own aria-label already names the count,
              and an ancestor aria-label would suppress this one anyway. */}
          <Badge count={unread} className="absolute -right-1 -top-1" />
        </button>

        <button
          type="button"
          /*
            Wrapped, not passed by reference: `openPicker` takes an optional
            ticket key since HIVE-73, and handing it straight to `onClick` would
            feed it the MouseEvent as that key — a picker headed "Start a
            session for [object Object]". The header's button is the
            no-ticket entry point, so it calls with no argument.
          */
          onClick={() => openPicker()}
          className="flex h-9 shrink-0 items-center rounded-full bg-brand-fill px-4 text-sm font-bold text-on-brand hover:bg-brand-fill-hover [-webkit-app-region:no-drag]"
        >
          New session
        </button>
      </div>
    </header>
  );
}
