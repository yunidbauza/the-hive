import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetFitAddonInstances } from '../../../__mocks__/@xterm/addon-fit';
import { resetWebLinksAddonInstances } from '../../../__mocks__/@xterm/addon-web-links';
import {
  resetTerminalInstances,
  terminalInstances,
} from '../../../__mocks__/@xterm/xterm';

import { CenterStage } from '@components/layout/center-stage';
import { useHiveStore } from '@stores/hive-store';
import { TERMINAL_CHORD_EVENT } from '@lib/terminal/keymap';
import { useUiStore } from '@stores/ui-store';

vi.mock('@xterm/xterm');
vi.mock('@xterm/addon-fit');
vi.mock('@xterm/addon-web-links');
vi.mock('@xterm/addon-webgl');

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

  describe('the settings overlay (story 101)', () => {
    const settingsTitle = () => screen.queryByRole('heading', { name: 'Settings' });

    it('replaces the terminal area without unmounting it', () => {
      render(<CenterStage />);
      act(() => useUiStore.getState().openTab('hero-refresh'));
      const before = terminalInstances.length;

      act(() => useUiStore.getState().openSettings());

      expect(settingsTitle()).toBeInTheDocument();
      /**
       * The gate that drives this also drives `TerminalHost`'s `activeId`. A
       * settings overlay that did not extend it would render on top of every
       * live terminal rather than in place of them.
       */
      expect(visibleSurfaces()).toHaveLength(0);
      expect(metaBarFor('feat/hero-refresh')).not.toBeInTheDocument();
      // The instances survive, or settings would cost every session its
      // scrollback.
      expect(terminalInstances).toHaveLength(before);
      expect(terminalInstances.some((instance) => instance.disposed)).toBe(false);
    });

    it('returns to the previous view when closed', () => {
      render(<CenterStage />);
      act(() => useUiStore.getState().openTab('hero-refresh'));

      act(() => useUiStore.getState().openSettings());
      act(() => useUiStore.getState().closeSettings());

      // Settings never changed `activeTab`, which is what makes this work.
      expect(settingsTitle()).not.toBeInTheDocument();
      expect(visibleSurfaces()).toHaveLength(1);
    });

    it('wins over the picker rather than stacking with it', () => {
      render(<CenterStage />);

      act(() => useUiStore.getState().openPicker());
      act(() => useUiStore.getState().openSettings());

      expect(settingsTitle()).toBeInTheDocument();
      expect(pickerTitle()).not.toBeInTheDocument();
    });
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

/**
 * Which surfaces accept input (story 095).
 *
 * The decision is `readOnly`, and it is derived from one predicate so a
 * terminal can never report itself typable while its transport is a recording.
 * These assert the rows of the story's table.
 */
describe('CenterStage — interactive terminals', () => {
  /** A bridge complete enough for `PtyTransport` to attach without a process. */
  function withBridge() {
    (window as { hive?: unknown }).hive = {
      pty: {
        spawn: vi.fn(() => Promise.resolve()),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(() => Promise.resolve()),
        ack: vi.fn(),
        onData: vi.fn(() => vi.fn()),
        onExit: vi.fn(() => vi.fn()),
        onLost: vi.fn(() => vi.fn()),
      },
    };
  }

  beforeEach(() => {
    useHiveStore.getState().reset();
    useUiStore.getState().reset();
    resetTerminalInstances();
    resetFitAddonInstances();
    resetWebLinksAddonInstances();
  });

  afterEach(() => {
    delete (window as { hive?: unknown }).hive;
  });

  /** The xterm instance backing a given surface, by construction order. */
  const optionsFor = (index: number) => terminalInstances[index]!.options;

  it('keeps every surface read-only in the browser target', () => {
    // The demo surface is a recording end to end. A blinking cursor over one
    // would be a trap — the user types and nothing happens.
    render(<CenterStage />);
    act(() => useUiStore.getState().openTab('hero-refresh'));

    for (const instance of terminalInstances) {
      expect(instance.options.disableStdin).toBe(true);
      expect(instance.options.cursorBlink).toBe(false);
    }
  });

  it('makes a desktop session typable, with a blinking cursor', () => {
    withBridge();
    render(<CenterStage />);
    act(() => useUiStore.getState().openTab('hero-refresh'));

    // Instance 0 is the orchestrator (mounted first); 1 is the session.
    expect(optionsFor(1).disableStdin).toBe(false);
    // A non-blinking cursor on a live prompt reads as a hung terminal.
    expect(optionsFor(1).cursorBlink).toBe(true);
  });

  it('keeps the orchestrator console read-only ON DESKTOP TOO', () => {
    /**
     * The regression the whole branch exists to prevent. The console is a
     * command surface, not a shell (story 041) — giving the desktop build real
     * terminals must not quietly turn it into one.
     */
    withBridge();
    render(<CenterStage />);

    expect(optionsFor(0).disableStdin).toBe(true);
    expect(optionsFor(0).cursorBlink).toBe(false);
  });

  it('keeps an agent read-only, because its transcript is a replay', () => {
    withBridge();
    render(<CenterStage />);
    act(() => useUiStore.getState().openTab('slack-agent'));

    expect(optionsFor(1).disableStdin).toBe(true);
  });
});

describe('CenterStage — the escape chord', () => {
  beforeEach(() => {
    useHiveStore.getState().reset();
    useUiStore.getState().reset();
    resetTerminalInstances();
    resetFitAddonInstances();
    resetWebLinksAddonInstances();
  });

  /** Fire the event a terminal emits when it declines an app chord. */
  const emitChord = (chord: string) =>
    act(() => {
      window.dispatchEvent(
        new CustomEvent(TERMINAL_CHORD_EVENT, { detail: { chord } }),
      );
    });

  it('returns to the orchestrator when a terminal reports the chord', () => {
    render(<CenterStage />);
    act(() => useUiStore.getState().openTab('hero-refresh'));
    expect(useUiStore.getState().activeTab).toBe('hero-refresh');

    emitChord('back');

    expect(useUiStore.getState().activeTab).toBe('orch');
  });

  it('ignores a chord it does not recognise', () => {
    render(<CenterStage />);
    act(() => useUiStore.getState().openTab('hero-refresh'));

    emitChord('something-else');

    expect(useUiStore.getState().activeTab).toBe('hero-refresh');
  });

  it('does NOT listen for the raw key combination anywhere in the app', () => {
    /**
     * The regression this design exists for. `Cmd+←` is "move caret to start of
     * line" in every native text field and `Ctrl+Shift+←` is "extend selection
     * by a word". An earlier revision listened for the combination on `window`,
     * so typing in the new-session picker and pressing it closed the picker and
     * discarded the query — with no terminal involved at all.
     */
    render(<CenterStage />);
    act(() => useUiStore.getState().openTab('hero-refresh'));

    for (const init of [
      { key: 'ArrowLeft', metaKey: true },
      { key: 'ArrowLeft', ctrlKey: true, shiftKey: true },
    ]) {
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', init));
      });
    }

    expect(useUiStore.getState().activeTab).toBe('hero-refresh');
  });

  it('stops listening once the stage unmounts', () => {
    const { unmount } = render(<CenterStage />);
    act(() => useUiStore.getState().openTab('hero-refresh'));
    unmount();

    emitChord('back');

    expect(useUiStore.getState().activeTab).toBe('hero-refresh');
  });
});

describe('CenterStage — text fields keep their native bindings', () => {
  beforeEach(() => {
    useHiveStore.getState().reset();
    useUiStore.getState().reset();
    resetTerminalInstances();
    resetFitAddonInstances();
    resetWebLinksAddonInstances();
  });

  it('lets the picker keep its query when the chord keys are pressed in it', async () => {
    /**
     * The bug this whole design replaced, asserted end to end through the real
     * input rather than through a synthetic window event.
     *
     * `Cmd+←` is "move caret to start of line" and `Ctrl+Shift+←` is "extend
     * selection by a word". With a `window` keydown listener matching on the
     * combination, pressing either while typing a search query closed the
     * picker and threw the query away — no terminal anywhere near it.
     */
    const user = userEvent.setup();
    render(<CenterStage />);
    act(() => useUiStore.getState().openPicker());

    const search = screen.getByLabelText('Search all projects');
    await user.click(search);
    await user.keyboard('hero');
    await user.keyboard('{Meta>}{ArrowLeft}{/Meta}');
    await user.keyboard('{Control>}{Shift>}{ArrowLeft}{/Shift}{/Control}');

    expect(pickerTitle()).toBeInTheDocument();
    expect(search).toHaveValue('hero');
  });
});
