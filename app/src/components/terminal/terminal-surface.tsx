import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef, useState } from 'react';

import { buildXtermTheme, type TerminalTheme } from '@lib/terminal/ansi';
import { shouldAutoScroll } from '@lib/terminal/auto-scroll';
import type { TerminalTransport } from '@lib/terminal/terminal-transport';

import '@xterm/xterm/css/xterm.css';

/** xterm's line-height is a multiple of the font size, not a CSS length. */
const LINE_HEIGHT = 1.4;

/** Deep enough that no fixture transcript can reach the top of the buffer. */
const SCROLLBACK = 5000;

const DEFAULT_FONT_SIZE = 12.5;

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
  fontSize?: number;
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
  fontSize = DEFAULT_FONT_SIZE,
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
      fontFamily: "ui-monospace, Menlo, 'SF Mono', monospace",
      fontSize,
      lineHeight: LINE_HEIGHT,
      scrollback: SCROLLBACK,
      theme: buildXtermTheme(theme),
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    // Makes a URL pasted into a transcript clickable, which is the difference
    // between "looks like a terminal" and "behaves like one".
    terminal.loadAddon(new WebLinksAddon());
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
     * `theme` and `transport` are deliberately absent: both are handled by
     * their own effects below, so a theme toggle or a transport swap never
     * destroys scrollback. `fontSize` and `readOnly` are structural — xterm
     * cannot change `disableStdin` after construction — so they do rebuild.
     */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [container, fontSize, readOnly]);

  /** Re-theme in place. Assigning `options.theme` preserves buffer content. */
  useEffect(() => {
    if (!instance) return;
    instance.terminal.options.theme = buildXtermTheme(theme);
  }, [instance, theme]);

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

  return (
    <div
      className="h-full w-full overflow-hidden bg-term-bg px-[18px] py-4"
      // Kept alive, not unmounted: hiding preserves scrollback and selection.
      style={visible ? undefined : { display: 'none' }}
      data-testid="terminal-surface"
      data-terminal-id={id}
    >
      <div ref={setContainer} className="h-full w-full" />
    </div>
  );
}
