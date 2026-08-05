import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MockFitAddon,
  fitAddonInstances,
  resetFitAddonInstances,
} from '../../../__mocks__/@xterm/addon-fit';
import {
  resetWebLinksAddonInstances,
  webLinksAddonInstances,
} from '../../../__mocks__/@xterm/addon-web-links';
import {
  resetWebglAddonInstances,
  webglAddonInstances,
} from '../../../__mocks__/@xterm/addon-webgl';
import {
  MockTerminal,
  resetTerminalInstances,
  terminalInstances,
} from '../../../__mocks__/@xterm/xterm';

import { TerminalSurface } from '@components/terminal/terminal-surface';
import type {
  TerminalDataHandler,
  TerminalTransport,
} from '@lib/terminal/terminal-transport';

import { TERMINAL_CHORD_EVENT } from '@lib/terminal/keymap';

vi.mock('@xterm/addon-webgl');
vi.mock('@xterm/xterm');
vi.mock('@xterm/addon-fit');
vi.mock('@xterm/addon-web-links');

/**
 * Reference pattern for component tests (story 013).
 *
 * xterm is never instantiated for real: happy-dom cannot provide the DOM
 * measurement path it needs. Everything here asserts *plumbing* — construction,
 * subscription, refit, teardown. Anything that needs a rendered terminal
 * (colours on screen, selection, real scrollback) belongs in Playwright.
 */

/** A transport that records what it was asked to do and can push output. */
function fakeTransport() {
  const emit: TerminalDataHandler[] = [];
  const unsubscribe = vi.fn();
  const transport: TerminalTransport = {
    write: vi.fn(),
    resize: vi.fn(),
    onData: vi.fn((cb: TerminalDataHandler) => {
      emit.push(cb);
      return unsubscribe;
    }),
  };
  return {
    transport,
    unsubscribe,
    /** Simulate the backend producing output. */
    push: (chunk: string, parsed?: () => void) =>
      emit.forEach((cb) => cb(chunk, parsed)),
  };
}

const terminal = () => terminalInstances[0] as MockTerminal;

describe('TerminalSurface', () => {
  beforeEach(() => {
    resetTerminalInstances();
    resetFitAddonInstances();
    resetWebLinksAddonInstances();
    resetWebglAddonInstances();
  });

  it('constructs one terminal and attaches it to its container', () => {
    const { transport } = fakeTransport();
    const { container } = render(
      <TerminalSurface transport={transport} theme="dark" />,
    );

    expect(terminalInstances).toHaveLength(1);
    // The padded wrapper is the outer node; xterm mounts into the inner box so
    // the padding is not measured as terminal area.
    expect(terminal().opened).toBe(container.firstChild?.firstChild);
  });

  it('configures xterm to the story-042 spec', () => {
    const { transport } = fakeTransport();
    render(<TerminalSurface transport={transport} theme="dark" />);

    expect(terminal().options).toMatchObject({
      convertEol: true,
      fontSize: 12.5,
      lineHeight: 1.4,
      scrollback: 5000,
    });
  });

  it('honours an explicit font size', () => {
    const { transport } = fakeTransport();
    render(<TerminalSurface transport={transport} theme="dark" fontSize={16} />);

    expect(terminal().options.fontSize).toBe(16);
  });

  it('honours an explicit font family and scrollback', () => {
    const { transport } = fakeTransport();
    render(
      <TerminalSurface
        transport={transport}
        theme="dark"
        fontFamily="Menlo, monospace"
        scrollback={1000}
      />,
    );

    expect(terminal().options).toMatchObject({
      fontFamily: 'Menlo, monospace',
      scrollback: 1000,
    });
  });

  /**
   * The behaviour story 105 exists to protect.
   *
   * Story 042 listed `fontSize` in the mount effect's deps and called it
   * structural, which was true only while nothing set it. Once appearance
   * became a live setting, a rebuild on every change would dispose the terminal
   * — and disposing the terminal throws away the scrollback of every
   * kept-alive instance. Changing a font size must not clear thirteen
   * transcripts.
   */
  describe('appearance changes in place', () => {
    it('applies a new font, size and scrollback without rebuilding', () => {
      const { transport } = fakeTransport();
      const { rerender } = render(
        <TerminalSurface transport={transport} theme="dark" />,
      );
      const before = terminal();

      rerender(
        <TerminalSurface
          transport={transport}
          theme="dark"
          fontFamily="Monaco, monospace"
          fontSize={16}
          scrollback={10_000}
        />,
      );

      expect(terminalInstances).toHaveLength(1);
      expect(before.disposed).toBe(false);
      expect(terminal().options).toMatchObject({
        fontFamily: 'Monaco, monospace',
        fontSize: 16,
        scrollback: 10_000,
      });
    });

    it('refits afterwards, because the measured cell changed', () => {
      const { transport } = fakeTransport();
      const { rerender } = render(
        <TerminalSurface transport={transport} theme="dark" />,
      );
      const [fitAddon] = fitAddonInstances as MockFitAddon[];

      expect(fitAddon.fit).toHaveBeenCalledTimes(1); // mount only

      rerender(<TerminalSurface transport={transport} theme="dark" fontSize={16} />);

      // Without this the terminal keeps the old cols/rows, reports stale
      // dimensions to its transport, and renders into a box that no longer fits.
      expect(fitAddon.fit).toHaveBeenCalledTimes(2);
    });

    it('applies the options to a hidden surface but does not fit it', () => {
      const { transport } = fakeTransport();
      const { rerender } = render(
        <TerminalSurface transport={transport} theme="dark" visible={false} />,
      );
      const [fitAddon] = fitAddonInstances as MockFitAddon[];

      // Hidden surfaces are never fitted at all — the visibility effect owns
      // every fit, so a zero-height box is never measured.
      expect(fitAddon.fit).toHaveBeenCalledTimes(0);

      rerender(
        <TerminalSurface
          transport={transport}
          theme="dark"
          fontSize={16}
          visible={false}
        />,
      );

      /**
       * Appearance is forwarded to *every* kept-alive surface, not just the
       * active one, so this effect runs on hidden terminals too. A hidden
       * surface is `display: none`, whose `h-full` resolves to 0px rather than
       * `auto` — the fit addon's isNaN guard does not catch that, and it would
       * resize a background terminal to the 2×1 floor and reflow its buffer at
       * two columns.
       */
      expect(terminal().options.fontSize).toBe(16);
      expect(fitAddon.fit).toHaveBeenCalledTimes(0);

      // Revealing it fits once, with the new font already applied.
      rerender(
        <TerminalSurface transport={transport} theme="dark" fontSize={16} visible />,
      );
      expect(fitAddon.fit).toHaveBeenCalledTimes(1);
    });

    it('does not refit when the appearance props are unchanged', () => {
      const { transport } = fakeTransport();
      const { rerender } = render(
        <TerminalSurface transport={transport} theme="dark" fontSize={16} />,
      );
      const [fitAddon] = fitAddonInstances as MockFitAddon[];

      rerender(<TerminalSurface transport={transport} theme="light" fontSize={16} />);

      // A theme change has its own effect and costs no geometry.
      expect(fitAddon.fit).toHaveBeenCalledTimes(1);
    });
  });

  it('loads the fit and web-links addons and fits once on mount', () => {
    const { transport } = fakeTransport();
    render(<TerminalSurface transport={transport} theme="dark" />);

    const [fitAddon] = fitAddonInstances as MockFitAddon[];
    expect(terminal().loadAddon).toHaveBeenCalledWith(fitAddon);
    // Without web-links a URL in a transcript is inert text.
    expect(webLinksAddonInstances).toHaveLength(1);
    expect(terminal().loadAddon).toHaveBeenCalledWith(webLinksAddonInstances[0]);
    expect(fitAddon.fit).toHaveBeenCalledTimes(1);
  });

  describe('read-only', () => {
    it('disables stdin and the cursor when read-only', () => {
      const { transport } = fakeTransport();
      render(<TerminalSurface transport={transport} theme="dark" readOnly />);

      expect(terminal().options).toMatchObject({
        disableStdin: true,
        cursorBlink: false,
      });
    });

    it('does not forward keystrokes while read-only', () => {
      const { transport } = fakeTransport();
      render(<TerminalSurface transport={transport} theme="dark" readOnly />);

      terminal().emitData('ls\r');

      expect(transport.write).not.toHaveBeenCalled();
    });

    it('forwards keystrokes to the transport when writable', () => {
      const { transport } = fakeTransport();
      render(<TerminalSurface transport={transport} theme="dark" />);

      terminal().emitData('ls\r');

      // The only path from the terminal back to a backend.
      expect(transport.write).toHaveBeenCalledWith('ls\r');
    });
  });

  describe('transport wiring', () => {
    it('writes backend output into the terminal', () => {
      const { transport, push } = fakeTransport();
      render(<TerminalSurface transport={transport} theme="dark" />);

      push('hello\n');

      expect(terminal().written).toContain('hello\n');
    });

    it('unsubscribes on unmount, leaving nothing to leak', () => {
      const { transport, unsubscribe } = fakeTransport();
      const { unmount } = render(
        <TerminalSurface transport={transport} theme="dark" />,
      );

      expect(unsubscribe).not.toHaveBeenCalled();
      unmount();
      expect(unsubscribe).toHaveBeenCalledTimes(1);
    });

    it('reports a chunk parsed once xterm has taken it (story 094)', () => {
      /**
       * The renderer half of story 093's flow control, and the one fact only
       * this component has: `terminal.write`'s callback fires when the chunk is
       * in the buffer. Reporting from anywhere else measures the IPC channel
       * instead of the terminal, and not reporting at all lets the unacked
       * window fill and pause the pty permanently.
       */
      const { transport, push } = fakeTransport();
      const parsed = vi.fn();
      render(<TerminalSurface transport={transport} theme="dark" />);

      push('output', parsed);

      expect(parsed).toHaveBeenCalledTimes(1);
    });

    it('survives a transport that offers no ack', () => {
      // `StaticTransport` has no backpressure and passes nothing. The optional
      // argument is what keeps every existing caller working unchanged.
      const { transport, push } = fakeTransport();
      render(<TerminalSurface transport={transport} theme="dark" />);

      expect(() => push('output')).not.toThrow();
      expect(terminal().written).toContain('output');
    });

    it('resubscribes when handed a different transport', () => {
      const first = fakeTransport();
      const second = fakeTransport();
      const { rerender } = render(
        <TerminalSurface transport={first.transport} theme="dark" />,
      );

      rerender(<TerminalSurface transport={second.transport} theme="dark" />);

      expect(first.unsubscribe).toHaveBeenCalledTimes(1);
      expect(second.transport.onData).toHaveBeenCalledTimes(1);
      // Swapping the data source must not destroy the terminal itself.
      expect(terminalInstances).toHaveLength(1);
    });
  });

  describe('the bottom-stick rule', () => {
    it('follows new output when the viewport is at the bottom', () => {
      const { transport, push } = fakeTransport();
      render(<TerminalSurface transport={transport} theme="dark" />);
      terminal().buffer.active.viewportY = 40;
      terminal().buffer.active.baseY = 40;
      // The initial fit already stuck to the bottom; count only this write.
      terminal().scrollToBottom.mockClear();

      push('more\n');

      expect(terminal().scrollToBottom).toHaveBeenCalledTimes(1);
    });

    it('leaves the viewport alone while the user reads scrollback', () => {
      const { transport, push } = fakeTransport();
      render(<TerminalSurface transport={transport} theme="dark" />);
      terminal().buffer.active.viewportY = 5;
      terminal().buffer.active.baseY = 40;
      terminal().scrollToBottom.mockClear();

      push('more\n');

      // The output still arrives — it just does not steal the viewport.
      expect(terminal().written).toContain('more\n');
      expect(terminal().scrollToBottom).not.toHaveBeenCalled();
    });
  });

  describe('theming', () => {
    it('applies the dark palette rather than inheriting page colours', () => {
      const { transport } = fakeTransport();
      render(<TerminalSurface transport={transport} theme="dark" />);

      expect(terminal().options.theme).toMatchObject({
        background: '#0b1023',
        selectionBackground: '#222c55',
      });
    });

    it('lifts selection and cursor in light mode', () => {
      const { transport } = fakeTransport();
      render(<TerminalSurface transport={transport} theme="light" />);

      // The background deliberately does not change (story 011): the terminal
      // stays dark. Only the chrome the user manipulates is brightened.
      expect(terminal().options.theme).toMatchObject({
        background: '#0b1023',
        selectionBackground: '#33407a',
        cursor: '#7ee2b8',
      });
    });

    it('re-themes in place without losing the terminal', () => {
      const { transport } = fakeTransport();
      const { rerender } = render(
        <TerminalSurface transport={transport} theme="dark" />,
      );

      rerender(<TerminalSurface transport={transport} theme="light" />);

      // One instance throughout: rebuilding it would drop every line of
      // scrollback on a theme toggle.
      expect(terminalInstances).toHaveLength(1);
      expect(terminal().disposed).toBe(false);
      expect(terminal().options.theme).toMatchObject({
        selectionBackground: '#33407a',
      });
    });
  });

  describe('geometry', () => {
    it('refits and reports the new size when its container resizes', () => {
      let trigger = () => {};
      vi.stubGlobal(
        'ResizeObserver',
        class {
          constructor(cb: () => void) {
            trigger = cb;
          }
          observe = vi.fn();
          unobserve = vi.fn();
          disconnect = vi.fn();
        },
      );

      const { transport } = fakeTransport();
      render(<TerminalSurface transport={transport} theme="dark" />);
      const [fitAddon] = fitAddonInstances as MockFitAddon[];

      trigger();

      expect(fitAddon.fit).toHaveBeenCalledTimes(2); // mount + resize
      expect(transport.resize).toHaveBeenCalledWith(80, 24);

      vi.unstubAllGlobals();
    });

    it('stays at the bottom when the container shrinks', () => {
      let trigger = () => {};
      vi.stubGlobal(
        'ResizeObserver',
        class {
          constructor(cb: () => void) {
            trigger = cb;
          }
          observe = vi.fn();
          unobserve = vi.fn();
          disconnect = vi.fn();
        },
      );

      const { transport } = fakeTransport();
      render(<TerminalSurface transport={transport} theme="dark" />);
      terminal().buffer.active.viewportY = 40;
      terminal().buffer.active.baseY = 40;
      terminal().scrollToBottom.mockClear();

      trigger();

      /**
       * Shrinking the box drops rows off the bottom of the viewport, so a
       * terminal parked at the end of its transcript would silently end up
       * showing the middle of it — the last line gone without anyone touching
       * the wheel. This is what the session meta bar appearing above a terminal
       * does to it.
       */
      expect(terminal().scrollToBottom).toHaveBeenCalled();

      vi.unstubAllGlobals();
    });

    it('does not jump to the bottom on resize while reading scrollback', () => {
      let trigger = () => {};
      vi.stubGlobal(
        'ResizeObserver',
        class {
          constructor(cb: () => void) {
            trigger = cb;
          }
          observe = vi.fn();
          unobserve = vi.fn();
          disconnect = vi.fn();
        },
      );

      const { transport } = fakeTransport();
      render(<TerminalSurface transport={transport} theme="dark" />);
      terminal().buffer.active.viewportY = 5;
      terminal().buffer.active.baseY = 40;
      terminal().scrollToBottom.mockClear();

      trigger();

      expect(terminal().scrollToBottom).not.toHaveBeenCalled();

      vi.unstubAllGlobals();
    });

    it('reports resizes to the current transport, not the one it mounted with', () => {
      let trigger = () => {};
      vi.stubGlobal(
        'ResizeObserver',
        class {
          constructor(cb: () => void) {
            trigger = cb;
          }
          observe = vi.fn();
          unobserve = vi.fn();
          disconnect = vi.fn();
        },
      );

      const first = fakeTransport();
      const second = fakeTransport();
      const { rerender } = render(
        <TerminalSurface transport={first.transport} theme="dark" />,
      );
      rerender(<TerminalSurface transport={second.transport} theme="dark" />);

      trigger();

      /**
       * The observer is built once, in the mount effect, and would otherwise
       * pin the transport it captured there. Both implementations return void,
       * so a stale one fails silently — which is exactly why it is worth a test.
       */
      expect(second.transport.resize).toHaveBeenCalledWith(80, 24);
      expect(first.transport.resize).not.toHaveBeenCalled();

      vi.unstubAllGlobals();
    });

    it('refits when it becomes visible again', () => {
      const { transport } = fakeTransport();
      const { rerender } = render(
        <TerminalSurface transport={transport} theme="dark" visible={false} />,
      );
      const [fitAddon] = fitAddonInstances as MockFitAddon[];
      const fitsWhileHidden = fitAddon.fit.mock.calls.length;

      rerender(
        <TerminalSurface transport={transport} theme="dark" visible={true} />,
      );

      // A terminal fitted while hidden measured a zero-height box; without this
      // refit it would render at the wrong size for the rest of its life.
      expect(fitAddon.fit.mock.calls.length).toBeGreaterThan(fitsWhileHidden);
    });

    it('hides rather than unmounts when not visible', () => {
      const { transport } = fakeTransport();
      const { container } = render(
        <TerminalSurface transport={transport} theme="dark" visible={false} />,
      );

      // Kept alive: this is what preserves scrollback across tab switches.
      expect(container.firstChild).toHaveStyle({ display: 'none' });
      expect(terminalInstances).toHaveLength(1);
    });

    it('disconnects its observer and disposes the terminal on unmount', () => {
      const { transport } = fakeTransport();
      const { unmount } = render(
        <TerminalSurface transport={transport} theme="dark" />,
      );

      expect(terminal().disposed).toBe(false);
      unmount();
      expect(terminal().disposed).toBe(true);
    });
  });

  describe('the keyboard, when interactive (story 095)', () => {
    /** Drive the installed handler with a synthetic event. */
    function press(init: Partial<KeyboardEventInit> & { key: string }): boolean {
      const handler = terminal().keyEventHandler;
      if (!handler) throw new Error('no custom key handler was installed');
      return handler(new KeyboardEvent('keydown', init));
    }

    function renderInteractive() {
      const { transport } = fakeTransport();
      const result = render(
        <TerminalSurface transport={transport} theme="dark" readOnly={false} />,
      );
      return { ...result, transport };
    }

    it('installs no key handler on a read-only surface', () => {
      /**
       * The orchestrator-console regression. A read-only surface sends nothing
       * to a pty, so there is no conflict to arbitrate — and a handler there
       * would be the first step toward the console quietly becoming a shell.
       */
      const { transport } = fakeTransport();
      render(<TerminalSurface transport={transport} theme="dark" readOnly />);

      expect(terminal().keyEventHandler).toBeNull();
    });

    it('ignores keypress and keyup, deciding only on keydown', () => {
      // Deciding on all three would run the copy twice and fight the pty for
      // the same chord.
      renderInteractive();
      const handler = terminal().keyEventHandler!;

      expect(handler(new KeyboardEvent('keyup', { key: 'c', ctrlKey: true }))).toBe(
        true,
      );
    });

    it('lets ordinary keys through to the pty', () => {
      renderInteractive();

      expect(press({ key: 'a' })).toBe(true);
      expect(press({ key: 'ArrowLeft' })).toBe(true);
      expect(press({ key: 'Tab' })).toBe(true);
    });

    /**
     * The bare-`←` rule needs two rows of the buffer, and what is asserted here
     * is only that the surface reads and forwards them. *Whether* those rows
     * mean "Claude is waiting" is `isEmptyClaudePrompt`'s question and is
     * tested against real captures in `tests/lib/terminal/keymap.test.ts` — the
     * seam is exactly that split, and duplicating the rule here would let the
     * two drift.
     */
    describe('the rows it reads for the bare ← decision', () => {
      /** Stage a cursor row and the row below it, as xterm would report them. */
      function stageRows(rows: string[], cursorX: number) {
        const mock = terminal();
        mock.bufferLines = rows;
        mock.buffer.active.baseY = 0;
        mock.buffer.active.cursorY = 0;
        mock.buffer.active.cursorX = cursorX;
      }

      it('takes bare ← when the buffer shows an empty Claude prompt', () => {
        renderInteractive();
        stageRows(['❯ ', '─'.repeat(96)], 2);

        // Handled here, not sent on: the pty must not also see the arrow.
        expect(press({ key: 'ArrowLeft' })).toBe(false);
      });

      it('gives the key back to the pty once something is typed', () => {
        renderInteractive();
        stageRows(['❯ hello', '─'.repeat(96)], 7);

        expect(press({ key: 'ArrowLeft' })).toBe(true);
      });

      it('reads the whole row, not just the part before the caret', () => {
        /**
         * The caret sent back to the start of a half-typed message with
         * `Ctrl-A`. Reading only the left-hand side would see an empty prompt
         * and navigate away mid-sentence; reading the row sees the message.
         * Same staged row as above, caret at column 2 instead of 7.
         */
        renderInteractive();
        stageRows(['❯ hello', '─'.repeat(96)], 2);

        expect(press({ key: 'ArrowLeft' })).toBe(true);
      });

      it('falls back to chord-only when the row cannot be read', () => {
        // No rows staged at all — `getLine` reports nothing, as it does past
        // the end of a real buffer. Absent information is never a match.
        renderInteractive();

        expect(press({ key: 'ArrowLeft' })).toBe(true);
      });

      it('reports the row below the caret, not the caret’s own', () => {
        // A rule *on* the cursor row is not the frame's bottom edge. If the
        // surface read the wrong row this would swallow the key.
        renderInteractive();
        stageRows(['─'.repeat(96), 'not a rule'], 0);

        expect(press({ key: 'ArrowLeft' })).toBe(true);
      });
    });

    it('announces the app chord rather than letting the key bubble', () => {
      /**
       * The terminal reports that a chord happened *here* and nothing more — it
       * does not know the app will navigate. Firing a specific event instead of
       * letting the keystroke bubble is what stops the app from listening for
       * the raw combination on `window`, where `Cmd+←` is "move caret to start
       * of line" in every text field.
       */
      const seen: string[] = [];
      const onChord = (event: Event) => {
        seen.push((event as CustomEvent<{ chord: string }>).detail.chord);
      };
      window.addEventListener(TERMINAL_CHORD_EVENT, onChord);

      try {
        renderInteractive();
        const mac = /mac/i.test(navigator.platform || navigator.userAgent);

        const handled = press(
          mac
            ? { key: 'ArrowLeft', metaKey: true }
            : { key: 'ArrowLeft', ctrlKey: true, shiftKey: true },
        );

        expect(handled).toBe(false);
        expect(seen).toEqual(['back']);
      } finally {
        window.removeEventListener(TERMINAL_CHORD_EVENT, onChord);
      }
    });

    it('announces nothing for an ordinary key', () => {
      const seen: string[] = [];
      const onChord = () => seen.push('fired');
      window.addEventListener(TERMINAL_CHORD_EVENT, onChord);

      try {
        renderInteractive();
        press({ key: 'ArrowLeft' });
        expect(seen).toEqual([]);
      } finally {
        window.removeEventListener(TERMINAL_CHORD_EVENT, onChord);
      }
    });

    it('copies the selection and clears it, without telling the pty', async () => {
      const writeText = vi.fn(() => Promise.resolve());
      vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });

      renderInteractive();
      terminal().selection = 'copied text';
      const mac = /mac/i.test(navigator.platform || navigator.userAgent);

      const handled = press(
        mac ? { key: 'c', metaKey: true } : { key: 'C', ctrlKey: true, shiftKey: true },
      );

      expect(handled).toBe(false);
      expect(writeText).toHaveBeenCalledWith('copied text');
      /**
       * Cleared, so the next press means something different. On Linux bare
       * Ctrl+C copies only *because* there is a selection — leaving it would
       * mean a user trying to stop a runaway process copied it again instead.
       */
      expect(terminal().hasSelection()).toBe(false);

      vi.unstubAllGlobals();
    });

    it('pastes through the terminal so bracketed paste is honoured', async () => {
      const readText = vi.fn(() => Promise.resolve('pasted'));
      vi.stubGlobal('navigator', { ...navigator, clipboard: { readText } });

      renderInteractive();
      const mac = /mac/i.test(navigator.platform || navigator.userAgent);

      expect(
        press(
          mac ? { key: 'v', metaKey: true } : { key: 'V', ctrlKey: true, shiftKey: true },
        ),
      ).toBe(false);

      await vi.waitFor(() => expect(terminal().paste).toHaveBeenCalledWith('pasted'));

      vi.unstubAllGlobals();
    });
  });

  describe('the WebGL renderer (story 095)', () => {
    it('attaches to a visible interactive terminal', () => {
      const { transport } = fakeTransport();
      render(<TerminalSurface transport={transport} theme="dark" readOnly={false} />);

      expect(webglAddonInstances).toHaveLength(1);
    });

    it('leaves read-only surfaces on the DOM renderer', () => {
      // They render a recording, once. The DOM renderer was always right for
      // that workload.
      const { transport } = fakeTransport();
      render(<TerminalSurface transport={transport} theme="dark" readOnly />);

      expect(webglAddonInstances).toHaveLength(0);
    });

    it('does not attach while hidden', () => {
      /**
       * The context cap is the whole reason. Browsers allow ~16 WebGL contexts
       * process-wide and this app can hold a dozen live terminals; one per
       * instance would exhaust the pool and start silently killing the oldest.
       */
      const { transport } = fakeTransport();
      render(
        <TerminalSurface
          transport={transport}
          theme="dark"
          readOnly={false}
          visible={false}
        />,
      );

      expect(webglAddonInstances).toHaveLength(0);
    });

    it('gives up its context when hidden and takes one again on reveal', () => {
      const { transport } = fakeTransport();
      const { rerender } = render(
        <TerminalSurface transport={transport} theme="dark" readOnly={false} />,
      );

      expect(webglAddonInstances).toHaveLength(1);

      rerender(
        <TerminalSurface
          transport={transport}
          theme="dark"
          readOnly={false}
          visible={false}
        />,
      );
      expect(webglAddonInstances[0]!.dispose).toHaveBeenCalled();

      rerender(
        <TerminalSurface transport={transport} theme="dark" readOnly={false} />,
      );
      // A fresh context, and the buffer is untouched — the terminal itself was
      // never rebuilt.
      expect(webglAddonInstances).toHaveLength(2);
      expect(terminalInstances).toHaveLength(1);
    });

    it('falls back to DOM when the context is lost', () => {
      /**
       * Without this the terminal simply stops painting, which looks exactly
       * like a frozen session and sends the user hunting for a hung process
       * that is running perfectly.
       */
      const { transport } = fakeTransport();
      render(<TerminalSurface transport={transport} theme="dark" readOnly={false} />);

      const addon = webglAddonInstances[0]!;
      expect(addon.dispose).not.toHaveBeenCalled();

      addon.emitContextLoss();

      expect(addon.dispose).toHaveBeenCalledTimes(1);
      // The terminal survives — only the renderer changed.
      expect(terminal().disposed).toBe(false);
    });

    it('drops its context-loss listener on unmount', () => {
      const { transport } = fakeTransport();
      const { unmount } = render(
        <TerminalSurface transport={transport} theme="dark" readOnly={false} />,
      );

      const addon = webglAddonInstances[0]!;
      expect(addon.contextLossListenerCount).toBe(1);

      unmount();
      expect(addon.contextLossListenerCount).toBe(0);
    });
  });
});
