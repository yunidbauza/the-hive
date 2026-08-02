import { Moon, Sun } from '@phosphor-icons/react';

import { TerminalSurface } from '@components/terminal/terminal-surface';
import { useTheme, useThemeActions } from '@stores/ui-store';

/**
 * Composition root.
 *
 * Story 010 (scaffold) rendered the blank dark page plus the xterm smoke mount.
 * Story 011 adds the theme toggle so the token set is exercisable end to end.
 * Story 020 (app shell layout) replaces the body of this component with
 * `<AppShell />`, and story 021 moves the toggle into the real header.
 */
export function App() {
  const theme = useTheme();
  const { toggleTheme } = useThemeActions();

  const isDark = theme === 'dark';

  return (
    <div className="flex h-full flex-col bg-bg text-ink">
      <header className="flex h-14 shrink-0 items-center border-b border-border px-4">
        <span className="text-brand">the hive</span>
        <span className="ml-3 text-muted">tokens · story 011</span>

        <button
          type="button"
          onClick={toggleTheme}
          aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
          className="ml-auto rounded-md border border-border-soft bg-chip p-2 text-muted hover:bg-hover hover:text-ink"
        >
          {isDark ? <Sun size={16} /> : <Moon size={16} />}
        </button>
      </header>

      <main className="min-h-0 flex-1 p-4">
        <TerminalSurface />
      </main>
    </div>
  );
}
