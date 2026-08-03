import { Bell, Moon, Sun } from '@phosphor-icons/react';

import { cn } from '@/lib/utils';


import { BrandBlock } from '@components/layout/brand-block';
import { DemoChip } from '@components/layout/demo-chip';
import { ModelChip } from '@components/layout/model-chip';
import { StatusCounts } from '@components/layout/status-counts';
import { Badge } from '@components/ui/badge';
import { isDesktop } from '@config/runtime';
import { useMarkAllRead, useUnreadCount } from '@stores/hive-store';
import { usePickerActions, useTheme, useThemeActions } from '@stores/ui-store';

/**
 * Persistent header — 56px, never scrolls, never collapses.
 *
 * Composition only. Every zone that reads domain state owns its own
 * subscription (`ModelChip`, `StatusCounts`), so a session changing status
 * repaints one span rather than the whole bar.
 *
 * Three zones: brand left, model chip (sessions only) centered, controls right —
 * fleet counts, theme toggle, inbox bell, New session.
 *
 * The layout is a `1fr minmax(0,auto) 1fr` grid rather than the flex row with a
 * spacer it replaces, because the chip has to sit at the header's *true*
 * midpoint. Flex spacers would centre the gap between two unequal clusters —
 * the brand measures 150px and the controls 517px, which lands the chip about
 * 198px *left* of centre. Equal `1fr` tracks put it at the real midpoint
 * regardless of what either side grows to.
 *
 * Equal tracks have a price worth stating, because it is what the measurements
 * say and not what the markup suggests. Both side tracks size to the *wider*
 * side, so the space the layout needs is `2 × controls + chip`, not the sum of
 * the three: 2×517 + 459 = 1493px against the 1380px a 1440px header has to
 * give. The 113px deficit has to land somewhere, and the only question a
 * centred header really asks is *on which zone*.
 *
 * It lands on the counts, which ellipsise from the tail (see `StatusCounts`) —
 * the alternative is the chip losing `resets 02:30 PM`, and the chip is the
 * thing being centred. Left alone the browser picks worse still: the counts are
 * wrappable, so grid quietly reflows them onto a second line inside a bar that
 * is one line tall. Above roughly 1553px the deficit disappears and nothing
 * truncates.
 *
 * `minmax(0, auto)` on the middle track, not bare `auto`: it drops that track's
 * minimum to zero, so the chip's own truncation is the last valve — it gives
 * only once the counts have already collapsed, far below any supported width.
 *
 * Each zone is wrapped and explicitly placed with `col-start-*`. The middle
 * wrapper renders even when `ModelChip` returns null — on the orchestrator and
 * agent tabs the track collapses to zero width and the two side zones stay
 * exactly where they were, so switching tabs never reflows the header.
 *
 * ## What the two targets add, and why both land on the left (story 083)
 *
 * The left track is the *narrow* side — 150px against the controls' 517px — and
 * the width the header needs is `2 × max(side) + chip`. So anything added on
 * the left is free until it overtakes the right (≈367px of headroom), while
 * anything added on the right costs **twice** its width and pushes the counts
 * further into truncation. Both target-specific additions therefore go here:
 *
 * - **browser**: the `demo` chip, so the fixtures-only surface is never
 *   mistaken for the real thing.
 * - **desktop**: a 78px inset clearing the traffic lights that
 *   `titleBarStyle: 'hiddenInset'` (story 081) floats over this bar, plus the
 *   drag region that replaces the title bar we removed.
 *
 * They are mutually exclusive, so the left track never carries both.
 */
export function Header() {
  const theme = useTheme();
  const { toggleTheme } = useThemeActions();
  const unread = useUnreadCount();
  const markAllRead = useMarkAllRead();
  const { openPicker } = usePickerActions();

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
        'grid h-14 shrink-0 grid-cols-[1fr_minmax(0,auto)_1fr] items-center gap-[14px] border-b border-border-soft bg-panel px-4',
        desktop && '[-webkit-app-region:drag]',
      )}
    >
      <div
        /*
         * Clears the macOS traffic lights, which float over our header at
         * `{ x: 16, y: 20 }`. 78px is the three lights plus their inset plus a
         * gap — measured against the constant in `electron/shared/window.ts`.
         */
        className={cn('col-start-1 flex items-center', desktop && 'pl-[78px]')}
      >
        {/*
          The brand claims exactly the left rail's width, so the `demo` chip
          beside it starts on the rail's trailing edge — the same vertical line
          the center stage begins on. Without this the chip floats wherever the
          wordmark happens to end, aligned to nothing.

          252px = the rail's 268px minus this header's own `px-4`, since the
          rail starts at the viewport edge and the header's content box does
          not. `left-rail.tsx` owns the 268; `chip-alignment.spec.ts` measures
          the two against each other so this cannot drift silently.
        */}
        <div className="flex w-[252px] shrink-0 items-center">
          <BrandBlock />
        </div>
        <DemoChip />
      </div>

      <div className="col-start-2 flex min-w-0 items-center justify-center">
        <ModelChip />
      </div>

      <div className="col-start-3 flex min-w-0 items-center justify-end gap-[14px]">
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
