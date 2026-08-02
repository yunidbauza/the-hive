import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetFitAddonInstances } from '../../../__mocks__/@xterm/addon-fit';
import { resetWebLinksAddonInstances } from '../../../__mocks__/@xterm/addon-web-links';
import {
  resetTerminalInstances,
  terminalInstances,
} from '../../../__mocks__/@xterm/xterm';

import { CenterStage } from '@components/layout/center-stage';
import { useHiveStore } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';

vi.mock('@xterm/xterm');
vi.mock('@xterm/addon-fit');
vi.mock('@xterm/addon-web-links');

const metaBarFor = (id: string) => screen.queryByText(id);
const pickerTitle = () => screen.queryByText('Start a new session');
const visibleSurfaces = () =>
  screen
    .queryAllByTestId('terminal-surface')
    .filter((node) => node.style.display !== 'none');

/**
 * The view-state machine as rendered (story 040). `resolve-view.test.ts` covers
 * the transitions themselves; this file checks that exactly one state reaches
 * the DOM and that switching between them never disposes a terminal.
 */
describe('CenterStage', () => {
  beforeEach(() => {
    useHiveStore.getState().reset();
    useUiStore.getState().reset();
    resetTerminalInstances();
    resetFitAddonInstances();
    resetWebLinksAddonInstances();
  });

  it('opens on the orchestrator with no meta bar', () => {
    render(<CenterStage />);

    // The orchestrator is not an entity and has nothing to describe.
    expect(metaBarFor('feat/hero-refresh')).not.toBeInTheDocument();
    expect(pickerTitle()).not.toBeInTheDocument();
    expect(visibleSurfaces()).toHaveLength(1);
  });

  it('shows the meta bar above the terminal for a session', () => {
    render(<CenterStage />);

    act(() => useUiStore.getState().openTab('hero-refresh'));

    expect(metaBarFor('feat/hero-refresh')).toBeInTheDocument();
    expect(screen.getByText('Refactor hero to semantic tokens')).toBeInTheDocument();
    expect(visibleSurfaces()).toHaveLength(1);
  });

  it('shows the agent chips for an agent', () => {
    render(<CenterStage />);

    act(() => useUiStore.getState().openTab('slack-agent'));

    expect(screen.getByText('dedicated agent')).toBeInTheDocument();
  });

  it('drops the meta bar again on the way back to the orchestrator', () => {
    render(<CenterStage />);
    act(() => useUiStore.getState().openTab('hero-refresh'));
    expect(metaBarFor('feat/hero-refresh')).toBeInTheDocument();

    act(() => useUiStore.getState().backToOrch());

    expect(metaBarFor('feat/hero-refresh')).not.toBeInTheDocument();
  });

  describe('the picker', () => {
    it('replaces the terminal area without unmounting it', () => {
      render(<CenterStage />);
      act(() => useUiStore.getState().openTab('hero-refresh'));
      const before = terminalInstances.length;

      act(() => useUiStore.getState().openPicker());

      expect(pickerTitle()).toBeInTheDocument();
      // Exactly one state on screen: no terminal, no meta bar.
      expect(visibleSurfaces()).toHaveLength(0);
      expect(metaBarFor('feat/hero-refresh')).not.toBeInTheDocument();
      // …but the instances survive, or the picker would cost every session its
      // scrollback.
      expect(terminalInstances).toHaveLength(before);
      expect(terminalInstances.some((instance) => instance.disposed)).toBe(false);
    });

    it('returns to the previous view when closed, not to the orchestrator', async () => {
      const user = userEvent.setup();
      render(<CenterStage />);
      act(() => useUiStore.getState().openTab('hero-refresh'));
      act(() => useUiStore.getState().openPicker());

      await user.click(screen.getByRole('button', { name: 'esc · cancel' }));

      // The picker never changed `activeTab`, which is what makes this work.
      expect(pickerTitle()).not.toBeInTheDocument();
      expect(metaBarFor('feat/hero-refresh')).toBeInTheDocument();
    });

    it('closes on Escape', async () => {
      const user = userEvent.setup();
      render(<CenterStage />);
      act(() => useUiStore.getState().openPicker());

      await user.keyboard('{Escape}');

      // Without this the only exit is the mouse, on a picker whose whole point
      // is being keyboard-first.
      expect(pickerTitle()).not.toBeInTheDocument();
    });
  });

  it('keeps every visited terminal alive across a tour of the views', () => {
    render(<CenterStage />);

    act(() => useUiStore.getState().openTab('hero-refresh'));
    act(() => useUiStore.getState().openTab('slack-agent'));
    act(() => useUiStore.getState().backToOrch());
    act(() => useUiStore.getState().openTab('hero-refresh'));

    // orchestrator + hero-refresh + slack-agent, constructed once each.
    expect(terminalInstances).toHaveLength(3);
    expect(terminalInstances.some((instance) => instance.disposed)).toBe(false);
    expect(visibleSurfaces()).toHaveLength(1);
  });
});
