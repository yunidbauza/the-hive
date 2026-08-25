import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal, type IBufferCell, type IBufferLine } from '@xterm/xterm';
import { useEffect, useRef, useState } from 'react';

import { isMacPlatform } from '@lib/platform';
import { xtermThemeFor, type TermPalette } from '@lib/terminal/ansi';
import { shouldAutoScroll } from '@lib/terminal/auto-scroll';
import {
  FRAME_SCAN,
  isBareBack,
  LINE_MOTION_SEQUENCE,
  NEWLINE_SEQUENCE,
  TERMINAL_CHORD_EVENT,
  decideTerminalKey,
  type CursorContext,
  type TerminalChordDetail,
} from '@lib/terminal/keymap';
import type { TerminalTransport } from '@lib/terminal/terminal-transport';

import '@xterm/xterm/css/xterm.css';

/** xterm's line-height is a multiple of the font size, not a CSS length. */
const LINE_HEIGHT = 1.4;

/** WCAG AA for body text. See the note where it is passed to xterm. */
const MINIMUM_CONTRAST_RATIO = 4.5;

/**
 * Fallbacks for a caller that expresses no preference — the orchestrator
 * console, and every test that renders a surface directly. The *settings* live
 * in `lib/terminal/fonts.ts`; these are deliberately duplicated rather than
 * imported, because this component may not depend on a module that exists to
 * describe a user's choices. It takes a font stack and a number.
 */
const DEFAULT_FONT_FAMILY = "ui-monospace, Menlo, 'SF Mono', monospace";
const DEFAULT_FONT_SIZE = 12.5;
/** Deep enough that no fixture transcript can reach the top of the buffer. */
const DEFAULT_SCROLLBACK = 5000;

export interface TerminalSurfaceProps {
  /** The only channel in or out. See `lib/terminal/terminal-transport.ts`. */
  transport: TerminalTransport;
  /**
   * Opaque label, surfaced as `data-terminal-id`. Carries no meaning here — it
   * exists so end-to-end specs can assert that a given surface's DOM node
   * survives a tab switch, which is the mechanism behind kept-alive scrollback.
   */
  id?: string;
  /**
   * The colours this terminal paints in, already resolved — eleven roles, no
   * mode name (HIVE-80).
   *
   * Handed over exactly as {@link TerminalSurfaceProps.fontFamily} is: this
   * component knows it was given colours, not that a theme exists or that a
   * user imported one. Which palette arrives is the composition root's
   * business.
   *
   * **Referential stability is part of the contract.** The re-theme effect
   * below depends on this object's identity, so a caller that rebuilds the
   * palette each render would re-theme every live terminal on every render.
   */
  palette: TermPalette;
  /** A CSS font stack, already resolved. This component knows nothing of fonts. */
  fontFamily?: string;
  fontSize?: number;
  scrollback?: number;
  /** Orchestrator console and every prototype view: input is a separate row. */
  readOnly?: boolean;
  /**
   * Whether this surface is the one on screen. Kept-alive instances are hidden
   * with CSS rather than unmounted (see `terminal-host.tsx`), and a terminal
   * fitted while hidden measured a zero-height box — so becoming visible has to
   * trigger a refit.
   */
  visible?: boolean;
  /**
   * The process behind this surface has ended (story 108).
   *
   * A *fact about the backend*, not a domain concept: this component still has
   * no idea what a session is. What it does with the fact is stop pretending to
   * be typable — stdin off, cursor still — and hand bare `←` to the app, which
   * is the one way out of a terminal that will never answer another keystroke.
   * Without it a finished session is a black rectangle that swallows every key,
   * including the one the user presses to leave.
   */
  ended?: boolean;
}

/** What the mount effect builds, held together so dependents can re-run. */
interface Instance {
  terminal: Terminal;
  fitAddon: FitAddon;
}

/** Whether the viewport is parked at the end of the transcript. */
const atBottom = (terminal: Terminal) =>
  shouldAutoScroll(terminal.buffer.active.viewportY, terminal.buffer.active.baseY);

/**
 * The caret's row, with Claude's own faint text blanked out (HIVE-79).
 *
 * The cell-by-cell walk exists for exactly one thing: Claude Code writes a
 * placeholder into its empty input — `❯ Try "write a test for …"` — as real
 * cells, and `translateToString` cannot tell it from a message the user typed.
 * `\x1b[2m` can: the placeholder is faint and typed input never is. Blanking
 * faint cells leaves the row holding what the *user* put there, which is the
 * only thing the decision is entitled to ask about.
 *
 * **The caret's row and no other.** Applying this to the whole window would put
 * the frame's edges through it too, and an edge Claude ever drew faint would
 * read as an all-blank row — the frame would stop being found and the feature
 * would switch itself off, silently and permanently, exactly as the
 * alternate-buffer assumption did. Edges are matched on raw text; rendition is
 * consulted only where the question is "did the user type this?".
 *
 * `scratch` is xterm's own reusable cell. Without it `getCell` allocates a
 * fresh `CellData` per column, and `←` autorepeats when held.
 *
 * Falls back to `translateToString` when the buffer will not hand over a cell,
 * so the row is never lost outright — worst case it reads as it did before.
 */
function readTypedRow(line: IBufferLine, scratch: IBufferCell): string {
  let text = '';
  for (let column = 0; column < line.length; column += 1) {
    const cell = line.getCell(column, scratch);
    if (!cell) return line.translateToString(true);
    // Width 0 is the trailing half of a wide glyph; it has no character of its
    // own and the leading half already contributed one.
    if (cell.getWidth() === 0) continue;
    const chars = cell.getChars();
    text += cell.isDim() !== 0 || chars === '' ? ' ' : chars;
  }
  return text.replace(/\s+$/u, '');
}

/**
 * The rows the bare-`←` decision needs, read straight out of the buffer.
 *
 * This is the closest this component comes to knowing what is *running* inside
 * it, and the line it does not cross is worth being explicit about: it reports
 * **text, a caret position, and which buffer is on screen** — exactly what a
 * terminal has. Whether those rows mean "Claude is waiting for a message" is
 * decided in `lib/terminal/keymap.ts`, which is where a rule about a program
 * belongs and where it can be tested without a DOM. The seam is what makes the
 * terminal swappable, and reading its own buffer does not breach it — importing
 * a store to ask which session this is would.
 *
 * A **window** around the caret rather than two rows (HIVE-79). Two were not
 * enough to answer the question the decision actually asks — *is anything typed
 * in the whole input?* — and reading only the caret's row and the one below it
 * both stole the key from a half-written multi-line message and leaked it at an
 * input that really was empty. See {@link CursorContext}.
 *
 * Returns `null` when the caret's own row cannot be read, and the decision then
 * falls back to chord-only. Absent information is never treated as a match.
 */
function readCursorContext(terminal: Terminal): CursorContext | null {
  const buffer = terminal.buffer.active;
  const caret = buffer.baseY + buffer.cursorY;
  const caretLine = buffer.getLine(caret);
  if (!caretLine) return null;

  const first = Math.max(0, caret - FRAME_SCAN);
  const rows: string[] = [];
  for (let row = first; row <= caret + FRAME_SCAN; row += 1) {
    /**
     * Right-trimmed, because a terminal row is padded to the full width. A row
     * the buffer cannot report becomes `''`, which is not a frame edge — so a
     * window that runs off the end of the buffer declines in the same way an
     * unrecognised one does, rather than throwing.
     */
    rows.push(buffer.getLine(row)?.translateToString(true) ?? '');
  }

  return {
    rows,
    caretRow: caret - first,
    caretText: readTypedRow(caretLine, buffer.getNullCell()),
  };
}

/**
 * Reported rather than swallowed outright (HIVE-92).
 *
 * These used to fail invisibly, and that was survivable only because it was not
 * really the end of the story: the browser's own Copy/Paste still ran, so a
 * rejected `readText` looked like a working paste rather than a broken one. Now
 * that the keydown is cancelled, this **is** the only path — a rejection means
 * the chord did nothing at all, which is precisely the kind of silence that
 * cost this bug a diagnosis.
 *
 * Still not rethrown: `writeText`/`readText` reject when the document is not
 * focused or permission is denied, and neither is worth an unhandled rejection
 * in the console of an app whose terminal is otherwise fine. A warning is the
 * middle ground — a dead paste becomes greppable instead of a mystery.
 */
function reportClipboardFailure(action: 'copy' | 'paste', reason: unknown): void {
  console.warn(`terminal: clipboard ${action} failed`, reason);
}

/**
 * Copy the selection, then drop it.
 *
 * Clearing matters most on Linux and Windows, where bare `Ctrl+C` copies only
 * *because* there is a selection: leaving it in place would mean the second
 * press copied again instead of interrupting, and a user trying to stop a
 * runaway process would press it repeatedly to no effect.
 */
function copySelection(terminal: Terminal): void {
  const selection = terminal.getSelection();
  if (selection === '') return;
  terminal.clearSelection();
  void navigator.clipboard
    ?.writeText(selection)
    .catch((reason: unknown) => reportClipboardFailure('copy', reason));
}

/** Paste as if typed — through the terminal, so bracketed paste is honoured. */
function pasteFromClipboard(terminal: Terminal): void {
  void navigator.clipboard
    ?.readText()
    .then((text) => {
      if (text !== '') terminal.paste(text);
    })
    .catch((reason: unknown) => reportClipboardFailure('paste', reason));
}

/**
 * Refit, keeping a bottom-parked viewport at the bottom.
 *
 * Fewer rows means rows come off the bottom of the viewport, so a terminal
 * showing the end of its transcript silently ends up showing the middle — the
 * newest line, the one the user is actually waiting on, scrolls out of sight
 * without anyone touching the wheel. Two things trigger it: the window
 * resizing, and the session meta bar appearing above a terminal that was
 * already fitted without one.
 *
 * Same rule as new output, for the same reason: follow the end only for a
 * reader who was already there.
 *
 * **Every caller must have established that the surface is visible.** See
 * {@link visibleRef} for what fitting a hidden one does.
 */
function fitPreservingBottom({ terminal, fitAddon }: Instance) {
  const stick = atBottom(terminal);
  fitAddon.fit();
  if (stick) terminal.scrollToBottom();
}

/**
 * A real terminal, fed by a transport and nothing else.
 *
 * This component is the reason the seam exists: it has no idea what a session
 * is, cannot reach the store, and would fail `pnpm lint` if it tried. Swapping
 * `StaticTransport` for a PTY-backed one is invisible from here.
 */
export function TerminalSurface({
  transport,
  id,
  palette,
  fontFamily = DEFAULT_FONT_FAMILY,
  fontSize = DEFAULT_FONT_SIZE,
  scrollback = DEFAULT_SCROLLBACK,
  readOnly = false,
  visible = true,
  ended = false,
}: TerminalSurfaceProps) {
  /**
   * Container and instance both live in state behind callback refs rather than
   * in `useRef`. Two reasons, and neither is style: a ref's `.current` is
   * already populated when the mount effect runs, which makes its null-check
   * dead code that erodes the coverage gate; and holding the *instance* in
   * state is what lets the subscription and theme effects below re-run when a
   * new terminal is constructed, instead of silently writing into a disposed
   * one.
   */
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [instance, setInstance] = useState<Instance | null>(null);

  /**
   * The resize observer is created once, in the mount effect, but must always
   * report to the *current* transport. Capturing `transport` in that closure
   * would pin it to whichever transport was current at construction, so after a
   * swap every resize would be delivered to the old backend — silently, since
   * both implementations return void. A ref is the narrow fix: the observer
   * reads it at call time.
   */
  const transportRef = useRef(transport);
  useEffect(() => {
    transportRef.current = transport;
  }, [transport]);

  /**
   * Same reason as `transportRef`, one story later: the custom key handler is
   * installed once, in the mount effect, and a captured `ended` would pin it to
   * whatever was true when the terminal was constructed — which is always
   * `false`, since a surface mounts long before its process ends. The handler
   * has to ask at keystroke time or the escape hatch never opens.
   */
  const endedRef = useRef(ended);
  useEffect(() => {
    endedRef.current = ended;
  }, [ended]);

  /**
   * Whether this surface is on screen, readable from the resize observer.
   *
   * ## What fitting a hidden surface does
   *
   * A kept-alive instance is hidden with `display: none`, and hiding it fires
   * the observer with a zero box. An element in a `display: none` subtree has no
   * used values, so `getComputedStyle` hands the fit addon back the *specified*
   * `height: 100%` / `width: 100%` — which it parses as the number `100`. Not
   * `NaN`, so its own guard passes; not the real size either, so it proposes
   * roughly **11×5**.
   *
   * That is not a cosmetic error, because two things then happen. `fit()`
   * reflows the buffer to eleven columns, and the new size is forwarded to the
   * pty — so the child process repaints its entire TUI at eleven columns.
   * Returning to the session refits to the real width, but there is nothing left
   * to restore: the wide rows were overwritten while nobody was looking. The
   * user sees a transcript shredded into a narrow ribbon.
   *
   * ## Why a ref written during render
   *
   * The obvious version — an effect, like {@link transportRef} above — loses a
   * race it cannot afford. Hiding a surface goes: React commits `display: none`
   * → the browser lays out → the observer fires → *then* passive effects run.
   * A `visible` updated in an effect is still `true` at the moment the zero-box
   * notification arrives, which is precisely the notification that has to be
   * ignored. Written during render, it is correct before the DOM change it
   * describes is even painted.
   *
   * Deliberately **not** a `clientWidth` check on the container. That would be
   * synchronous too, and it would be wrong in the other direction: a visible
   * surface briefly measuring zero mid-layout would skip its fit and never get
   * another, because no further resize is coming. Visibility is the condition
   * that has a guaranteed follow-up — the reveal effect below.
   */
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  useEffect(() => {
    if (!container) return;

    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: !readOnly,
      disableStdin: readOnly,
      fontFamily,
      fontSize,
      lineHeight: LINE_HEIGHT,
      scrollback,
      /**
       * The floor that makes the surface slots safe (HIVE-82).
       *
       * `black` and `brightBlack` are panel fills now, not text. That is right
       * for the programs that paint panels with them, and wrong for the older
       * convention where a CLI detecting a light terminal picks slot 30 for
       * body text — against a light `black`, that text would be invisible.
       *
       * xterm's answer is to adjust the *foreground* until it clears a ratio
       * against whatever it is drawn on. At its default of `1` it does nothing,
       * which is what `ansi.ts` used to record as the reason the old mapping
       * had to stand. At 4.5 it holds body text to WCAG AA and leaves anything
       * already legible untouched.
       *
       * It cannot rescue a background, which is the asymmetry the whole
       * inversion rests on: a bad foreground is recoverable, a near-black slab
       * across a white terminal is not.
       */
      minimumContrastRatio: MINIMUM_CONTRAST_RATIO,
      theme: xtermThemeFor(palette),
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    // Makes a URL pasted into a transcript clickable, which is the difference
    // between "looks like a terminal" and "behaves like one".
    terminal.loadAddon(new WebLinksAddon());

    /**
     * Who owns a keystroke (story 095). Read-only surfaces skip it entirely —
     * they send nothing to a pty, so there is no conflict to arbitrate, and
     * installing a handler on the orchestrator console would be the regression
     * the console's own test exists to catch.
     */
    if (!readOnly) {
      const isMac = isMacPlatform();
      terminal.attachCustomKeyEventHandler((event) => {
        // `keypress`/`keyup` arrive here too. Deciding on anything but keydown
        // would run the copy twice and fight the pty for the same chord.
        if (event.type !== 'keydown') return true;

        const action = decideTerminalKey(event, {
          isMac,
          hasSelection: terminal.hasSelection(),
          /** Read per keystroke, not captured. See {@link endedRef}. */
          ended: endedRef.current,
          /**
           * Read per keystroke rather than cached. The buffer moves under us
           * constantly — every chunk of agent output rewrites these rows — and
           * a cached answer would decide the *previous* screen's question.
           *
           * Read only for the key it is *for*. Nothing else in the matrix
           * consults it, and since HIVE-79 the read walks every cell of
           * seventeen rows to find Claude's faint placeholder — work worth
           * doing once for `←` and not worth doing on every character typed
           * into a shell.
           */
          cursor: isBareBack(event) ? readCursorContext(terminal) : null,
        });

        switch (action) {
          /**
           * Cancelled, not merely declined — the clipboard chords are the two
           * whose browser default *also* does the job, so leaving it in place
           * means the job happens twice (HIVE-92).
           *
           * Returning `false` is not a cancel. xterm's `_keyDown` returns early
           * on a false custom-handler result, before it would reach its own
           * `cancel(event)`, so the keydown keeps its default action. For
           * `paste` that default is the browser's own Paste against xterm's
           * focused helper `<textarea>`, which fires xterm's `paste` listener
           * and puts the clipboard on stdin a second time. For `copy` it is a
           * native Copy racing {@link copySelection}'s `clearSelection` for the
           * selection it is reading.
           *
           * On macOS this also closes the Edit menu's `{ role: 'paste' }`,
           * which an *unhandled* keydown is forwarded to — a third route to the
           * same duplicate. The menu cannot opt out (`registerAccelerator:
           * false` is not honoured there), so the renderer is the only place
           * this fix can live.
           */
          case 'copy':
            copySelection(terminal);
            event.preventDefault();
            return false;
          case 'paste':
            pasteFromClipboard(terminal);
            event.preventDefault();
            return false;
          /**
           * Written to the transport rather than declined, because xterm
           * encodes nothing at all for `Cmd`+arrow — declining would leave the
           * keystroke silently doing nothing, which is the defect (story 110).
           * The surface stays ignorant of *why*: it is told which sequence the
           * chord means and puts it on stdin.
           */
          case 'line-start':
          case 'line-end':
            transportRef.current.write(LINE_MOTION_SEQUENCE[action]);
            event.preventDefault();
            return false;
          /**
           * Written for the same reason as the line motions, from the opposite
           * failure: xterm encodes *too little* here rather than nothing at all.
           * Its `case 13` ignores `shiftKey`, so declining would let it send a
           * bare `\r` — the very byte that submits. See {@link NEWLINE_SEQUENCE}.
           */
          case 'newline':
            transportRef.current.write(NEWLINE_SEQUENCE);
            event.preventDefault();
            return false;
          /**
           * Announced, not merely declined.
           *
           * The terminal says "a chord happened here" and nothing more — it
           * does not know that the app will navigate, which is what keeps this
           * component ignorant of domain concepts. Firing a specific event
           * rather than letting the keystroke bubble is what stops the app from
           * having to sniff every `keydown` on `window`, where the same
           * combination is "move caret to start of line" in any text field.
           */
          case 'app-chord': {
            const detail: TerminalChordDetail = { chord: 'back' };
            container.dispatchEvent(
              new CustomEvent(TERMINAL_CHORD_EVENT, { detail, bubbles: true }),
            );
            event.preventDefault();
            return false;
          }
          /**
           * Announced **and** handed on — the one branch that does both
           * (HIVE-79).
           *
           * Every other announcement here is also a claim: the app takes the
           * key, so the pty must not see it. This one is the opposite. The
           * claim was declined, so the key belongs to the child process exactly
           * as it always did — no `preventDefault`, `true` so xterm encodes the
           * arrow and writes it to stdin — and the event carries no navigation,
           * only the news that it happened.
           *
           * That asymmetry is the whole point of the ticket. The app used to
           * lose this key without ever learning it had been pressed, which is
           * why a user who ended up in Claude Code's own agent list had no way
           * back that the app could offer them. It can offer one now.
           */
          case 'back-declined': {
            const detail: TerminalChordDetail = { chord: 'back-declined' };
            container.dispatchEvent(
              new CustomEvent(TERMINAL_CHORD_EVENT, { detail, bubbles: true }),
            );
            return true;
          }
          default:
            return true;
        }
      });
    }

    terminal.open(container);
    // The initial fit is deliberately not done here — the visibility effect
    // below owns every fit, so a surface that mounts hidden is not measured
    // against a zero-height box and a visible one is not fitted twice.

    /**
     * Hidden surfaces are not measured, and are not reported (story 108).
     *
     * Hiding one fires this observer with a zero box; acting on that is what
     * corrupts a backgrounded session, and telling the pty about it is what
     * makes the corruption survive coming back. See {@link visibleRef}. The
     * backgrounded terminal keeps the size it was last actually shown at, and
     * the reveal effect below re-fits it when there is something to measure.
     */
    const resizeObserver = new ResizeObserver(() => {
      if (!visibleRef.current) return;
      fitPreservingBottom({ terminal, fitAddon });
      transportRef.current.resize(terminal.cols, terminal.rows);
    });
    resizeObserver.observe(container);

    setInstance({ terminal, fitAddon });

    return () => {
      resizeObserver.disconnect();
      terminal.dispose();
      setInstance(null);
    };
    /**
     * Only `container` and `readOnly` rebuild.
     *
     * `palette`, `transport`, and the three appearance options are absent because
     * each is handled by an effect below — a rebuild disposes the terminal, and
     * disposing the terminal throws away the scrollback of a kept-alive
     * instance. Changing a font size should not clear thirteen transcripts.
     *
     * `readOnly` genuinely is structural: xterm cannot change `disableStdin`
     * after construction, and the custom key handler is installed once.
     *
     * (Story 042 listed `fontSize` here and called it structural. That was true
     * only while nothing set it — the prop existed and no caller passed one, so
     * the rebuild path never ran. Story 105 made it a live setting.)
     */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [container, readOnly]);

  /**
   * Re-theme in place. Assigning `options.theme` preserves buffer content.
   *
   * Keyed on the palette's *identity*, which is why {@link
   * TerminalSurfaceProps.palette} has to be a stored object rather than one
   * built per render: a fresh reference every frame would rebuild and reassign
   * the xterm theme on every unrelated re-render, for every kept-alive surface.
   */
  useEffect(() => {
    if (!instance) return;
    instance.terminal.options.theme = xtermThemeFor(palette);
  }, [instance, palette]);

  /**
   * Appearance in place (story 105), buffer intact.
   *
   * The refit is not optional and not defensive: font family and size change
   * the measured cell, so without it the terminal keeps the old `cols`/`rows`,
   * reports stale dimensions to its transport, and renders into a box that no
   * longer matches. `fitPreservingBottom` is the same helper the resize
   * observer uses, for the same reason — a reader parked at the end of a
   * transcript should stay there.
   *
   * `scrollback` needs no refit (it changes buffer depth, not geometry) but
   * shares the effect: three assignments and one fit is cheaper than two
   * effects, and shrinking the buffer while the viewport is deep in it is
   * exactly the case the bottom-preserving fit already handles.
   *
   * **The options are applied to every instance; only the fit waits for
   * visibility.** Appearance is forwarded to all kept-alive surfaces, not just
   * the active one, so this effect runs on hidden terminals too, where there is
   * no box to measure and fitting would shred the buffer ({@link visibleRef}).
   * The visibility effect already re-fits on reveal, which is where the geometry
   * actually exists to measure.
   */
  const appearanceRef = useRef({ fontFamily, fontSize, scrollback });
  useEffect(() => {
    if (!instance) return;

    const previous = appearanceRef.current;
    appearanceRef.current = { fontFamily, fontSize, scrollback };

    /**
     * Nothing to do on the first run for a given instance: the mount effect
     * constructed the terminal with exactly these values. Applying them again
     * would be harmless, but the *fit* would not — it would double the number
     * of fits on mount, and the fit count is what the geometry tests assert
     * because it is what tells the transport how big the pty should be.
     */
    if (
      previous.fontFamily === fontFamily &&
      previous.fontSize === fontSize &&
      previous.scrollback === scrollback
    ) {
      return;
    }

    const { terminal } = instance;
    terminal.options.fontFamily = fontFamily;
    terminal.options.fontSize = fontSize;
    terminal.options.scrollback = scrollback;
    if (visible) fitPreservingBottom(instance);
  }, [instance, fontFamily, fontSize, scrollback, visible]);

  /** Backend output in, keystrokes out. */
  useEffect(() => {
    if (!instance) return;
    const { terminal } = instance;

    const unsubscribe = transport.onData((chunk, parsed) => {
      /**
       * Measured *before* the write: afterwards `baseY` has already advanced to
       * include the new lines, so every append would look like "the user is at
       * the bottom" and reading scrollback would be impossible.
       */
      const stick = atBottom(terminal);

      // xterm parses asynchronously; scrolling from the write callback is what
      // guarantees the new lines exist by the time the viewport moves.
      terminal.write(chunk, () => {
        if (stick) terminal.scrollToBottom();
        /**
         * The same callback answers a second question, for a transport that
         * asks it (story 094): the chunk is now *parsed*, not merely received.
         *
         * That distinction is the whole of story 093's flow control. Reporting
         * it from anywhere else — on arrival, on a timer — measures the IPC
         * channel instead of the terminal, and never acking at all lets the
         * unacked window fill and pause the pty for good. This surface still
         * knows nothing about sessions or sequence numbers; it knows when xterm
         * finished, which is the one fact only it has.
         */
        parsed?.();
      });
    });

    const typing = readOnly
      ? null
      : terminal.onData((data) => transport.write(data));

    return () => {
      unsubscribe();
      typing?.dispose();
    };
  }, [instance, transport, readOnly]);

  /**
   * The only place a fit is requested outside the resize observer.
   *
   * Covers both the first paint and every later reveal: a hidden surface has no
   * geometry to measure, so a terminal fitted while hidden would render at the
   * wrong size for the rest of its life.
   *
   * ## And the keyboard follows the fit (story 108)
   *
   * Becoming visible is exactly the moment a live terminal should be typable:
   * opening a session and finding the keyboard pointed at nothing means the
   * first thing every new session asks of its user is a click, and the app's one
   * claim is that it puts you *in* the terminal. Focus is taken here rather than
   * on mount because `TerminalHost` mounts instances lazily and keeps them alive
   * hidden — mount and reveal are the same event only the first time.
   *
   * Read-only surfaces are excluded, and that exclusion is load-bearing rather
   * than tidy: the orchestrator console is read-only and owns a *separate*
   * command row (story 041) that autofocuses itself. Focusing its transcript
   * would take the caret out of the input the whole console is driven from.
   */
  useEffect(() => {
    if (!instance || !visible) return;
    fitPreservingBottom(instance);
    if (!readOnly) instance.terminal.focus();
  }, [instance, visible, readOnly]);

  /**
   * A finished process stops pretending to accept input (story 108).
   *
   * Both options are live — xterm reads them per keystroke and per blink rather
   * than at construction — which is what lets this be an effect instead of the
   * terminal rebuild that `readOnly` requires. A rebuild would dispose the
   * buffer, and the transcript of a session that just ended is the single most
   * interesting thing on the screen.
   *
   * The cursor matters as much as stdin here. A blinking caret over a dead pty
   * is an invitation, and every character typed into it disappears without a
   * trace — the exact experience of a hung session, produced by one that
   * finished cleanly.
   */
  useEffect(() => {
    if (!instance || readOnly) return;
    instance.terminal.options.disableStdin = ended;
    instance.terminal.options.cursorBlink = !ended;
  }, [instance, readOnly, ended]);

  /**
   * The WebGL renderer, attached to the visible interactive terminal only.
   *
   * The DOM renderer was the right default for fixture transcripts and is the
   * wrong one for a live pty streaming a build log — it allocates elements per
   * cell. But WebGL contexts are a **capped, process-wide** resource (browsers
   * commonly allow ~16), and this app can hold a dozen live terminals at once.
   * Attaching one per instance would exhaust the pool and start silently
   * killing the oldest contexts.
   *
   * So the addon follows visibility rather than lifetime: exactly one context
   * exists, on the terminal the user is looking at. Hidden kept-alive instances
   * (story 042) keep their buffers and give up their GPU context, which costs
   * nothing — nothing is painting them.
   *
   * Read-only surfaces stay on DOM. They render a recording, once.
   */
  useEffect(() => {
    if (!instance || readOnly || !visible) return;
    const { terminal } = instance;

    let addon: WebglAddon | null = new WebglAddon();

    /**
     * A lost context is not an error to report, it is a renderer to stop using.
     *
     * Contexts are lost on GPU driver resets and when too many exist. Without
     * this the terminal simply stops painting — which looks exactly like a
     * frozen session, and sends the user hunting for a hung process that is
     * running perfectly. Disposing the addon drops xterm back to the DOM
     * renderer with the buffer intact.
     *
     * ## And the keyboard survives the renderer swap (HIVE-53)
     *
     * Swapping renderers must not cost the user their caret. It does not today:
     * a forced `webglcontextlost` was driven against a live session and focus
     * stayed on the xterm textarea, because disposing the addon touches the
     * canvases and not the helper textarea. **This re-assertion therefore fixes
     * nothing that is currently broken** — it makes an accidental property an
     * intentional one, so a future renderer change cannot quietly take the
     * keyboard away mid-command.
     *
     * Conditional on having held focus, and that condition is the whole point.
     * Nine of ten terminals in this app are hidden kept-alive instances; one
     * that grabbed the caret because its GPU context went away would yank the
     * user out of whatever they were typing into.
     *
     * Its reach is narrow, and worth stating rather than leaving to be
     * discovered: focusing an already-focused element is a no-op, so this only
     * ever *does* anything if a future `dispose()` blurs the textarea
     * synchronously, inside this callback. A change that blurred it a
     * microtask or a frame later would slip past — catching that would mean
     * re-asserting on a timer, which is a worse trade than it sounds, because
     * a deferred `focus()` can land after the user has deliberately clicked
     * somewhere else.
     */
    const lost = addon.onContextLoss(() => {
      const hadFocus = document.activeElement === terminal.textarea;
      addon?.dispose();
      addon = null;
      if (hadFocus) terminal.focus();
    });

    try {
      terminal.loadAddon(addon);
    } catch {
      // No WebGL2 at all — a software-rendering VM, a blocklisted driver. The
      // DOM renderer is still there and still correct, just slower.
      addon.dispose();
      addon = null;
    }

    return () => {
      lost.dispose();
      addon?.dispose();
    };
  }, [instance, readOnly, visible]);

  /**
   * Clicking a live terminal focuses it.
   *
   * The stage focuses the message row on the same click (story 043) and steps
   * aside when the terminal is interactive — but the *guard* is duplicated here
   * rather than assumed, because it is the same bug in both places: moving
   * focus collapses the document selection, so focusing on any click would
   * delete the highlight a click-drag-release had only just made, before it
   * could be copied.
   */
  const focusTerminal = () => {
    if (readOnly || !instance) return;
    if ((window.getSelection()?.toString() ?? '') !== '') return;
    instance.terminal.focus();
  };

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events
    <div
      className="h-full w-full overflow-hidden bg-term-bg px-[18px] py-4"
      // Kept alive, not unmounted: hiding preserves scrollback and selection.
      style={visible ? undefined : { display: 'none' }}
      onClick={focusTerminal}
      data-testid="terminal-surface"
      data-terminal-id={id}
    >
      <div ref={setContainer} className="h-full w-full" />
    </div>
  );
}
