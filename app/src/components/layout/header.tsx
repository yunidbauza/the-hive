import { Moon, Sun } from '@phosphor-icons/react';

import { useTheme, useThemeActions } from '@stores/ui-store';

/**
 * Persistent header — 56px, never scrolls, never collapses.
 *
 * Placeholder until story 021 builds the real thing: brand block, model chip,
 * fleet status counts, theme toggle, inbox bell, and the New-session button.
 * The theme toggle moved here from `app.tsx` when the shell landed, so the
 * token set stays exercisable end to end in the meantime.
 */
export function Header() {
  const theme = useTheme();
  const { toggleTheme } = useThemeActions();

  const isDark = theme === 'dark';

  return (
    <header className="flex h-14 shrink-0 items-center gap-[14px] border-b border-border-soft bg-panel px-4">
      <span className="text-brand">the hive</span>

      <button
        type="button"
        onClick={toggleTheme}
        aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
        className="ml-auto flex size-[34px] items-center justify-center rounded-full border border-border text-muted hover:bg-hover hover:text-ink"
      >
        {isDark ? <Sun size={17} /> : <Moon size={17} />}
      </button>
    </header>
  );
}
