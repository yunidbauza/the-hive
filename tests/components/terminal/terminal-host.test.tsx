import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetFitAddonInstances } from '../../../__mocks__/@xterm/addon-fit';
import { resetWebLinksAddonInstances } from '../../../__mocks__/@xterm/addon-web-links';
import {
  resetTerminalInstances,
  terminalInstances,
} from '../../../__mocks__/@xterm/xterm';

import {
  TerminalHost,
  type TerminalHostEntry,
} from '@components/terminal/terminal-host';
import type { TerminalTransport } from '@lib/terminal/terminal-transport';

vi.mock('@xterm/xterm');
vi.mock('@xterm/addon-fit');
vi.mock('@xterm/addon-web-links');

const transport = (): TerminalTransport => ({
  write: vi.fn(),
  resize: vi.fn(),
  onData: vi.fn(() => vi.fn()),
});

/**
 * One row, in its own terminal — the shape of everything that has never been
 * cleared. `/clear` is the only thing that makes the two ids differ, and the
 * cases that exercise that spell it out explicitly.
 */
const entry = (
  id: string,
  over: Partial<TerminalHostEntry> = {},
): TerminalHostEntry => ({
  id,
  terminalKey: id,
  transport: transport(),
  ...over,
});

const entries: TerminalHostEntry[] = [
  entry('orch'),
  entry('hero-refresh'),
  entry('webhooks'),
];

const surfaces = () => screen.queryAllByTestId('terminal-surface');

/**
 * The kept-alive registry (story 042). The guarantee under test is that
 * switching tabs never rebuilds a terminal — that is what preserves scrollback
 * and selection per session.
 */
describe('TerminalHost', () => {
  beforeEach(() => {
    resetTerminalInstances();
    resetFitAddonInstances();
    resetWebLinksAddonInstances();
  });

  it('mounts only the active entry on first render', () => {
    render(<TerminalHost entries={entries} activeId="orch" theme="dark" />);

    // Lazily: opening the app must not construct a terminal for all thirteen
    // fixture entities.
    expect(terminalInstances).toHaveLength(1);
    expect(surfaces()).toHaveLength(1);
  });

  it('keeps a visited terminal alive after switching away', () => {
    const { rerender } = render(
      <TerminalHost entries={entries} activeId="orch" theme="dark" />,
    );

    rerender(
      <TerminalHost entries={entries} activeId="hero-refresh" theme="dark" />,
    );

    // Both exist; exactly one is on screen.
    expect(terminalInstances).toHaveLength(2);
    expect(terminalInstances.some((instance) => instance.disposed)).toBe(false);
    const visible = surfaces().filter(
      (node) => node.style.display !== 'none',
    );
    expect(visible).toHaveLength(1);
  });

  it('does not rebuild a terminal when returning to it', () => {
    const { rerender } = render(
      <TerminalHost entries={entries} activeId="orch" theme="dark" />,
    );
    rerender(
      <TerminalHost entries={entries} activeId="hero-refresh" theme="dark" />,
    );

    rerender(<TerminalHost entries={entries} activeId="orch" theme="dark" />);

    // Three switches, two instances. A third would mean the buffer was thrown
    // away and the user's scroll position with it.
    expect(terminalInstances).toHaveLength(2);
  });

  it('tears down a terminal whose entry disappears', () => {
    const { rerender } = render(
      <TerminalHost entries={entries} activeId="hero-refresh" theme="dark" />,
    );
    const [instance] = terminalInstances;

    rerender(
      <TerminalHost
        entries={entries.filter((entry) => entry.id !== 'hero-refresh')}
        activeId="orch"
        theme="dark"
      />,
    );

    expect(instance.disposed).toBe(true);
  });

  it('renders nothing when no entry is active', () => {
    render(<TerminalHost entries={entries} activeId={null} theme="dark" />);

    expect(surfaces()).toHaveLength(0);
    expect(terminalInstances).toHaveLength(0);
  });

  it('passes read-only through to the surface', () => {
    render(
      <TerminalHost
        entries={[entry('orch', { readOnly: true })]}
        activeId="orch"
        theme="dark"
      />,
    );

    expect(terminalInstances[0].options).toMatchObject({ disableStdin: true });
  });

  /**
   * `/clear` leaves two rows naming one pty: the session that finished and the
   * one that replaced it. Both stay in the fleet list, so both reach this
   * component.
   */
  describe('two rows sharing one terminal', () => {
    /**
     * One transport, shared — which is what `center-stage.tsx` produces, because
     * its cache is keyed on the terminal. Giving the two rows separate
     * transports would be testing a situation the app cannot create, and would
     * hide the very thing this block is for: the surface resubscribes when its
     * transport identity changes, so a per-row transport would rebuild the
     * xterm no matter what the key said.
     */
    const shared = transport();
    /** Before the `/clear`: one row, live, the user typing into it. */
    const live = entry('sess-01', { terminalKey: 'sess-01', transport: shared });
    /** After: the same row retired, and a successor on the same terminal. */
    const cleared = entry('sess-01', {
      terminalKey: 'sess-01',
      transport: shared,
      readOnly: true,
    });
    const successor = entry('sess-02', {
      terminalKey: 'sess-01',
      transport: shared,
    });

    it('mounts one surface, not two', () => {
      const { rerender } = render(
        <TerminalHost entries={[live]} activeId="sess-01" theme="dark" />,
      );
      rerender(
        <TerminalHost
          entries={[cleared, successor]}
          activeId="sess-02"
          theme="dark"
        />,
      );

      // Two instances would fight over one channel, and React would be handed
      // duplicate keys.
      expect(surfaces()).toHaveLength(1);
    });

    /**
     * The retired row is inert and never shown; the successor is the one the
     * user types into. Keeping the read-only entry would leave them looking at
     * a live terminal that swallows every keystroke.
     */
    it('keeps the live row, not the retired one', () => {
      const { rerender } = render(
        <TerminalHost entries={[live]} activeId="sess-01" theme="dark" />,
      );
      rerender(
        <TerminalHost
          entries={[cleared, successor]}
          activeId="sess-02"
          theme="dark"
        />,
      );

      expect(surfaces()[0]).toHaveAttribute('data-terminal-id', 'sess-02');
    });

    /**
     * The whole reason the key is the terminal and not the row: xterm keeps its
     * instance across the swap, so the scrollback the user was reading survives
     * the moment they typed `/clear`.
     */
    it('does not rebuild the xterm instance across the swap', () => {
      const { rerender } = render(
        <TerminalHost entries={[live]} activeId="sess-01" theme="dark" />,
      );
      const before = terminalInstances.length;

      rerender(
        <TerminalHost
          entries={[cleared, successor]}
          activeId="sess-02"
          theme="dark"
        />,
      );

      expect(terminalInstances).toHaveLength(before);
    });
  });
});
