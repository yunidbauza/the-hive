import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef, useState } from 'react';

import { isMacPlatform } from '@lib/platform';
import { buildXtermTheme, type TerminalTheme } from '@lib/terminal/ansi';
import { shouldAutoScroll } from '@lib/terminal/auto-scroll';
import {
  TERMINAL_CHORD_EVENT,
  decideTerminalKey,
  type CursorContext,
  type TerminalChordDetail,
} from '@lib/terminal/keymap';
import type { TerminalTransport } from '@lib/terminal/terminal-transport';

import '@xterm/xterm/css/xterm.css';

/** xterm's line-height is a multiple of the font size, not a CSS length. */
const LINE_HEIGHT = 1.4;

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
  theme: TerminalTheme;
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
 * The two rows the bare-`←` decision needs, read straight out of the buffer.
 *
 * This is the closest this component comes to knowing what is *running* inside
 * it, and the line it does not cross is worth being explicit about: it reports
 * **text and a caret position**, exactly what a terminal has. Whether those
 * rows mean "Claude is waiting for a message" is decided in
 * `lib/terminal/keymap.ts`, which is where a rule about a program belongs and
 * where it can be tested without a DOM. The seam is what makes the terminal
 * swappable, and reading its own buffer does not breach it — importing a store
 * to ask which session this is would.
 *
 * Returns `null` when the row cannot be read, and the decision then falls back
 * to chord-only. Absent information is never treated as a match.
 */
function readCursorContext(terminal: Terminal): CursorContext | null {
  const buffer = terminal.buffer.active;
  const row = buffer.baseY + buffer.cursorY;
  const line = buffer.getLine(row);
  if (!line) return null;

  const below = buffer.getLine(row + 1);
  return {
    /**
     * The whole row, not the part before the caret. A caret sent back to the
     * start of a half-typed message with `Ctrl-A` has nothing to its left while
     * the message is still very much there — see {@link isEmptyClaudePrompt}.
     * Right-trimmed, because a terminal row is padded to the full width.
     */
    line: line.translateToString(true),
    below: below?.translateToString(true) ?? '',
  };
}

/**
 * Copy the selection, then drop it.
 *
 * Clearing matters most on Linux and Windows, where bare `Ctrl+C` copies only
 * *because* there is a selection: leaving it in place would mean the second
 * press copied again instead of interrupting, and a user trying to stop a
 * runaway process would press it repeatedly to no effect.
 *
 * Failures are swallowed on purpose. `writeText` rejects when the document is
 * not focused or permission is denied, and neither is worth an unhandled
 * rejection in the console of an app whose terminal is otherwise fine.
 */
function copySelection(terminal: Terminal): void {
  const selection = terminal.getSelection();
  if (selection === '') return;
  terminal.clearSelection();
  void navigator.clipboard?.writeText(selection).catch(() => {});
}

/** Paste as if typed — through the terminal, so bracketed paste is honoured. */
function pasteFromClipboard(terminal: Terminal): void {
  void navigator.clipboard
    ?.readText()
    .then((text) => {
      if (text !== '') terminal.paste(text);
    })
    .catch(() => {});
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
  theme,
  fontFamily = DEFAULT_FONT_FAMILY,
  fontSize = DEFAULT_FONT_SIZE,
  scrollback = DEFAULT_SCROLLBACK,
  readOnly = false,
  visible = true,
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
      theme: buildXtermTheme(theme),
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

        switch (decideTerminalKey(event, {
          isMac,
          hasSelection: terminal.hasSelection(),
          /**
           * Read per keystroke rather than cached. The buffer moves under us
           * constantly — every chunk of agent output rewrites these rows — and
           * a cached answer would decide the *previous* screen's question.
           */
          cursor: readCursorContext(terminal),
        })) {
          case 'copy':
            copySelection(terminal);
            return false;
          case 'paste':
            pasteFromClipboard(terminal);
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
          default:
            return true;
        }
      });
    }

    terminal.open(container);
    // The initial fit is deliberately not done here — the visibility effect
    // below owns every fit, so a surface that mounts hidden is not measured
    // against a zero-height box and a visible one is not fitted twice.

    const resizeObserver = new ResizeObserver(() => {
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
     * `theme`, `transport`, and the three appearance options are absent because
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

  /** Re-theme in place. Assigning `options.theme` preserves buffer content. */
  useEffect(() => {
    if (!instance) return;
    instance.terminal.options.theme = buildXtermTheme(theme);
  }, [instance, theme]);

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
   * the active one, so this effect runs on hidden terminals too — and a hidden
   * surface is `display: none`, whose `h-full` resolves to 0px rather than
   * `auto`. The fit addon's `isNaN` guard does not catch that, so it would
   * resize a background terminal to the 2×1 floor and reflow its buffer at two
   * columns. The visibility effect already re-fits on reveal, which is where
   * the geometry actually exists to measure.
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
   */
  useEffect(() => {
    if (!instance || !visible) return;
    fitPreservingBottom(instance);
  }, [instance, visible]);

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
     */
    const lost = addon.onContextLoss(() => {
      addon?.dispose();
      addon = null;
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
