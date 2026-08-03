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
  MockTerminal,
  resetTerminalInstances,
  terminalInstances,
} from '../../../__mocks__/@xterm/xterm';

import { TerminalSurface } from '@components/terminal/terminal-surface';
import type {
  TerminalDataHandler,
  TerminalTransport,
} from '@lib/terminal/terminal-transport';

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
});
