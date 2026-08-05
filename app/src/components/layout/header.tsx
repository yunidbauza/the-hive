import { Bell, Gear, Moon, Sun } from '@phosphor-icons/react';

import { cn } from '@/lib/utils';


import { BrandBlock } from '@components/layout/brand-block';
import { DemoChip } from '@components/layout/demo-chip';
import { ModelChip } from '@components/layout/model-chip';
import { StatusCounts } from '@components/layout/status-counts';
import { Badge } from '@components/ui/badge';
import { isDesktop } from '@config/runtime';
import { useTheme, useThemeActions } from '@stores/appearance-store';
import { useMarkAllRead, useUnreadCount } from '@stores/hive-store';
import { usePickerActions, useSettingsActions } from '@stores/ui-store';

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
 * The brand claims exactly the rail's width (252px = the rail's 268px minus
 * this header's own `px-4`), so whatever follows it starts on that line.
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
 * - **browser**: the `demo` chip, so the fixtures-only surface is never
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
  const markAllRead = useMarkAllRead();
  const { openPicker } = usePickerActions();
  const { openSettings } = useSettingsActions();

  const isDark = theme === 'dark';
  const desktop = isDesktop();

  return (
    <header
      /*
       * `-webkit-app-region: drag` makes the header the window's drag handle,
       * which `titleBarStyle: 'hiddenInset'` (story 081) requires — without a
       * native title bar there is nothing else to grab. Desktop only: in a
       * browser the property is inert, but the left inset below is not, and a
       * 78px gap in the demo surface would be a visible regression.
       */
      className={cn(
        'flex h-14 shrink-0 items-center gap-[14px] border-b border-border-soft bg-panel px-4',
        desktop && '[-webkit-app-region:drag]',
      )}
    >
      <div className="flex min-w-0 flex-1 items-center">
        {/*
          The brand claims exactly the left rail's width, so whatever follows it
          starts on the rail's trailing edge — the same vertical line the center
          stage begins on. Without this the chips float wherever the wordmark
          happens to end, aligned to nothing.

          252px = the rail's 268px minus this header's own `px-4`, since the
          rail starts at the viewport edge and the header's content box does
          not. `left-rail.tsx` owns the 268; `chip-alignment.spec.ts` measures
          the two against each other so this cannot drift silently.
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
          className="flex w-[252px] shrink-0 items-center"
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
          orchestrator and agent tabs, and because this is a flex row rather
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

      <div className="flex shrink-0 items-center justify-end gap-[14px]">
        <StatusCounts />

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
          onClick={openSettings}
          aria-label="Settings"
          className="flex size-[34px] shrink-0 items-center justify-center rounded-full border border-border text-muted hover:bg-hover hover:text-ink [-webkit-app-region:no-drag]"
        >
          <Gear size={17} />
        </button>

        {/*
          The bell marks everything read rather than opening a dropdown — the
          inbox itself lives in the activity rail (story 051), and two places to
          read the same list is one too many.
        */}
        <button
          type="button"
          onClick={markAllRead}
          aria-label={
            unread > 0
              ? `Mark ${unread} unread notifications as read`
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
          onClick={openPicker}
          className="flex h-9 shrink-0 items-center rounded-full bg-brand-fill px-4 text-sm font-bold text-on-brand hover:bg-brand-fill-hover [-webkit-app-region:no-drag]"
        >
          New session
        </button>
      </div>
    </header>
  );
}
