import { useEffect, useMemo, useRef } from 'react';

import { isEntityView, resolveView } from '@/lib/resolve-view';
import { cn } from '@/lib/utils';
import { isTerminated } from '@/types/entity';

import { SessionMetaBar } from '@components/layout/session-meta-bar';
import { TerminalHost } from '@components/terminal/terminal-host';
import { SplitHandle } from '@components/ui/split-handle';
import { EditorPane } from '@features/editor/components/editor-pane';
import { EditorTabStrip } from '@features/editor/components/editor-tab-strip';
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
import {
  useEditorLayout,
  useSetEditorSplitRatio,
  useTerminalAppearance,
} from '@stores/appearance-store';
import { useActiveFileKey, useHasOpenFiles } from '@stores/editor-store';
import {
  terminalIdFor,
  useActiveEntity,
  useAgentOrder,
  useNavOrder,
} from '@stores/hive-store';
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
  /**
   * The one place appearance crosses into the terminal (story 105, extended by
   * HIVE-80).
   *
   * `components/terminal/**` may not import `stores/**` — the lint zone fails
   * the build — so the composition root reads the store and passes props. Since
   * HIVE-80 that includes the colours: the terminal used to be told which *mode*
   * was on and look the palette up for itself, and now it is handed the eleven
   * colours the way it is handed a font stack. The seam stays a seam, and it got
   * narrower.
   */
  const terminalAppearance = useTerminalAppearance();
  const activeTab = useActiveTab();
  const entity = useActiveEntity();
  const navOrder = useNavOrder();
  const agentOrder = useAgentOrder();
  const { picker } = usePickerState();
  const settings = useSettingsOpen();

  /**
   * The editor's two facts, kept apart deliberately.
   *
   * `activeFileKey` says whether a file is on screen; `placement` says whether
   * that file *replaces* the terminal or sits beside it. Only the combination
   * is a view state, which is why `resolveView` takes one boolean rather than
   * both — see the note on `ViewInput.editorFull`.
   */
  const activeFileKey = useActiveFileKey();
  const hasOpenFiles = useHasOpenFiles();
  const { placement, splitAxis, splitRatio, nav } = useEditorLayout();
  const setSplitRatio = useSetEditorSplitRatio();

  const editorOpen = activeFileKey !== null;
  const editorFull = editorOpen && placement === 'full';
  const splitting = editorOpen && placement === 'split';

  const view = resolveView({ activeTab, picker, settings, entity, editorFull });
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

  const messageInputRef = useRef<HTMLTextAreaElement>(null);

  /** The flex container the split handle measures its ratio against. */
  const splitRef = useRef<HTMLDivElement>(null);

  const entries = useMemo(
    () =>
      ids.map((id) => {
        /**
         * The cache is keyed on the **terminal**, not the row.
         *
         * Identical for every session that has never been cleared. For a
         * successor minted by `/clear` it is what makes the transport — and so
         * the pty behind it — be *inherited* rather than created: a fresh entry
         * here would call `resolveTransport` again and spawn a second process
         * in the same directory.
         */
        const terminalKey = terminalIdFor(id);
        let transport = cache.current.get(terminalKey);
        if (!transport) {
          transport = resolveTransport(id);
          cache.current.set(terminalKey, transport);
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
        return { id, terminalKey, transport, readOnly: !isLiveTerminal(id) };
      }),
    [ids],
  );

  /** Whether the surface currently on screen is a live shell. */
  const activeIsLive =
    entries.find((entry) => entry.id === activeTab)?.readOnly === false;

  /**
   * The one surface that may be looking at a dead pty (story 108).
   *
   * Derived from `entity`, which this component already subscribes to, so
   * knowing it costs nothing. Only the visible terminal can hold focus, and
   * `ended` only affects keys and stdin, so the visible one is the only one that
   * needs to know.
   */
  const endedId = isTerminated(entity ?? undefined) ? activeTab : null;

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
        throw away the scrollback story 042 exists to preserve. The editor gets
        the same treatment for the same reason — see the terminal column below.
      */}
      <div className={cn('flex min-h-0 flex-1 flex-col', showingOverlay && 'hidden')}>
        {/*
          Stage chrome, above both regions.

          `showTerminalTab` is the whole interaction between the two editor
          settings: a Terminal entry exists exactly when the terminal is
          hidden, which is only ever full-stage placement. In a split the
          terminal is already on screen and an entry offering to "go to" it
          would point at something the user is looking at.
        */}
        {hasOpenFiles && nav === 'tabs' ? (
          <EditorTabStrip showTerminalTab={placement === 'full'} />
        ) : null}

        <div
          ref={splitRef}
          className={cn(
            'flex min-h-0 flex-1',
            splitting && splitAxis === 'vertical' ? 'flex-row' : 'flex-col',
          )}
        >
          {/*
            The terminal column.

            `hidden` rather than unmounted when the editor fills the stage —
            the same rule the overlays follow, and for the same reason: every
            live xterm and its scrollback would go with it.
          */}
          <div
            className={cn(
              'flex min-h-0 min-w-0 flex-col',
              editorFull && 'hidden',
              !splitting && !editorFull && 'flex-1',
            )}
            /*
              `flex: 0 0 <ratio>%` rather than a width or a height: the same
              declaration divides the container on either axis, so the split
              needs one style and not two branches. The editor takes the rest
              with `flex-1`, which means a window resize moves the seam
              proportionally instead of pinning the terminal to a pixel count.
            */
            style={splitting ? { flex: `0 0 ${splitRatio * 100}%` } : undefined}
          >
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
            activeId={showingOverlay || editorFull ? null : activeTab}
            endedId={endedId}
            palette={terminalAppearance.palette}
            fontFamily={terminalAppearance.fontFamily}
            fontSize={terminalAppearance.fontSize}
            scrollback={terminalAppearance.scrollback}
          />
        </div>

        {view === 'orchestrator' ? <ConsoleInput /> : null}

        {/*
          The message row exists for surfaces that cannot be typed into
          (story 108).

          A live session **is** Claude Code's own prompt, and stacking a second
          text box beneath it gives one session two places to type — with
          different keybindings, different history, and no way to tell from the
          caret which one will receive the next character. Worse, this row's
          autofocus was fighting the terminal's for every newly opened session,
          which is the bug that made a brand-new session ignore what was typed
          into it. There is one input on this screen now, and it is the terminal.

          Recorded transcripts keep the row, because they have no prompt of their
          own: the browser demo and the agent tabs are replays, and the row is
          the only way to speak to them.
        */}
        {isEntityView(view) && entity && !activeIsLive ? (
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

          {splitting ? (
            <SplitHandle
              axis={splitAxis}
              containerRef={splitRef}
              ratio={splitRatio}
              onRatio={setSplitRatio}
            />
          ) : null}

          {/*
            The editor is unmounted when nothing is open, unlike the terminal.

            The asymmetry is deliberate: an xterm holds a live process and a
            scrollback that cannot be rebuilt, and a CodeMirror view holds text
            that `editor-store` still has. Closing the last file should give the
            terminal every pixel back, and a hidden editor would keep a
            `ResizeObserver` and a document alive to show nothing.
          */}
          {editorOpen ? (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <EditorPane />
            </div>
          ) : null}
        </div>
      </div>
    </main>
  );
}
