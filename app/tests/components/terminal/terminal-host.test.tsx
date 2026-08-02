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

const entries: TerminalHostEntry[] = [
  { id: 'orch', transport: transport() },
  { id: 'hero-refresh', transport: transport() },
  { id: 'webhooks', transport: transport() },
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
        entries={[{ id: 'orch', transport: transport(), readOnly: true }]}
        activeId="orch"
        theme="dark"
      />,
    );

    expect(terminalInstances[0].options).toMatchObject({ disableStdin: true });
  });
});
