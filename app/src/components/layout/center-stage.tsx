import { useEffect, useMemo, useRef } from 'react';

import { isEntityView, resolveView } from '@/lib/resolve-view';
import { cn } from '@/lib/utils';

import { SessionMetaBar } from '@components/layout/session-meta-bar';
import { TerminalHost } from '@components/terminal/terminal-host';
import { ConsoleInput } from '@features/orchestrator/components/console-input';
import { SessionTable } from '@features/orchestrator/components/session-table';
import {
  ORCHESTRATOR_ID,
  createStaticTransport,
} from '@lib/terminal/static-transport';
import type { TerminalTransport } from '@lib/terminal/terminal-transport';
import { useActiveEntity, useAgentOrder, useNavOrder } from '@stores/hive-store';
import {
  useActiveTab,
  usePickerActions,
  usePickerState,
  useTheme,
} from '@stores/ui-store';

/**
 * Center stage — one focused thing at a time (story 040).
 *
 * `min-w-0` is load-bearing, not defensive: without it this flex child refuses
 * to shrink below its content, a long terminal line widens the column, and
 * xterm's fit addon measures the widened box and grows into it. The rails are
 * fixed-width, so this column is what absorbs every window resize.
 *
 * `overflow-hidden` enforces the story's rule that **the stage never scrolls as
 * a whole** — only the terminal region does. Without it a wide meta bar would
 * give the whole column a scrollbar and the terminal would stop filling it.
 *
 * This is the composition root for the stage: it reaches into the stores
 * precisely so `components/terminal/` never has to.
 */
export function CenterStage() {
  const theme = useTheme();
  const activeTab = useActiveTab();
  const entity = useActiveEntity();
  const navOrder = useNavOrder();
  const agentOrder = useAgentOrder();
  const { picker } = usePickerState();

  const view = resolveView({ activeTab, picker, entity });
  const showingPicker = view === 'picker';

  const ids = useMemo(
    () => [ORCHESTRATOR_ID, ...navOrder, ...agentOrder],
    [navOrder, agentOrder],
  );

  /**
   * Transports are created once per entity and cached for the life of the app.
   * Identity matters: `TerminalSurface` resubscribes whenever its transport
   * changes, so rebuilding these each render would tear down and replay every
   * transcript on every unrelated state change.
   */
  const cache = useRef(new Map<string, TerminalTransport>());

  const entries = useMemo(
    () =>
      ids.map((id) => {
        let transport = cache.current.get(id);
        if (!transport) {
          transport = createStaticTransport(id);
          cache.current.set(id, transport);
        }
        // Read-only for the whole prototype: every view that accepts input
        // does it through a DOM row beside the terminal (stories 041, 043).
        return { id, transport, readOnly: true };
      }),
    [ids],
  );

  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-panel-2">
      {showingPicker ? <PickerStage /> : null}

      {/*
        Hidden, never unmounted. Tearing the terminal region down for the
        duration of the picker would dispose every live xterm instance and
        throw away the scrollback story 042 exists to preserve.
      */}
      <div className={cn('flex min-h-0 flex-1 flex-col', showingPicker && 'hidden')}>
        {isEntityView(view) && entity ? <SessionMetaBar entity={entity} /> : null}

        {/*
          The fleet table sits above the transcript rather than inside it. The
          concept scrolls them as one region, but the transcript is a real xterm
          with its own viewport, and a DOM table cannot share it — so the table
          keeps its own scroll and the terminal fills what is left.
        */}
        {view === 'orchestrator' ? <SessionTable /> : null}

        <div className="flex min-h-0 flex-1 flex-col">
          <TerminalHost
            entries={entries}
            /*
             * `null` while the picker is open: that marks every surface
             * invisible, so closing the picker re-reveals the previous one and
             * triggers its refit through the machinery story 042 already has.
             */
            activeId={showingPicker ? null : activeTab}
            theme={theme}
          />
        </div>

        {view === 'orchestrator' ? <ConsoleInput /> : null}
      </div>
    </main>
  );
}

/**
 * Placeholder for the new-session picker.
 *
 * **Story 044 replaces this** with the real overlay — pinned projects, model
 * and effort steppers, search — built on shadcn's Dialog for focus trapping and
 * scroll locking.
 *
 * It exists now rather than as an empty branch because the header's "New
 * session" button already sets `picker: true` (story 021). Without something
 * here that state renders nothing and the user is stranded on a blank stage
 * with no way back — so the title block and both exits (the button and Escape)
 * are the minimum this state can honestly ship with.
 */
function PickerStage() {
  const { closePicker } = usePickerActions();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closePicker();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [closePicker]);

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-7 bg-term-bg px-6 py-10">
      <div className="flex flex-col gap-1.5 text-center">
        {/*
          The concept sets this in a display serif. No such token exists yet
          (`tokens.css` defines only `--font-mono`), and introducing one belongs
          to story 044, which specifies the picker's typography in full.
        */}
        <span className="text-[22px] tracking-[-0.02em] text-ink">
          Start a new session
        </span>
        <span className="text-[13px] text-subtle">
          Pick a project — a Claude Code terminal will open for it
        </span>
      </div>

      <button
        type="button"
        onClick={closePicker}
        className="font-mono text-xs text-subtle hover:text-ink"
      >
        esc · cancel
      </button>
    </div>
  );
}
