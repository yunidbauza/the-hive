import { useEffect, useMemo, useRef } from 'react';

import { useDeclinedBack } from '@/hooks/use-declined-back';
import { isTerminalView, resolveView } from '@/lib/resolve-view';
import { cn } from '@/lib/utils';
import { isAgent, isSession, isTerminated } from '@/types/entity';

import { SessionMetaBar } from '@components/layout/session-meta-bar';
import { TerminalHost } from '@components/terminal/terminal-host';
import { SplitHandle } from '@components/ui/split-handle';
import { TerminalHint } from '@components/ui/terminal-hint';
import { AgentView } from '@features/agents/components/agent-view';
import { EditorPane } from '@features/editor/components/editor-pane';
import { EditorTabStrip } from '@features/editor/components/editor-tab-strip';
import { ConsoleInput } from '@features/orchestrator/components/console-input';
import { FleetPane, TRANSCRIPT_FLOOR } from '@features/orchestrator/components/fleet-pane';
import { MessageInput } from '@features/sessions/components/message-input';
import { NewSessionPicker } from '@features/sessions/components/new-session-picker';
import { SessionBootCover } from '@features/sessions/components/session-boot-cover';
import { useSessionBoot } from '@features/sessions/hooks/use-session-boot';
import { SettingsOverlay } from '@features/settings/components/settings-overlay';
import { isMacPlatform } from '@lib/platform';
import {
  TERMINAL_CHORD_EVENT,
  backChordLabel,
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
  /**
   * Whether the session on screen is still starting (HIVE-101).
   *
   * Asked for the active tab only. The hook also owns the timeout and the
   * keystroke that lift the cover without a ready signal — both belong to
   * whatever is on screen, which is this component's subject.
   */
  const terminalRegion = useRef<HTMLDivElement>(null);
  const booting = useSessionBoot(
    isTerminalView(view) ? activeTab : null,
    terminalRegion,
  );
  const showingPicker = view === 'picker';
  /**
   * Both full-stage overlays hide the terminal region, not just the picker.
   *
   * This gate drives two things — the `hidden` class and `TerminalHost`'s
   * `activeId` — and a settings overlay that did not extend it would render on
   * top of thirteen live terminals.
   */
  const showingOverlay = showingPicker || view === 'settings';
  /**
   * The agent view owns the whole column, so the terminal region stands down.
   *
   * Both are `flex-1` children of one column, so leaving the region mounted
   * and visible split the stage in half and left the bottom of it blank —
   * agents build no transport, so there was nothing down there to draw. The
   * orchestrator does not have this problem because `SessionTable` is
   * content-sized rather than `flex-1`.
   *
   * Hidden rather than unmounted, exactly as `showingOverlay` does it:
   * `TerminalHost` holds every session's live instance, and unmounting it to
   * look at an agent would cost each of them its scrollback.
   */
  const showingAgent = view === 'agent';

  /*
    Agents are not in this list any more (HIVE-116).

    They used to be, which gave every definition on disk a cached transport and
    a read-only xterm replaying its lines. An agent now has a view of its own —
    a run log is a transcript, not a terminal — so nothing here should ever
    build one a `TerminalHost` will not mount.
  */
  const ids = useMemo(() => [ORCHESTRATOR_ID, ...navOrder], [navOrder]);

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

  /**
   * The box the fleet table and the transcript divide between them.
   *
   * Not the terminal column: the column also holds the meta bar above and the
   * console rows below, all fixed height, and a share of *that* is not a share
   * of anything a reader can see. This wrapper holds exactly the two panes (and
   * the agent view, which stands in for both), so the table's `flex-basis`
   * percentage and the divider's reading name the same thing — the table's
   * share of the space that is actually being split.
   *
   * The ratio itself is **not read here**. `FleetPane` subscribes to it, so a
   * drag re-renders one table and one hairline rather than this component and,
   * through `TerminalHost`, every mounted terminal — see its docblock.
   */
  const paneSplitRef = useRef<HTMLDivElement>(null);

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
  /**
   * The other half of the same announcement (HIVE-79).
   *
   * Read here rather than inside `TerminalHost` because it is the *stage* that
   * owns what is drawn over a terminal — the boot cover beside it is the same
   * shape, read the same way, from the same component.
   *
   * It is worth being honest that this costs a render of every mounted surface,
   * twice per announcement: neither `TerminalHost` nor `TerminalSurface` is
   * memoized, so state flipped here reaches all of them. That is affordable
   * only because the announcement is rare — see {@link claimBareBack}, which
   * stays silent through ordinary editing. It would not be affordable on every
   * arrow key, and an earlier revision that announced that often would have
   * made this comment a lie.
   *
   * Scoped to the active tab, so the strip cannot outlive the terminal that
   * raised it.
   */
  const declinedBack = useDeclinedBack(activeTab);

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
        {/*
          `isSession` as well as `isTerminalView`, and not merely to satisfy the
          narrowed prop: the two answer different questions — one about the
          view, one about the entity behind it — and an agent that reached
          here would be a routing bug worth rendering nothing for rather than
          crashing on a missing `project`.
        */}
        {isTerminalView(view) && entity && isSession(entity) ? (
          <SessionMetaBar entity={entity} />
        ) : null}

        {/*
          The fleet table sits above the transcript rather than inside it. The
          concept scrolls them as one region, but the transcript is a real xterm
          with its own viewport, and a DOM table cannot share it — so the table
          keeps its own scroll and the terminal fills what is left.

          "What is left" is now a *choice*, not a remainder. The table used to
          size itself to its content, which with a long fleet meant the whole
          column minus the transcript's 10rem floor — the overmind's own
          conversation reduced to a few lines under a wall of ended sessions.
          `FleetPane` gives it a share of this box instead, half by default,
          dragged through the divider beneath it and capped at the table's own
          content so a short fleet stays short. The transcript's `min-h-40`
          below is its floor, and the pane's bounds are computed from that
          same number so the divider cannot be driven into it. Both are lifted
          while the editor splits the stage: in a 20% column a floor would
          overflow it rather than yield.
        */}
        <div ref={paneSplitRef} className="flex min-h-0 flex-1 flex-col">
        {view === 'orchestrator' ? (
          <FleetPane containerRef={paneSplitRef} floored={!splitting} />
        ) : null}

        {/*
          The agent's own surface, mounted the way the console's table is:
          beside the terminal region rather than inside it, because it is not a
          terminal and must not inherit one's chrome (HIVE-116).
        */}
        {view === 'agent' && entity !== null && isAgent(entity) ? (
          <AgentView entity={entity} />
        ) : null}

        {/*
          Clicking the terminal focuses the message row, as the concept does —
          the row should feel like part of the terminal, not a form beneath it.
          Not a button: this is a click *target*, and the keyboard already
          reaches the input directly.
        */}
        {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events */}
        <div
          /*
            `relative` for the boot cover alone (HIVE-101), which fills this box
            rather than the stage: the cover stands in for the *terminal*, so it
            must not reach over the meta bar above it — the branch and status
            there are worth reading while a session starts, and are the only
            things on screen that say which session it is.
          */
          ref={terminalRegion}
          /*
            A **floor** on the transcript, in the one view where something else
            competes for its height.

            The fleet table can shrink and scroll now, and a flex item with
            `flex-1` (basis `0`) absorbs none of a negative free space — so all
            of the shrinking lands on the table, and without a floor here it
            would keep taking until the transcript was gone. The overmind is a
            table *and* a conversation; either at zero height is a broken
            screen.

            Conditional rather than unconditional, because the floor is not free
            everywhere. In a split the terminal column is `flex: 0 0 <ratio>%`
            and `MIN_SPLIT_RATIO` is 20%, which at the minimum window height is
            under ten rem — a floor there would overflow the column and draw
            over the handle instead of yielding. An entity view needs no floor
            at all: this region is the only flexible thing in the column, so
            `min-h-0` is what it has always effectively had.
          */
          className={cn(
            'relative flex flex-1 flex-col',
            view === 'orchestrator' && !splitting ? TRANSCRIPT_FLOOR.className : 'min-h-0',
            showingAgent && 'hidden',
          )}
          onClick={focusMessageInput}
        >
          <TerminalHost
            entries={entries}
            /*
             * `null` while either overlay is open: that marks every surface
             * invisible, so closing it re-reveals the previous one and
             * triggers its refit through the machinery story 042 already has.
             */
            activeId={
              showingOverlay || editorFull || showingAgent ? null : activeTab
            }
            endedId={endedId}
            palette={terminalAppearance.palette}
            fontFamily={terminalAppearance.fontFamily}
            fontSize={terminalAppearance.fontSize}
            scrollback={terminalAppearance.scrollback}
          />

          {/*
            Drawn over a terminal that is still mounted and still laid out —
            never instead of one. See `SessionBootCover` for why that is a hard
            requirement rather than a convenience.

            Gated on the *active* tab, so switching away from a booting session
            and back finds the cover still there, and a session booting in the
            background covers nothing.
          */}
          {booting ? <SessionBootCover /> : null}

          {/*
            The app saying where the user just went (HIVE-79).

            Anchored to the foot of the terminal region because that is where
            the caret is, and the caret is what the user was watching when `←`
            did something they did not ask for. `absolute` so it costs the
            terminal no layout — a strip that resized the surface would refit
            xterm and reflow the transcript to announce a keystroke.

            Gated on the event alone. A second gate on "is this terminal live"
            was written first and taken out: only an interactive surface
            installs a key handler at all (`terminal-surface.tsx`), so nothing
            else can raise this, and the region it sits in is already hidden
            along with the terminal whenever an overlay or a full-stage editor
            covers it. A condition that can never be false is not a safety net,
            it is a branch no test can reach.
          */}
          {declinedBack ? (
            <TerminalHint
              className="absolute inset-x-0 bottom-0"
              said="← went to the session"
              chord={backChordLabel(isMacPlatform())}
              does="returns to the overmind"
            />
          ) : null}
        </div>
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
        {isTerminalView(view) && entity && !activeIsLive ? (
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
              label="Resize the editor"
              value={splitRatio}
              onValue={setSplitRatio}
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
