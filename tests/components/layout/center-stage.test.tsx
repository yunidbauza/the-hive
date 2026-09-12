import { cleanup, render, screen, within } from '@testing-library/react';
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
import { useAppearanceStore } from '@stores/appearance-store';
import { useEditorStore } from '@stores/editor-store';
import { useHiveStore } from '@stores/hive-store';
import { DECLINED_BACK_MS } from '@/hooks/use-declined-back';
import { TERMINAL_CHORD_EVENT } from '@lib/terminal/keymap';
import { useUiStore } from '@stores/ui-store';
import { seedDemoFleet } from '@tests/support/demo-fleet';

vi.mock('@xterm/xterm');
vi.mock('@xterm/addon-fit');
vi.mock('@xterm/addon-web-links');
vi.mock('@xterm/addon-webgl');

/**
 * The meta bar, probed by the branch it names — scoped to the bar itself.
 *
 * A bare `queryByText` used to do it, back when the fleet table underneath
 * rendered `project · branch` as one joined string and so could never collide
 * with a branch on its own. `BRANCH` is a real column now, so the branch text
 * appears in two places and an unscoped probe finds the table's copy even when
 * no meta bar is mounted — which is exactly what the "no meta bar" assertions
 * below are for.
 */
const metaBarFor = (branch: string) => {
  const bar = screen.queryByTestId('session-meta-bar');
  return bar ? within(bar).queryByText(branch) : null;
};
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
    seedDemoFleet();
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

  /**
   * An agent gets its own surface, not a terminal's (HIVE-116).
   *
   * Opening one used to mount a session meta bar, a read-only xterm replaying
   * its lines, and a message row beneath — three pieces of terminal chrome
   * around something that is not a terminal, and a place to type that reached
   * no process.
   */
  it('mounts the agent view, and none of the terminal chrome', () => {
    render(<CenterStage />);

    act(() => useUiStore.getState().openTab('slack-agent'));

    expect(screen.getByText('Today')).toBeInTheDocument();
    expect(screen.getByText('Session')).toBeInTheDocument();
    expect(screen.queryByTestId('session-meta-bar')).not.toBeInTheDocument();
    expect(screen.queryByText('dedicated agent')).not.toBeInTheDocument();
  });

  it('drops the meta bar again on the way back to the orchestrator', () => {
    render(<CenterStage />);
    act(() => useUiStore.getState().openTab('hero-refresh'));
    expect(metaBarFor('feat/hero-refresh')).toBeInTheDocument();

    act(() => useUiStore.getState().backToOrch());

    expect(metaBarFor('feat/hero-refresh')).not.toBeInTheDocument();
  });

  /**
   * The overmind divides its column between the fleet table and the
   * transcript, and the user decides where.
   *
   * The table used to size itself to its content, which with a long fleet
   * meant the whole column minus the transcript's floor. It gets a share now
   * — half by default — behind a divider of the same kind the editor split
   * has. happy-dom performs no layout, so what is pinned here is the
   * mechanism: the pane's basis follows the store, the divider is mounted for
   * the overmind and nothing else, and a double-click puts the half back.
   */
  describe('the fleet table’s share of the column', () => {
    const divider = () => screen.queryByRole('slider', { name: 'Resize the fleet table' });

    it('gives the table half the column by default, behind a divider', () => {
      render(<CenterStage />);

      const pane = screen.getByTestId('fleet-pane');
      expect(pane).toHaveStyle({ flex: '0 1 50%' });
      expect(divider()).toBeInTheDocument();
      /*
        The share is a cap, not a size: `max-h-max` keeps a short fleet
        content-sized, so a fresh launch does not paint half a column of
        table ground over one empty-state line. `min-h-0` is what lets a long
        fleet shrink to the share and scroll — without it the flex item's
        automatic minimum is the whole fleet.
      */
      expect(pane).toHaveClass('max-h-max', 'min-h-0');
    });

    it('follows the stored ratio', () => {
      render(<CenterStage />);

      act(() => useAppearanceStore.getState().setConsoleSplitRatio(0.3));

      expect(screen.getByTestId('fleet-pane')).toHaveStyle({ flex: '0 1 30%' });
      expect(divider()).toHaveAttribute('aria-valuenow', '30');
    });

    it('puts the half back on double-click', async () => {
      const user = userEvent.setup();
      render(<CenterStage />);
      act(() => useAppearanceStore.getState().setConsoleSplitRatio(0.7));

      await user.dblClick(divider()!);

      expect(useAppearanceStore.getState().consoleSplitRatio).toBe(0.5);
    });

    it('is the overmind’s alone — a session has no table to divide', () => {
      render(<CenterStage />);

      act(() => useUiStore.getState().openTab('hero-refresh'));

      expect(divider()).toBeNull();
      expect(screen.queryByTestId('fleet-pane')).toBeNull();
    });
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

    /*
      Orchestrator + hero-refresh, constructed once each — and *not* one for
      slack-agent. Agents left the terminal list with HIVE-116: a definition on
      disk used to get a cached transport and an xterm nobody mounts, which the
      count here was quietly asserting was correct.
    */
    expect(terminalInstances).toHaveLength(2);
    expect(terminalInstances.some((instance) => instance.disposed)).toBe(false);
    expect(visibleSurfaces()).toHaveLength(1);
  });

  it('builds no terminal at all for an agent', () => {
    render(<CenterStage />);

    act(() => useUiStore.getState().openTab('slack-agent'));

    // Only the orchestrator's, which is constructed on mount.
    expect(terminalInstances).toHaveLength(1);
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
        // The terminal verb (terminals). A shell takes the same channel
        // bookkeeping as a session over a different spawn, so this is the only
        // member the terminal transport adds to the stub.
        spawnTerminal: vi.fn(() => Promise.resolve()),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(() => Promise.resolve()),
        ack: vi.fn(),
        // HIVE-135. The surface reports its input box on mount+visible, so an
        // interactive terminal here — real `PtyTransport` — calls this.
        prompt: vi.fn(),
        onData: vi.fn(() => vi.fn()),
        onExit: vi.fn(() => vi.fn()),
        onLost: vi.fn(() => vi.fn()),
      },
    };
  }

  beforeEach(() => {
    useHiveStore.getState().reset();
    seedDemoFleet();
    useUiStore.getState().reset();
    resetTerminalInstances();
    resetFitAddonInstances();
    resetWebLinksAddonInstances();
  });

  afterEach(() => {
    /**
     * Unmount while the bridge still exists (HIVE-135).
     *
     * `TerminalSurface` now reports `unfocused` from the reveal effect's
     * cleanup, which fires when a live surface unmounts — a passive effect
     * that would otherwise flush during the global `afterEach`'s `cleanup()`
     * in `tests/setup.ts`, *after* the bridge below was already deleted. Doing
     * it here first, before the delete, is what `clone-repo-view.test.tsx`
     * settled on for the same race.
     */
    cleanup();
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

  /*
    There is no agent row in this table any more (HIVE-116). An agent used to
    get a read-only xterm over a replayed transcript; it now gets a view with
    no terminal in it at all, which `builds no terminal at all for an agent`
    above is the assertion for.
  */

  describe('the message row (story 108)', () => {
    const messageRow = () => screen.queryByLabelText(/^Message /);

    it('is absent over a live session — the terminal is the input', () => {
      /**
       * A live session **is** Claude Code's own prompt. A second text box under
       * it gives one session two places to type, with different keybindings and
       * no way to tell from the caret which will receive the next character —
       * and its autofocus was competing with the terminal's for every newly
       * opened session, which is how a brand-new session came to ignore what
       * was typed into it.
       */
      withBridge();
      render(<CenterStage />);
      act(() => useUiStore.getState().openTab('hero-refresh'));

      expect(messageRow()).not.toBeInTheDocument();
    });

    it('stays over a recorded transcript, which has no prompt of its own', () => {
      // The browser demo. Without the row there is no way to speak to it at all.
      render(<CenterStage />);
      act(() => useUiStore.getState().openTab('hero-refresh'));

      expect(messageRow()).toBeInTheDocument();
    });

    it('is absent over an agent, which has an input of its own', () => {
      // The agent view carries a ledger box, and it is deliberately not this
      // row: it posts to the log rather than typing at a process. Two inputs
      // on one stage is the bug the row was removed from live sessions over.
      withBridge();
      render(<CenterStage />);
      act(() => useUiStore.getState().openTab('slack-agent'));

      expect(messageRow()).not.toBeInTheDocument();
    });
  });

  describe('a session that ends while it is on screen (story 108)', () => {
    it('tells its surface, so the terminal stops taking input', () => {
      withBridge();
      render(<CenterStage />);
      act(() => useUiStore.getState().openTab('hero-refresh'));
      expect(optionsFor(1).disableStdin).toBe(false);

      act(() =>
        useHiveStore.getState().setSessionStatus('hero-refresh', 'terminated'),
      );

      expect(optionsFor(1).disableStdin).toBe(true);
      expect(optionsFor(1).cursorBlink).toBe(false);
    });

    it('does not navigate away — the exit notice is the point', () => {
      /**
       * Terminated sessions cannot be *re-entered*, but yanking the view out
       * from under someone the instant their agent quits would make the ending
       * impossible to read. The gate is about coming back, not about leaving.
       */
      withBridge();
      render(<CenterStage />);
      act(() => useUiStore.getState().openTab('hero-refresh'));

      act(() =>
        useHiveStore.getState().setSessionStatus('hero-refresh', 'terminated'),
      );

      expect(useUiStore.getState().activeTab).toBe('hero-refresh');
    });
  });

  /**
   * A terminal whose shell dies while it is on screen (terminals).
   *
   * Bridge-backed deliberately, and that is the whole point of the block: with
   * no bridge a terminal is a recording, `disableStdin` is already `true` from
   * construction, and an assertion on it passes whether or not the stage tells
   * the surface anything. Live, it starts `false` — so the transition below is
   * the only thing in the unit suite that can fail if `endedId` stops asking
   * `isLostTerminal`.
   */
  describe('a terminal whose shell dies while it is on screen (terminals)', () => {
    it('covers it with the reason, and its surface stops taking input', () => {
      withBridge();
      const id = useHiveStore.getState().spawnTerminal('nova-web');
      render(<CenterStage />);

      // A live shell, before anything happens to it.
      const surface = terminalInstances.at(-1)!;
      expect(surface.options.disableStdin).toBe(false);

      act(() =>
        useHiveStore
          .getState()
          .markTerminalLost(id, 'the shell was killed by signal 9'),
      );

      expect(screen.getByRole('status')).toHaveTextContent(
        'the shell was killed by signal 9',
      );
      /*
        Same instance, not a rebuilt one: the strip explains what happened over
        a transcript that has to survive to be read.
      */
      expect(terminalInstances.at(-1)).toBe(surface);
      expect(surface.options.disableStdin).toBe(true);
      // A blinking caret over a dead shell is an invitation to type into
      // nothing.
      expect(surface.options.cursorBlink).toBe(false);
    });
  });
});

describe('CenterStage — the escape chord', () => {
  beforeEach(() => {
    useHiveStore.getState().reset();
    seedDemoFleet();
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
      { key: '[', metaKey: true },
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

  describe('a chord it wanted and could not have (HIVE-79)', () => {
    const hint = () => screen.queryByTestId('terminal-hint');

    it('says where the key went, and where the way back is', () => {
      render(<CenterStage />);
      act(() => useUiStore.getState().openTab('hero-refresh'));

      emitChord('back-declined');

      const strip = hint();
      expect(strip).not.toBeNull();
      expect(strip?.textContent).toContain('← went to the session');
      expect(strip?.textContent).toContain('returns to the overmind');
    });

    it('stays on the session — it is news, not navigation', () => {
      /**
       * The distinction the whole event carries. `back` means the app took the
       * key and should leave; `back-declined` means the pty took it and the
       * user is still here. Navigating on it would take the user somewhere on
       * the strength of a keystroke that had already gone elsewhere.
       */
      render(<CenterStage />);
      act(() => useUiStore.getState().openTab('hero-refresh'));

      emitChord('back-declined');

      expect(useUiStore.getState().activeTab).toBe('hero-refresh');
    });

    it('goes quiet again on its own', () => {
      vi.useFakeTimers();
      try {
        render(<CenterStage />);
        act(() => useUiStore.getState().openTab('hero-refresh'));

        emitChord('back-declined');
        expect(hint()).not.toBeNull();

        act(() => vi.advanceTimersByTime(DECLINED_BACK_MS));
        expect(hint()).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('is not raised by an ordinary declined chord', () => {
      render(<CenterStage />);
      act(() => useUiStore.getState().openTab('hero-refresh'));

      emitChord('back');

      expect(hint()).toBeNull();
    });
  });
});

describe('CenterStage — text fields keep their native bindings', () => {
  beforeEach(() => {
    useHiveStore.getState().reset();
    seedDemoFleet();
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

/**
 * The editor on the stage.
 *
 * Two settings, four layouts, and one rule that unifies them: a Terminal entry
 * exists exactly when the terminal is hidden. The combination that was wrong in
 * review — `full` + `single` — showed a tab strip *and* the pane's own filename
 * header, which is two ways to close one file and a Terminal tab the docs say
 * should not be there.
 */
describe('CenterStage — the editor', () => {
  const openAFile = async () => {
    await act(async () => {
      useEditorStore.getState().openFile('nova-web', 'src/app.ts');
    });
  };

  beforeEach(() => {
    /**
     * The same resets the other blocks do, and they are not optional: a
     * leftover `settings: true` from an earlier describe puts `hidden` on the
     * whole stage region, and `getByRole` skips a `display: none` subtree — so
     * every assertion here would fail for a reason that has nothing to do with
     * the editor.
     */
    useHiveStore.getState().reset();
    seedDemoFleet();
    useUiStore.getState().reset();
    resetTerminalInstances();
    resetFitAddonInstances();
    resetWebLinksAddonInstances();
    useEditorStore.getState().reset();
    useAppearanceStore.getState().reset();
  });

  afterEach(() => {
    useEditorStore.getState().reset();
    useAppearanceStore.getState().reset();
  });

  it('shows no strip until a file is open', () => {
    render(<CenterStage />);
    expect(screen.queryByRole('tablist', { name: 'Open files' })).toBeNull();
  });

  it('full + tabs: a strip with a Terminal entry', async () => {
    render(<CenterStage />);
    await openAFile();

    expect(screen.getByRole('tablist', { name: 'Open files' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Terminal/ })).toBeInTheDocument();
  });

  /**
   * The bug: no strip belongs here at all. The pane carries its own filename
   * header, and a Terminal entry contradicts the documented layout for this
   * cell.
   */
  it('full + single: no strip at all', async () => {
    act(() => {
      useAppearanceStore.getState().setEditorNav('single');
    });
    render(<CenterStage />);
    await openAFile();

    expect(screen.queryByRole('tablist', { name: 'Open files' })).toBeNull();
    expect(screen.queryByRole('tab', { name: /Terminal/ })).toBeNull();
  });

  it('split + tabs: a strip, but no Terminal entry', async () => {
    act(() => {
      useAppearanceStore.getState().setEditorPlacement('split');
    });
    render(<CenterStage />);
    await openAFile();

    expect(screen.getByRole('tablist', { name: 'Open files' })).toBeInTheDocument();
    // The terminal is already on screen; an entry offering to "go to" it would
    // point at something the user is looking at.
    expect(screen.queryByRole('tab', { name: /Terminal/ })).toBeNull();
  });

  it('split shows a draggable divider, and full does not', async () => {
    const { rerender } = render(<CenterStage />);
    await openAFile();

    expect(screen.queryByRole('slider', { name: 'Resize the editor' })).toBeNull();

    act(() => {
      useAppearanceStore.getState().setEditorPlacement('split');
    });
    rerender(<CenterStage />);

    expect(
      screen.getByRole('slider', { name: 'Resize the editor' }),
    ).toBeInTheDocument();
  });
});

/**
 * A terminal on the stage (terminals).
 *
 * A shell is not a session, and the chrome around it says so: no meta bar,
 * because there is no branch, ticket or status to name; no boot cover, because
 * nothing is starting that the user should be kept from watching.
 *
 * What it gets once its shell dies unasked is above, under `interactive
 * terminals` — that assertion needs a live surface to be worth anything, and
 * this block has no bridge.
 */
describe('CenterStage — terminals', () => {
  beforeEach(() => {
    useHiveStore.getState().reset();
    seedDemoFleet();
    useUiStore.getState().reset();
    resetTerminalInstances();
    resetFitAddonInstances();
    resetWebLinksAddonInstances();
  });

  it('shows a terminal surface with no meta bar and no boot cover', () => {
    const id = useHiveStore.getState().spawnTerminal('nova-web');
    render(<CenterStage />);

    /*
      One surface, and it is the terminal's — which only happens because the
      stage builds its entries from `useTerminalHostIds`. `useNavOrder` is the
      fleet table's order and deliberately carries no terminal, so a stage
      reading it would open a tab with no transport behind it.
    */
    expect(visibleSurfaces()).toHaveLength(1);
    expect(screen.queryByTestId('session-meta-bar')).toBeNull();
    expect(screen.queryByTestId('session-boot-cover')).toBeNull();
    expect(useUiStore.getState().activeTab).toBe(id);
  });
});

/**
 * The plan rail (HIVE-181): mounted beside the terminal region for a session
 * with a plan, in the terminal view only, and pinned through appearance-store.
 */
describe('CenterStage — the plan rail (HIVE-181)', () => {
  const plan = (taskCount = 2) => ({
    entityId: 'hero-refresh',
    source: 'task-tools' as const,
    allDone: false,
    tasks: Array.from({ length: taskCount }, (_, index) => ({
      id: String(index + 1),
      title: `Task ${String(index + 1)}`,
      status: 'pending' as const,
    })),
  });

  beforeEach(() => {
    useHiveStore.getState().reset();
    seedDemoFleet();
    useUiStore.getState().reset();
    useAppearanceStore.getState().setPlanPinned(false);
    resetTerminalInstances();
    resetFitAddonInstances();
    resetWebLinksAddonInstances();
  });

  afterEach(() => {
    cleanup();
  });

  it("shows the rail beside the terminal for a session with a plan", () => {
    act(() => useHiveStore.getState().setPlan('hero-refresh', plan()));
    render(<CenterStage />);
    act(() => useUiStore.getState().openTab('hero-refresh'));

    expect(screen.getByRole('button', { name: 'Plan, 0 of 2 done' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Plan' })).toBeInTheDocument();
  });

  it('shows nothing for a session with no plan, or a plan with no tasks', () => {
    render(<CenterStage />);
    act(() => useUiStore.getState().openTab('hero-refresh'));

    expect(screen.queryByRole('region', { name: 'Plan' })).toBeNull();

    act(() => useHiveStore.getState().setPlan('hero-refresh', plan(0)));

    expect(screen.queryByRole('region', { name: 'Plan' })).toBeNull();
  });

  it('shows nothing on the overmind or an agent, whatever plans exist', () => {
    act(() => useHiveStore.getState().setPlan('hero-refresh', plan()));
    render(<CenterStage />);

    expect(screen.queryByRole('region', { name: 'Plan' })).toBeNull();

    act(() => useUiStore.getState().openTab('slack-agent'));

    expect(screen.queryByRole('region', { name: 'Plan' })).toBeNull();
  });

  it('pins the drawer through appearance-store', async () => {
    act(() => useHiveStore.getState().setPlan('hero-refresh', plan()));
    render(<CenterStage />);
    act(() => useUiStore.getState().openTab('hero-refresh'));

    await userEvent.click(screen.getByRole('button', { name: 'Pin plan' }));

    expect(useAppearanceStore.getState().planPinned).toBe(true);
    expect(screen.getByRole('button', { name: 'Unpin plan' })).toHaveAttribute('aria-pressed', 'true');
  });
});
