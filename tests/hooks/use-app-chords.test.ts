import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAppChords } from '@/hooks/use-app-chords';
import { TERMINAL_CHORD_EVENT, type TerminalChordDetail } from '@lib/terminal/keymap';
import { useAppearanceStore } from '@stores/appearance-store';
import { useHiveStore } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';
import { seedDemoFleet, seedDemoProjectConfig } from '@tests/support/demo-fleet';

/**
 * The rail-collapse chords, from everywhere the terminal is not (this story).
 *
 * `tests/lib/terminal/keymap.test.ts` proves `isRailChord`'s own platform
 * matrix; what is only provable here is that the hook actually wires a
 * `window` keydown to the store, that it does not double-fire for a keystroke
 * the terminal already announced, and that it cleans up after itself.
 */
describe('useAppChords', () => {
  beforeEach(() => {
    useAppearanceStore.getState().reset();
    useHiveStore.getState().reset();
    seedDemoFleet();
    seedDemoProjectConfig();
    useUiStore.getState().reset();
    // Pin the platform so the mac-chord assertions below don't depend on
    // whatever OS the suite happens to run on — `isMacPlatform` has its own
    // matrix covered in `tests/lib/platform.test.ts`.
    vi.stubGlobal('navigator', { userAgentData: { platform: 'macOS' } });
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it('toggles the left rail on a window keydown', () => {
    renderHook(() => useAppChords());

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'b', metaKey: true, bubbles: true }),
      );
    });

    expect(useAppearanceStore.getState().railCollapsedLeft).toBe(true);
  });

  it('toggles the right rail on the alt variant', () => {
    renderHook(() => useAppChords());

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'b', metaKey: true, altKey: true, bubbles: true }),
      );
    });

    expect(useAppearanceStore.getState().railCollapsedRight).toBe(true);
  });

  it('toggles the left rail on the non-mac chord', () => {
    vi.stubGlobal('navigator', { userAgentData: { platform: 'Windows' } });
    renderHook(() => useAppChords());

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'b',
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
        }),
      );
    });

    expect(useAppearanceStore.getState().railCollapsedLeft).toBe(true);
  });

  it('ignores a keydown originating inside a terminal', () => {
    // The terminal's own path already dispatched a chord event for this
    // keystroke. Handling both would toggle twice and land back where it
    // started — a shortcut that visibly does nothing.
    const terminal = document.createElement('div');
    terminal.setAttribute('data-terminal-id', 'sess-01');
    document.body.append(terminal);
    renderHook(() => useAppChords());

    act(() => {
      terminal.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'b', metaKey: true, bubbles: true }),
      );
    });

    expect(useAppearanceStore.getState().railCollapsedLeft).toBe(false);
  });

  it('toggles once on a terminal chord event', () => {
    renderHook(() => useAppChords());

    act(() => {
      window.dispatchEvent(
        new CustomEvent(TERMINAL_CHORD_EVENT, {
          detail: { chord: 'rail-left' } satisfies TerminalChordDetail,
        }),
      );
    });

    expect(useAppearanceStore.getState().railCollapsedLeft).toBe(true);
  });

  it('ignores a back chord', () => {
    renderHook(() => useAppChords());

    act(() => {
      window.dispatchEvent(
        new CustomEvent(TERMINAL_CHORD_EVENT, {
          detail: { chord: 'back' } satisfies TerminalChordDetail,
        }),
      );
    });

    expect(useAppearanceStore.getState().railCollapsedLeft).toBe(false);
  });

  it('stops listening when it unmounts', () => {
    const { unmount } = renderHook(() => useAppChords());
    unmount();

    // No act() wrapper: nothing should be listening, so nothing should update.
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'b', metaKey: true, bubbles: true }),
    );
    window.dispatchEvent(
      new CustomEvent(TERMINAL_CHORD_EVENT, {
        detail: { chord: 'rail-left' } satisfies TerminalChordDetail,
      }),
    );

    expect(useAppearanceStore.getState().railCollapsedLeft).toBe(false);
  });

  describe('terminal-here', () => {
    it('opens a sibling terminal for the active session on a window keydown', () => {
      const session = useHiveStore.getState().spawnSession('nova-web');
      useUiStore.getState().openTab(session);
      renderHook(() => useAppChords());

      act(() => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', { key: '`', ctrlKey: true, bubbles: true }),
        );
      });

      const opened = useHiveStore.getState().order.at(-1)!;
      expect(useHiveStore.getState().entities[opened]).toMatchObject({
        kind: 'terminal',
        project: 'nova-web',
      });
    });

    it('opens a sibling for the active terminal on the terminal chord event, once', () => {
      const first = useHiveStore
        .getState()
        .spawnTerminal('nova-web', { cwd: '/repos/nova-web/pkg' });
      renderHook(() => useAppChords());
      const before = useHiveStore.getState().order.length;

      act(() => {
        window.dispatchEvent(
          new CustomEvent(TERMINAL_CHORD_EVENT, {
            detail: { chord: 'terminal-here' } satisfies TerminalChordDetail,
          }),
        );
      });

      expect(useHiveStore.getState().order).toHaveLength(before + 1);
      const opened = useHiveStore.getState().order.at(-1)!;
      expect(opened).not.toBe(first);
      expect(useHiveStore.getState().entities[opened]).toMatchObject({
        cwd: '/repos/nova-web/pkg',
      });
    });

    it('does nothing on the console tab', () => {
      useUiStore.getState().backToOrch();
      renderHook(() => useAppChords());
      const before = useHiveStore.getState().order.length;

      act(() => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', { key: '`', ctrlKey: true, bubbles: true }),
        );
      });

      expect(useHiveStore.getState().order).toHaveLength(before);
    });

    it('ignores the keydown originating inside a terminal — the surface already announced it', () => {
      const session = useHiveStore.getState().spawnSession('nova-web');
      useUiStore.getState().openTab(session);
      const terminal = document.createElement('div');
      terminal.setAttribute('data-terminal-id', session);
      document.body.append(terminal);
      renderHook(() => useAppChords());
      const before = useHiveStore.getState().order.length;

      act(() => {
        terminal.dispatchEvent(
          new KeyboardEvent('keydown', { key: '`', ctrlKey: true, bubbles: true }),
        );
      });

      expect(useHiveStore.getState().order).toHaveLength(before);
    });
  });
});
