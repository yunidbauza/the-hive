import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MockFitAddon,
  fitAddonInstances,
  resetFitAddonInstances,
} from '../../../__mocks__/@xterm/addon-fit';
import {
  MockTerminal,
  resetTerminalInstances,
  terminalInstances,
} from '../../../__mocks__/@xterm/xterm';

import { TerminalSurface } from '@components/terminal/terminal-surface';
import { XTERM_THEME } from '@lib/terminal/ansi';

vi.mock('@xterm/xterm');
vi.mock('@xterm/addon-fit');

/**
 * Reference pattern for component tests (story 013).
 *
 * xterm is never instantiated for real: happy-dom cannot provide the canvas and
 * measurement path it needs. Everything here asserts *plumbing* — that an
 * instance is constructed, attached, refitted, and torn down. Anything that
 * needs a rendered terminal (colours, selection, scrollback) belongs in
 * Playwright (story 070).
 */
describe('TerminalSurface', () => {
  beforeEach(() => {
    resetTerminalInstances();
    resetFitAddonInstances();
  });

  it('constructs exactly one terminal and attaches it to its container', () => {
    const { container } = render(<TerminalSurface />);

    expect(terminalInstances).toHaveLength(1);
    const [terminal] = terminalInstances as MockTerminal[];
    expect(terminal.opened).toBe(container.firstChild);
  });

  it('applies the shared xterm theme rather than inheriting page colours', () => {
    render(<TerminalSurface />);

    const [terminal] = terminalInstances as MockTerminal[];
    // Sourced from lib/terminal/ansi.ts, not hand-written here: xterm paints to
    // a canvas that CSS custom properties cannot reach.
    expect(terminal.options.theme).toBe(XTERM_THEME);
    expect(terminal.options.theme).toMatchObject({ background: '#0b1023' });
  });

  it('loads the fit addon and fits once on mount', () => {
    render(<TerminalSurface />);

    const [terminal] = terminalInstances as MockTerminal[];
    const [fitAddon] = fitAddonInstances as MockFitAddon[];

    expect(terminal.loadAddon).toHaveBeenCalledWith(fitAddon);
    expect(fitAddon.fit).toHaveBeenCalledTimes(1);
  });

  it('observes its container so the terminal refits when the pane resizes', () => {
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = observe;
        unobserve = vi.fn();
        disconnect = disconnect;
      },
    );

    const { container, unmount } = render(<TerminalSurface />);
    expect(observe).toHaveBeenCalledWith(container.firstChild);

    unmount();
    expect(disconnect).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });

  it('disposes the terminal on unmount, leaving nothing to leak', () => {
    const { unmount } = render(<TerminalSurface />);
    const [terminal] = terminalInstances as MockTerminal[];

    expect(terminal.disposed).toBe(false);
    unmount();
    expect(terminal.disposed).toBe(true);
  });
});
