import { TerminalSurface } from '@components/terminal/terminal-surface';

/**
 * Composition root.
 *
 * Story 010 (scaffold) renders the blank dark page plus the xterm smoke mount
 * that proves the terminal stack loads. Story 020 (app shell layout) replaces
 * the body of this component with `<AppShell />` — the fixed three-column
 * header / left rail / center stage / activity rail chrome.
 */
export function App() {
  return (
    <div className="flex h-full flex-col bg-bg text-ink">
      <header className="flex h-14 shrink-0 items-center border-b border-border px-4">
        <span className="text-brand">the hive</span>
        <span className="ml-3 text-muted">scaffold · story 010</span>
      </header>
      <main className="min-h-0 flex-1 p-4">
        <TerminalSurface />
      </main>
    </div>
  );
}
