import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetFitAddonInstances } from '../../../__mocks__/@xterm/addon-fit';
import { resetWebLinksAddonInstances } from '../../../__mocks__/@xterm/addon-web-links';
import {
  resetTerminalInstances,
  terminalInstances,
  type MockLink,
} from '../../../__mocks__/@xterm/xterm';

import { CenterStage } from '@components/layout/center-stage';
import { can } from '@config/runtime';
import { EDITOR_FILE_PANEL, editorTabId } from '@features/editor/components/editor-tab-strip';
import { STAGE_MIN, useAppearanceStore } from '@stores/appearance-store';
import { fileKey, useEditorStore } from '@stores/editor-store';
import { useHiveStore } from '@stores/hive-store';
import { DECLINED_BACK_MS } from '@/hooks/use-declined-back';
import { TERMINAL_CHORD_EVENT } from '@lib/terminal/keymap';
import { useUiStore } from '@stores/ui-store';
import { seedDemoFleet } from '@tests/support/demo-fleet';

const { resolvePaths } = vi.hoisted(() => ({ resolvePaths: vi.fn() }));

vi.mock('@lib/explorer/fs-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@lib/explorer/fs-client')>()),
  resolvePaths,
}));

vi.mock('@xterm/xterm');
vi.mock('@xterm/addon-fit');
vi.mock('@xterm/addon-web-links');
vi.mock('@xterm/addon-webgl');

/**
 * The session header, probed by the branch it names — scoped to the header
 * itself, because the fleet table underneath has a BRANCH column and an
 * unscoped probe would find the table's copy even with no header mounted.
 */
const headerFor = (branch: string) => {
  const header = screen.queryByTestId('session-header');
  return header ? within(header).queryByText(new RegExp(branch)) : null;
};
// The search box, not the title: with no project configured the picker has no title.
const picker = () => screen.queryByLabelText('Search all projects');
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
    // The Sessions place with the console up: the stage itself, nothing covering it.
    useUiStore.setState({ place: 'sessions', consoleShown: true });
    resetTerminalInstances();
    resetFitAddonInstances();
    resetWebLinksAddonInstances();
  });

  it('opens on the orchestrator with no session header', () => {
    render(<CenterStage />);

    // The orchestrator is not an entity and has nothing to describe.
    expect(headerFor('feat/hero-refresh')).not.toBeInTheDocument();
    expect(picker()).not.toBeInTheDocument();
    expect(visibleSurfaces()).toHaveLength(1);
  });

  it('keeps a floor the rails cannot crush (HIVE-223)', () => {
    render(<CenterStage />);
    expect(screen.getByRole('main').style.minWidth).toBe(`${String(STAGE_MIN)}px`);
  });

  it('shows the session header above the terminal for a session', () => {
    render(<CenterStage />);

    act(() => useUiStore.getState().openTab('hero-refresh'));

    expect(headerFor('feat/hero-refresh')).toBeInTheDocument();
    expect(visibleSurfaces()).toHaveLength(1);
  });

  /**
   * An agent gets its own surface, not a terminal's (HIVE-116).
   *
   * Opening one used to mount a session header, a read-only xterm replaying
   * its lines, and a message row beneath — three pieces of terminal chrome
   * around something that is not a terminal, and a place to type that reached
   * no process.
   */
  it('mounts the agent view, and none of the terminal chrome', () => {
    render(<CenterStage />);

    act(() => useUiStore.getState().openTab('slack-agent'));

    expect(screen.getByText('Today')).toBeInTheDocument();
    expect(screen.getByText('Session')).toBeInTheDocument();
    expect(screen.queryByTestId('session-header')).not.toBeInTheDocument();
    expect(screen.queryByText('dedicated agent')).not.toBeInTheDocument();
  });

  it('drops the session header again on the way back to the orchestrator', () => {
    render(<CenterStage />);
    act(() => useUiStore.getState().openTab('hero-refresh'));
    expect(headerFor('feat/hero-refresh')).toBeInTheDocument();

    act(() => useUiStore.getState().backToOrch());

    expect(headerFor('feat/hero-refresh')).not.toBeInTheDocument();
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
      expect(headerFor('feat/hero-refresh')).not.toBeInTheDocument();
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
      expect(picker()).not.toBeInTheDocument();
    });
  });

  describe('the picker', () => {
    it('replaces the terminal area without unmounting it', () => {
      render(<CenterStage />);
      act(() => useUiStore.getState().openTab('hero-refresh'));
      const before = terminalInstances.length;

      act(() => useUiStore.getState().openPicker());

      expect(picker()).toBeInTheDocument();
      // Exactly one state on screen: no terminal, no session header.
      expect(visibleSurfaces()).toHaveLength(0);
      expect(headerFor('feat/hero-refresh')).not.toBeInTheDocument();
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
      expect(picker()).not.toBeInTheDocument();
      expect(headerFor('feat/hero-refresh')).toBeInTheDocument();
    });

    it('closes on Escape', async () => {
      const user = userEvent.setup();
      render(<CenterStage />);
      act(() => useUiStore.getState().openPicker());

      await user.keyboard('{Escape}');

      // Without this the only exit is the mouse, on a picker whose whole point
      // is being keyboard-first.
      expect(picker()).not.toBeInTheDocument();
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
        // A dropped file's path, as preload would read it off a real drop.
        droppedPath: vi.fn((file: File) => `/Users/me/${file.name}`),
      },
    };
  }

  beforeEach(() => {
    useHiveStore.getState().reset();
    seedDemoFleet();
    useUiStore.getState().reset();
    // The Sessions place with the console up: the stage itself, nothing covering it.
    useUiStore.setState({ place: 'sessions', consoleShown: true });
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

  describe('files dropped onto a live session', () => {
    const dropOnSession = (...names: string[]) => {
      const session = visibleSurfaces()[0]!;
      fireEvent.drop(session, {
        dataTransfer: {
          types: ['Files'],
          files: names.map((name) => new File(['x'], name)),
        },
      });
    };

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('types each path single-quoted, through the session terminal', () => {
      withBridge();
      render(<CenterStage />);
      act(() => useUiStore.getState().openTab('hero-refresh'));

      dropOnSession('My Shot.png', "it's.txt");

      expect(terminalInstances[1]!.paste).toHaveBeenCalledWith(
        "'/Users/me/My Shot.png' '/Users/me/it'\\''s.txt' ",
      );
      expect(screen.queryByTestId('terminal-hint')).toBeNull();
    });

    it('refuses while attached to a server, and says why', () => {
      vi.useFakeTimers();
      try {
        withBridge();
        vi.spyOn(can, 'dropFilePaths').mockReturnValue(false);
        render(<CenterStage />);
        act(() => useUiStore.getState().openTab('hero-refresh'));

        act(() => dropOnSession('shot.png'));

        expect(terminalInstances[1]!.paste).not.toHaveBeenCalled();
        expect(screen.getByTestId('terminal-hint').textContent).toContain(
          'names a file on this device',
        );

        act(() => vi.advanceTimersByTime(DECLINED_BACK_MS));
        expect(screen.queryByTestId('terminal-hint')).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });

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
      // The ending took the stage to the Overmind; back on it, it is read-only.
      act(() => useUiStore.getState().openTab('hero-refresh'));

      expect(optionsFor(1).disableStdin).toBe(true);
      expect(optionsFor(1).cursorBlink).toBe(false);
    });

    it('goes back to the Overmind: an /exit is the user leaving', () => {
      /**
       * Story 108 stayed put so the ending could be read; the user asked
       * (6 Oct 2026) for the ended card's ‹ Overmind click to go. A session
       * opened after it ended still gets the card, which is where Resume is.
       */
      withBridge();
      render(<CenterStage />);
      act(() => useUiStore.getState().openTab('hero-refresh'));

      act(() =>
        useHiveStore.getState().setSessionStatus('hero-refresh', 'terminated'),
      );

      expect(useUiStore.getState().activeTab).toBe('orch');
      expect(screen.queryByTestId('session-ended-cover')).toBeNull();
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

    expect(picker()).toBeInTheDocument();
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

  it('full + tabs: the editor pane is the strip’s tabpanel (HIVE-225)', async () => {
    render(<CenterStage />);
    await openAFile();
    // jsdom applies no Tailwind, so the `hidden` terminal column is still in its tree; look the pane up by id.
    const panel = document.getElementById(EDITOR_FILE_PANEL);
    expect(panel).toHaveAttribute('role', 'tabpanel');
    expect(panel).toHaveAttribute('aria-labelledby', editorTabId(useEditorStore.getState().activeKey));
    expect(screen.getByRole('tab', { name: /app\.ts/ })).toHaveAttribute('aria-controls', EDITOR_FILE_PANEL);
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
 * A shell is not a session, and the chrome around it says so: no boot cover,
 * because nothing is starting that the user should be kept from watching.
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

  it('shows a terminal surface with no boot cover', () => {
    const id = useHiveStore.getState().spawnTerminal('nova-web');
    render(<CenterStage />);

    /*
      One surface, and it is the terminal's — which only happens because the
      stage builds its entries from `useTerminalHostIds`. `useNavOrder` is the
      fleet table's order and deliberately carries no terminal, so a stage
      reading it would open a tab with no transport behind it.
    */
    expect(visibleSurfaces()).toHaveLength(1);
    expect(screen.queryByTestId('session-boot-cover')).toBeNull();
    expect(useUiStore.getState().activeTab).toBe(id);
  });
});

describe('CenterStage — an ended session (HIVE-211)', () => {
  beforeEach(() => {
    useHiveStore.getState().reset();
    seedDemoFleet();
    useUiStore.getState().reset();
    resetTerminalInstances();
    resetFitAddonInstances();
    resetWebLinksAddonInstances();
  });
  afterEach(() => useAppearanceStore.getState().reset());

  it('covers a terminated session, over its still-mounted terminal', () => {
    useHiveStore.getState().setSessionStatus('hero-refresh', 'terminated');
    useUiStore.getState().openTab('hero-refresh', 'sessions');
    render(<CenterStage />);
    expect(screen.getByTestId('session-ended-cover')).toBeInTheDocument();
    expect(visibleSurfaces()).toHaveLength(1);
  });

  it('does not cover a live session', () => {
    useUiStore.getState().openTab('hero-refresh', 'sessions');
    render(<CenterStage />);
    expect(screen.queryByTestId('session-ended-cover')).toBeNull();
  });

});

/**
 * The composition root's half of terminal file links: *who* a printed path
 * is resolved for, and what opening one does to the stage.
 */
describe('CenterStage — file links', () => {
  beforeEach(() => {
    useHiveStore.getState().reset();
    seedDemoFleet();
    useUiStore.getState().reset();
    useUiStore.setState({ place: 'sessions', consoleShown: true });
    resetTerminalInstances();
    resetFitAddonInstances();
    resetWebLinksAddonInstances();
  });

  afterEach(() => cleanup());

  const provider = () => terminalInstances.at(-1)?.linkProviders[0];
  const links = (y: number): Promise<MockLink[] | undefined> =>
    new Promise((done) => {
      const found = provider();
      if (!found) {
        done(undefined);
        return;
      }
      found.provideLinks(y, done);
    });
  /** Both, so the assertion holds on either platform. */
  const open = (link: MockLink | undefined) =>
    act(() =>
      link?.activate(
        new MouseEvent('click', { metaKey: true, ctrlKey: true }),
        link.text,
      ),
    );

  beforeEach(() => {
    useEditorStore.getState().reset();
    resolvePaths.mockClear();
    resolvePaths.mockImplementation(
      async (_projectId: string, _sessionId: string | undefined, paths: string[]) =>
        paths.map((path) =>
          path === 'src/a.ts' ? { relPath: 'src/a.ts', rootKey: '' } : null,
        ),
    );
  });

  it('resolves under the session on screen and opens the file on the stage', async () => {
    render(<CenterStage />);
    act(() => useUiStore.getState().openTab('hero-refresh'));
    terminalInstances.at(-1)!.bufferLines = ['● Edit src/a.ts:4:2'];

    const [link] = (await links(1)) ?? [];
    expect(resolvePaths).toHaveBeenCalledWith('nova-web', 'hero-refresh', [
      'src/a.ts',
    ]);

    open(link);
    expect(useEditorStore.getState().activeKey).toBe(
      fileKey('nova-web', 'src/a.ts'),
    );
  });

  it('carries the line and column into the buffer', async () => {
    render(<CenterStage />);
    act(() => useUiStore.getState().openTab('hero-refresh'));
    const instance = terminalInstances.at(-1);
    expect(instance).toBeDefined();
    instance!.bufferLines = ['src/a.ts:4:2'];

    open((await links(1))?.[0]);

    const file = useEditorStore
      .getState()
      .openFiles.find((entry) => entry.key === fileKey('nova-web', 'src/a.ts'));
    expect(file?.pendingCursor).toEqual({ line: 4, col: 2 });
  });

  it('opens at the top when the path named no line', async () => {
    render(<CenterStage />);
    act(() => useUiStore.getState().openTab('hero-refresh'));
    terminalInstances.at(-1)!.bufferLines = ['src/a.ts'];

    open((await links(1))?.[0]);

    const file = useEditorStore
      .getState()
      .openFiles.find((entry) => entry.key === fileKey('nova-web', 'src/a.ts'));
    expect(file?.pendingCursor).toBeNull();
  });

  it('closes what was open first in single-file mode', async () => {
    act(() => useAppearanceStore.getState().setEditorNav('single'));
    render(<CenterStage />);
    act(() => useUiStore.getState().openTab('hero-refresh'));
    const instance = terminalInstances.at(-1);
    expect(instance).toBeDefined();
    instance!.bufferLines = ['src/a.ts'];

    /*
      Opened *after* the terminal has mounted. A file open at first render
      puts the editor on the stage, so the host is handed `activeId={null}`,
      mounts nothing, and there is no provider to drive. The kept-alive
      instance survives the editor taking the stage, which is the point.
    */
    act(() => useEditorStore.getState().openFile('nova-web', 'src/old.ts'));

    open((await links(1))?.[0]);
    expect(
      useEditorStore.getState().openFiles.map((file) => file.relPath),
    ).toEqual(['src/a.ts']);
  });

  /**
   * The overmind has no project, and a tree — or a link — rooted in a
   * project nothing on screen is working in is the untruth
   * `use-explorer-project` removed from the explorer. Same rule here.
   */
  it('resolves nothing on the orchestrator, which has no project', async () => {
    render(<CenterStage />);
    terminalInstances[0]!.bufferLines = ['src/a.ts'];

    expect(await links(1)).toBeUndefined();
    expect(resolvePaths).not.toHaveBeenCalled();
  });
});

describe('CenterStage — Home (HIVE-195)', () => {
  beforeEach(() => {
    useHiveStore.getState().reset();
    seedDemoFleet();
    useUiStore.getState().reset();
    useAppearanceStore.getState().reset();
    resetTerminalInstances();
    resetFitAddonInstances();
    resetWebLinksAddonInstances();
  });

  afterEach(() => {
    useAppearanceStore.getState().reset();
  });

  it('shows the Home page and hides the terminal region without unmounting it', () => {
    render(<CenterStage />);
    // Terminals mount on first activation, so one has to be watched first.
    act(() => useUiStore.getState().openTab('hero-refresh', 'sessions'));
    expect(visibleSurfaces()).toHaveLength(1);
    const before = terminalInstances.length;

    act(() => useUiStore.getState().selectPlace('home'));

    expect(screen.getByRole('heading', { name: 'Home', level: 1 })).toBeInTheDocument();
    expect(visibleSurfaces()).toHaveLength(0);
    expect(terminalInstances).toHaveLength(before);
    expect(terminalInstances.some((instance) => instance.disposed)).toBe(false);

    act(() => useUiStore.getState().selectPlace('sessions'));

    expect(screen.queryByRole('heading', { name: 'Home', level: 1 })).not.toBeInTheDocument();
    expect(visibleSurfaces()).toHaveLength(1);
    expect(terminalInstances).toHaveLength(before);
  });

});

describe('CenterStage — Work (HIVE-203)', () => {
  beforeEach(() => {
    useHiveStore.getState().reset();
    seedDemoFleet();
    useUiStore.getState().reset();
    useAppearanceStore.getState().reset();
    resetTerminalInstances();
    resetFitAddonInstances();
    resetWebLinksAddonInstances();
  });

  afterEach(() => {
    useAppearanceStore.getState().reset();
  });

  it('owns the stage on the Work place and hides the terminal region', () => {
    render(<CenterStage />);
    act(() => useUiStore.getState().openTab('hero-refresh', 'sessions'));
    expect(visibleSurfaces()).toHaveLength(1);

    act(() => useUiStore.getState().selectPlace('work'));

    expect(screen.getByRole('region', { name: /^(Work|Ticket )/ })).toBeInTheDocument();
    expect(visibleSurfaces()).toHaveLength(0);
  });

  it('gives way to the picker', () => {
    useUiStore.setState({ place: 'work' });
    render(<CenterStage />);

    act(() => useUiStore.getState().openPicker());

    expect(screen.queryByText('Pick a ticket')).not.toBeInTheDocument();
  });

});

describe('CenterStage — the reconnect line (HIVE-211)', () => {
  const reconnecting = {
    state: 'reconnecting',
    serverName: 'mini',
    attempt: 2,
    nextAttemptAt: null,
    reason: null,
    epoch: 1,
    lost: 0,
  } as const;

  beforeEach(() => {
    useHiveStore.getState().reset();
    seedDemoFleet();
    useUiStore.getState().reset();
    useAppearanceStore.getState().reset();
    resetTerminalInstances();
    resetFitAddonInstances();
    resetWebLinksAddonInstances();
    useHiveStore.getState().setRemoteLink(reconnecting);
  });

  afterEach(() => {
    useAppearanceStore.getState().reset();
  });

  it.each(['home', 'work', 'agents', 'prs', 'sessions'] as const)(
    'says the server is lost across the top of %s',
    (place) => {
      useUiStore.setState({ place });
      render(<CenterStage />);

      const line = screen.getByText('Lost Hive TTY on mini.').closest('[role="status"]');
      expect(line).not.toBeNull();
      // First in the stage, above whatever the place draws.
      expect(screen.getByRole('main').firstElementChild).toBe(line);
    },
  );

  it('goes once the link is back', () => {
    render(<CenterStage />);
    act(() => useHiveStore.getState().setRemoteLink({ ...reconnecting, state: 'attached' }));

    expect(screen.queryByText('Lost Hive TTY on mini.')).not.toBeInTheDocument();
  });

});

describe('CenterStage — the Overmind head (HIVE-197)', () => {
  beforeEach(() => {
    useHiveStore.getState().reset();
    seedDemoFleet();
    useUiStore.getState().reset();
    useAppearanceStore.getState().reset();
    resetTerminalInstances();
    resetFitAddonInstances();
    resetWebLinksAddonInstances();
  });

  afterEach(() => {
    useAppearanceStore.getState().reset();
  });

  it('heads the orchestrator view', () => {
    useUiStore.setState({ place: 'sessions', activeTab: 'orch' });
    render(<CenterStage />);
    expect(screen.getByRole('heading', { level: 1, name: 'Overmind' })).toBeInTheDocument();
  });

  it('is absent over a session', () => {
    useUiStore.setState({ place: 'sessions', activeTab: 'hero-refresh' });
    render(<CenterStage />);
    expect(screen.queryByRole('heading', { level: 1, name: 'Overmind' })).not.toBeInTheDocument();
  });

});

describe('CenterStage — the console dock (HIVE-197)', () => {
  const orchSurface = () => document.querySelector<HTMLElement>('[data-terminal-id="orch"]');

  beforeEach(() => {
    useHiveStore.getState().reset();
    seedDemoFleet();
    useUiStore.getState().reset();
    useAppearanceStore.getState().reset();
    resetTerminalInstances();
    resetFitAddonInstances();
    resetWebLinksAddonInstances();
    useUiStore.setState({ place: 'sessions', activeTab: 'orch' });
  });

  afterEach(() => {
    useAppearanceStore.getState().reset();
  });

  it('folded by default: no transcript on screen, the peek and the prompt show', () => {
    render(<CenterStage />);
    // `activeId` is null while folded, and `TerminalHost` mounts a surface on its
    // first visit, so the transcript is not built until it is first shown.
    expect(visibleSurfaces()).toHaveLength(0);
    expect(screen.getByRole('button', { name: /Show the console/ })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Overmind command' })).toBeInTheDocument();
    expect(screen.queryByRole('slider', { name: 'Resize the fleet table' })).not.toBeInTheDocument();
  });

  it('keeps the same transcript surface across a fold and an unfold', async () => {
    render(<CenterStage />);

    await userEvent.click(screen.getByRole('button', { name: /Show the console/ }));
    const shown = orchSurface();
    expect(shown).not.toBeNull();
    expect(shown?.closest('.hidden')).toBeNull();
    expect(shown?.style.display).not.toBe('none');
    expect(screen.getByRole('slider', { name: 'Resize the fleet table' })).toBeInTheDocument();
    const instances = terminalInstances.length;

    await userEvent.click(screen.getByRole('button', { name: /Hide the console/ }));
    const folded = orchSurface();
    expect(folded).toBe(shown);
    expect(folded?.closest('.hidden')).not.toBeNull();
    expect(folded?.style.display).toBe('none');

    await userEvent.click(screen.getByRole('button', { name: /Show the console/ }));
    expect(orchSurface()).toBe(shown);
    expect(orchSurface()?.style.display).not.toBe('none');
    expect(terminalInstances).toHaveLength(instances);
    expect(terminalInstances.some((instance) => instance.disposed)).toBe(false);
  });

  it('does not hide a session’s terminal while the console is folded', () => {
    useUiStore.setState({ activeTab: 'hero-refresh' });
    render(<CenterStage />);
    const surface = document.querySelector<HTMLElement>('[data-terminal-id="hero-refresh"]');
    expect(surface?.closest('.hidden')).toBeNull();
    expect(surface?.style.display).not.toBe('none');
  });

});

describe('CenterStage — the session header (HIVE-197)', () => {
  beforeEach(() => {
    useHiveStore.getState().reset();
    seedDemoFleet();
    useUiStore.getState().reset();
    useAppearanceStore.getState().reset();
    resetTerminalInstances();
    resetFitAddonInstances();
    resetWebLinksAddonInstances();
  });

  afterEach(() => {
    useAppearanceStore.getState().reset();
  });

  it('heads a session with the session header and never the meta bar or the plan rail (HIVE-213)', () => {
    useUiStore.setState({ activeTab: 'hero-refresh', place: 'sessions' });
    render(<CenterStage />);
    expect(screen.getByTestId('session-header')).toBeInTheDocument();
    expect(screen.queryByTestId('session-meta-bar')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Plan' })).not.toBeInTheDocument();
  });

  it('shows over a terminal', () => {
    act(() => {
      useHiveStore.setState((state) => ({
        entities: {
          ...state.entities,
          'term-5': {
            kind: 'terminal',
            id: 'term-5',
            project: 'nova-web',
            cwd: '/repos/nova-web',
            status: 'prompt',
            createdAt: 1,
            lines: [],
          },
        },
        order: [...state.order, 'term-5'],
      }));
    });
    useUiStore.setState({ activeTab: 'term-5', place: 'sessions' });
    render(<CenterStage />);
    expect(screen.getByTestId('session-header')).toHaveTextContent('term-5');
  });

  it('is absent over the Overmind', () => {
    useUiStore.setState({ activeTab: 'orch', place: 'sessions' });
    render(<CenterStage />);
    expect(screen.queryByTestId('session-header')).not.toBeInTheDocument();
  });

});

describe('CenterStage — the inbox corner (HIVE-198)', () => {
  beforeEach(() => {
    useHiveStore.getState().reset();
    seedDemoFleet();
    useUiStore.getState().reset();
    useHiveStore.setState({
      notifs: [
        {
          id: 'q1',
          kind: 'agent.ask',
          title: 'ship it?',
          body: '',
          unread: true,
          createdAt: 1,
          action: { type: 'ask', thread: 'q1' },
        },
      ],
    });
  });

  afterEach(() => {
    useAppearanceStore.getState().reset();
  });

  it('mounts the pill', () => {
    useUiStore.setState({ place: 'sessions', activeTab: 'orch' });
    render(<CenterStage />);
    expect(screen.getByRole('button', { name: 'Inbox, 1 needs you' })).toBeInTheDocument();
  });

  it('opens the Inbox drawer with no setting seeded (HIVE-213)', () => {
    useUiStore.setState({ place: 'sessions', activeTab: 'orch' });
    useUiStore.getState().openInboxDrawer();
    render(<CenterStage />);
    expect(screen.getByRole('dialog', { name: 'Needs you' })).toBeInTheDocument();
  });

  it('marks the Overmind dock as the stage input', () => {
    useUiStore.setState({ place: 'sessions', activeTab: 'orch' });
    render(<CenterStage />);
    expect(document.querySelector('[data-stage-input]')).not.toBeNull();
  });

});
