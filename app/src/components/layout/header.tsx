import { Bell, Moon, Sun } from '@phosphor-icons/react';

import { BrandBlock } from '@components/layout/brand-block';
import { ModelChip } from '@components/layout/model-chip';
import { StatusCounts } from '@components/layout/status-counts';
import { Badge } from '@components/ui/badge';
import { useMarkAllRead, useUnreadCount } from '@stores/hive-store';
import { usePickerActions, useTheme, useThemeActions } from '@stores/ui-store';

/**
 * Persistent header — 56px, never scrolls, never collapses.
 *
 * Composition only. Every zone that reads domain state owns its own
 * subscription (`ModelChip`, `StatusCounts`), so a session changing status
 * repaints one span rather than the whole bar.
 *
 * Left to right: brand, model chip (sessions only), spacer, fleet counts, theme
 * toggle, inbox bell, New session.
 */
export function Header() {
  const theme = useTheme();
  const { toggleTheme } = useThemeActions();
  const unread = useUnreadCount();
  const markAllRead = useMarkAllRead();
  const { openPicker } = usePickerActions();

  const isDark = theme === 'dark';

  return (
    <header className="flex h-14 shrink-0 items-center gap-[14px] border-b border-border-soft bg-panel px-4">
      <BrandBlock />
      <ModelChip />

      <div className="flex-1" />

      <StatusCounts />

      <button
        type="button"
        onClick={toggleTheme}
        aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
        className="flex size-[34px] shrink-0 items-center justify-center rounded-full border border-border text-muted hover:bg-hover hover:text-ink"
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
        className="relative flex size-[34px] shrink-0 items-center justify-center rounded-full border border-border text-muted hover:bg-hover hover:text-ink"
      >
        <Bell size={17} />
        {/* No `label` — the button's own aria-label already names the count,
            and an ancestor aria-label would suppress this one anyway. */}
        <Badge count={unread} className="absolute -right-1 -top-1" />
      </button>

      <button
        type="button"
        onClick={openPicker}
        className="flex h-9 shrink-0 items-center rounded-full bg-brand-fill px-4 text-sm font-bold text-on-brand hover:bg-brand-fill-hover"
      >
        New session
      </button>
    </header>
  );
}
