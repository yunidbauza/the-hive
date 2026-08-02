import { TerminalSurface } from '@components/terminal/terminal-surface';

/**
 * Center stage — the terminal, and everything that frames it.
 *
 * `min-w-0` is load-bearing, not defensive: without it this flex child refuses
 * to shrink below its content, a long terminal line widens the column, and
 * xterm's fit addon measures the widened box and grows into it. The rails are
 * fixed-width, so this column is what absorbs every window resize.
 *
 * Placeholder until story 040 builds the view-state machine and the session
 * meta bar. It mounts the terminal today so the shell's shrink behaviour is
 * exercised against a real xterm instance rather than an empty box.
 */
export function CenterStage() {
  return (
    <main className="flex min-w-0 flex-1 flex-col bg-panel-2">
      <div className="min-h-0 flex-1 p-4">
        <TerminalSurface />
      </div>
    </main>
  );
}
