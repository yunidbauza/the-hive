import { useEffect, useMemo, useRef } from 'react';

import { isEntityView, resolveView } from '@/lib/resolve-view';
import { cn } from '@/lib/utils';

import { SessionMetaBar } from '@components/layout/session-meta-bar';
import { TerminalHost } from '@components/terminal/terminal-host';
import { ConsoleInput } from '@features/orchestrator/components/console-input';
import { SessionTable } from '@features/orchestrator/components/session-table';
import { MessageInput } from '@features/sessions/components/message-input';
import { NewSessionPicker } from '@features/sessions/components/new-session-picker';
import { SettingsOverlay } from '@features/settings/components/settings-overlay';
import {
  TERMINAL_CHORD_EVENT,
  type TerminalChordDetail,
} from '@lib/terminal/keymap';
import { isLiveTerminal, resolveTransport } from '@lib/terminal/resolve-transport';
import { ORCHESTRATOR_ID } from '@lib/terminal/static-transport';
import type { TerminalTransport } from '@lib/terminal/terminal-transport';
import { useTerminalAppearance, useTheme } from '@stores/appearance-store';
import { useActiveEntity, useAgentOrder, useNavOrder } from '@stores/hive-store';
import {
  useActiveTab,
  useBackToOrch,
  usePickerState,
  useSettingsOpen,
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
  /**
   * The one place appearance crosses into the terminal (story 105).
   *
   * `components/terminal/**` may not import `stores/**` — the lint zone fails
   * the build — so the composition root reads the store and passes props, which
   * is what it already does for `theme`. The seam stays a seam.
   */
  const terminalAppearance = useTerminalAppearance();
  const activeTab = useActiveTab();
  const entity = useActiveEntity();
  const navOrder = useNavOrder();
  const agentOrder = useAgentOrder();
  const { picker } = usePickerState();
  const settings = useSettingsOpen();

  const view = resolveView({ activeTab, picker, settings, entity });
  const showingPicker = view === 'picker';
  /**
   * Both full-stage overlays hide the terminal region, not just the picker.
   *
   * This gate drives two things — the `hidden` class and `TerminalHost`'s
   * `activeId` — and a settings overlay that did not extend it would render on
   * top of thirteen live terminals.
   */
  const showingOverlay = showingPicker || view === 'settings';

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

  const messageInputRef = useRef<HTMLInputElement>(null);

  const entries = useMemo(
    () =>
      ids.map((id) => {
        let transport = cache.current.get(id);
        if (!transport) {
          transport = resolveTransport(id);
          cache.current.set(id, transport);
        }
        /**
         * Typable exactly when there is a live shell to type into (story 095).
         *
         * Both halves come from one predicate, and that is the point: the
         * console stays a command surface, the browser demo stays a recording,
         * and an agent's replayed transcript stays a replay. Deciding
         * `readOnly` separately from the transport would eventually produce a
         * terminal that blinks a cursor and swallows every keystroke, which
         * reads as a hung session rather than as a read-only one.
         */
        return { id, transport, readOnly: !isLiveTerminal(id) };
      }),
    [ids],
  );

  /** Whether the surface currently on screen is a live shell. */
  const activeIsLive =
    entries.find((entry) => entry.id === activeTab)?.readOnly === false;

  /**
   * Focus the message row when the terminal area is clicked — unless the user
   * just finished selecting text.
   *
   * Moving focus collapses the document selection, so a plain "focus on click"
   * would delete the selection the drag had only just made: click, drag,
   * release, and the highlight vanishes before it can be copied.
   */
  const focusMessageInput = () => {
    const selection = window.getSelection()?.toString() ?? '';
    if (selection !== '') return;
    /**
     * A live terminal focuses itself instead (story 095).
     *
     * Clicking a shell and landing in a text box beneath it is the single most
     * confusing thing this stage could do once the terminal accepts input — the
     * user types, the terminal ignores them, and the characters appear
     * somewhere else. The surface owns that focus; this handler steps aside.
     */
    if (activeIsLive) return;
    messageInputRef.current?.focus();
  };

  /**
   * The way out of a focused terminal (story 095).
   *
   * Listens for the terminal's own chord *event*, not for a key combination.
   *
   * A `keydown` listener on `window` was the obvious first implementation and
   * it is wrong: `Cmd+←` is "move caret to start of line" in every native text
   * field, so matching the combination alone fired for keystrokes originating
   * anywhere — typing in the new-session picker and pressing `Cmd+←` closed the
   * picker and discarded the query. Listening for an event only a terminal
   * emits means the chord exists exactly where it was declined, and every text
   * field in the app keeps its native bindings.
   */
  const backToOrch = useBackToOrch();
  useEffect(() => {
    const onChord = (event: Event) => {
      const { detail } = event as CustomEvent<TerminalChordDetail>;
      if (detail?.chord !== 'back') return;
      backToOrch();
    };
    window.addEventListener(TERMINAL_CHORD_EVENT, onChord);
    return () => window.removeEventListener(TERMINAL_CHORD_EVENT, onChord);
  }, [backToOrch]);

  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-panel-2">
      {showingPicker ? <NewSessionPicker /> : null}
      {view === 'settings' ? <SettingsOverlay /> : null}

      {/*
        Hidden, never unmounted. Tearing the terminal region down for the
        duration of an overlay would dispose every live xterm instance and
        throw away the scrollback story 042 exists to preserve.
      */}
      <div className={cn('flex min-h-0 flex-1 flex-col', showingOverlay && 'hidden')}>
        {isEntityView(view) && entity ? <SessionMetaBar entity={entity} /> : null}

        {/*
          The fleet table sits above the transcript rather than inside it. The
          concept scrolls them as one region, but the transcript is a real xterm
          with its own viewport, and a DOM table cannot share it — so the table
          keeps its own scroll and the terminal fills what is left.
        */}
        {view === 'orchestrator' ? <SessionTable /> : null}

        {/*
          Clicking the terminal focuses the message row, as the concept does —
          the row should feel like part of the terminal, not a form beneath it.
          Not a button: this is a click *target*, and the keyboard already
          reaches the input directly.
        */}
        {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events */}
        <div
          className="flex min-h-0 flex-1 flex-col"
          onClick={focusMessageInput}
        >
          <TerminalHost
            entries={entries}
            /*
             * `null` while either overlay is open: that marks every surface
             * invisible, so closing it re-reveals the previous one and
             * triggers its refit through the machinery story 042 already has.
             */
            activeId={showingOverlay ? null : activeTab}
            theme={theme}
            fontFamily={terminalAppearance.fontFamily}
            fontSize={terminalAppearance.fontSize}
            scrollback={terminalAppearance.scrollback}
          />
        </div>

        {view === 'orchestrator' ? <ConsoleInput /> : null}

        {isEntityView(view) && entity ? (
          /*
           * Keyed by entity: switching sessions remounts the row, which clears
           * a half-typed message meant for somebody else and re-runs its
           * autofocus.
           */
          <MessageInput
            key={entity.id}
            entityId={entity.id}
            inputRef={messageInputRef}
          />
        ) : null}
      </div>
    </main>
  );
}
