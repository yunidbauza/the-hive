import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BUILT_IN_THEME } from '@lib/theme/built-in';
import { BUILT_IN_THEMES } from '@lib/theme/built-in-themes';
import { type HiveTheme } from '@lib/theme/contract';
import { RAIL_MIN, railMaxWidth } from '@lib/rail-width';
import {
  APPEARANCE_STORAGE_KEY,
  DEFAULT_TEAM_NAME,
  activeThemeOf,
  migrateAppearance,
  resolveTheme,
  sanitizeThemeState,
  useAppearanceStore,
  syncRailWidths,
  useTerminalAppearance,
  watchSystemTheme,
} from '@stores/appearance-store';

/**
 * A complete, valid theme distinguishable from the built-in — built the same
 * way `validate.test.ts`'s `fullTheme` helper does, by recolouring it.
 */
const nordFixture: HiveTheme = {
  ...structuredClone(BUILT_IN_THEME),
  name: 'Nord',
  author: 'Arctic Ice Studio',
  modes: {
    ...structuredClone(BUILT_IN_THEME.modes),
    dark: {
      ...structuredClone(BUILT_IN_THEME.modes.dark),
      ui: { ...BUILT_IN_THEME.modes.dark.ui, panel: '#2e3440' },
    },
  },
};

/**
 * Appearance is the first persisted state in the app (story 105), so these
 * cover three things the other store tests never had to: what reaches the DOM,
 * what reaches localStorage, and what happens when what comes back is junk.
 */

/**
 * A controllable `prefers-color-scheme`.
 *
 * happy-dom ships no `matchMedia`, so the store's own guard would otherwise
 * make every `system` case untestable — and that guard is exactly what the
 * "no matchMedia" case below is checking, so it cannot be the thing under test
 * everywhere else too.
 */
function stubMatchMedia(matches: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();

  const query = {
    matches,
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) =>
      listeners.add(listener),
    removeEventListener: (
      _type: string,
      listener: (event: MediaQueryListEvent) => void,
    ) => listeners.delete(listener),
  };

  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => query),
  );

  return {
    /** Simulate the OS flipping while the app is open. */
    emit(next: boolean) {
      query.matches = next;
      for (const listener of listeners) {
        listener({ matches: next } as MediaQueryListEvent);
      }
    },
    listenerCount: () => listeners.size,
  };
}

beforeEach(() => {
  localStorage.clear();
  document.body.removeAttribute('data-theme');
  document.body.removeAttribute('data-density');
  document.body.style.removeProperty('--cc-rail-w-left');
  document.body.style.removeProperty('--cc-rail-w-right');
  useAppearanceStore.setState({ systemDark: true });
  useAppearanceStore.getState().reset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('appearance-store — resolveTheme', () => {
  it('passes an explicit preference through untouched', () => {
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
  });

  it('defers to the OS only for system', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });
});

describe('appearance-store — theme', () => {
  it('defaults to dark, not system', () => {
    // Story 105 adds `system` as an option; it does not change what the app
    // boots as. "Dark is the default" is story 011's decision and the smoke
    // spec treats the header's theme button as the proof of which theme booted.
    expect(useAppearanceStore.getState().theme).toBe('dark');
  });

  it('setTheme writes data-theme for light and removes it for dark', () => {
    useAppearanceStore.getState().setTheme('light');
    expect(document.body.getAttribute('data-theme')).toBe('light');

    useAppearanceStore.getState().setTheme('dark');
    // Dark is the default and carries no attribute, so the :root block in
    // tokens.css applies unmodified.
    expect(document.body.hasAttribute('data-theme')).toBe(false);
  });

  it('system resolves against the OS rather than painting a third palette', () => {
    useAppearanceStore.setState({ systemDark: false });
    useAppearanceStore.getState().setTheme('system');

    expect(useAppearanceStore.getState().theme).toBe('system');
    expect(document.body.getAttribute('data-theme')).toBe('light');
  });

  it('toggleTheme commits to the opposite of what is on screen, leaving system', () => {
    useAppearanceStore.setState({ systemDark: true });
    useAppearanceStore.getState().setTheme('system');

    useAppearanceStore.getState().toggleTheme();

    // Not 'system' any more: the header's button is a two-state control, and
    // landing the user in a third state they never chose is not what it means.
    expect(useAppearanceStore.getState().theme).toBe('light');
    expect(document.body.getAttribute('data-theme')).toBe('light');
  });

  it('setSystemDark repaints only while the preference is system', () => {
    useAppearanceStore.getState().setTheme('system');
    useAppearanceStore.getState().setSystemDark(false);
    expect(document.body.getAttribute('data-theme')).toBe('light');

    useAppearanceStore.getState().setTheme('dark');
    useAppearanceStore.getState().setSystemDark(false);
    // Pinned to dark: the OS changing at dusk must not repaint the app.
    expect(document.body.hasAttribute('data-theme')).toBe(false);
  });
});

describe('appearance-store — density', () => {
  it('defaults to comfortable and carries no attribute', () => {
    expect(useAppearanceStore.getState().density).toBe('comfortable');
    expect(document.body.hasAttribute('data-density')).toBe(false);
  });

  it('setDensity writes and clears data-density', () => {
    useAppearanceStore.getState().setDensity('compact');
    expect(document.body.getAttribute('data-density')).toBe('compact');

    useAppearanceStore.getState().setDensity('comfortable');
    expect(document.body.hasAttribute('data-density')).toBe(false);
  });
});

describe('appearance-store — team name', () => {
  it('defaults to the app\'s own room, not to anybody\'s team', () => {
    expect(useAppearanceStore.getState().teamName).toBe(DEFAULT_TEAM_NAME);
  });

  /**
   * The field writes on every keystroke, so a setter that trimmed would eat
   * the space the moment it was typed and "Assimilation Team" could never be
   * entered. Trimming is the reader's job — see `useTeamName`.
   */
  it('stores exactly what was typed, space and all', () => {
    useAppearanceStore.getState().setTeamName('Zergling ');
    expect(useAppearanceStore.getState().teamName).toBe('Zergling ');

    useAppearanceStore.getState().setTeamName('Zergling Battalion');
    expect(useAppearanceStore.getState().teamName).toBe('Zergling Battalion');
  });

  it('takes empty as an answer rather than restoring the default', () => {
    useAppearanceStore.getState().setTeamName('');
    expect(useAppearanceStore.getState().teamName).toBe('');
  });
});

describe('appearance-store — terminal appearance', () => {
  it('defaults match what the terminal has always used', () => {
    const state = useAppearanceStore.getState();

    expect(state.terminalFont).toBe('system');
    expect(state.terminalFontSize).toBe(12.5);
    expect(state.terminalScrollback).toBe(5000);
  });

  it('each setter stores its value', () => {
    const state = useAppearanceStore.getState();

    state.setTerminalFont('menlo');
    state.setTerminalFontSize(14);
    state.setTerminalScrollback(10_000);

    expect(useAppearanceStore.getState()).toMatchObject({
      terminalFont: 'menlo',
      terminalFontSize: 14,
      terminalScrollback: 10_000,
    });
  });
});

describe('appearance-store — the terminal palette', () => {
  it('hands over colours for the resolved mode, not the preference', () => {
    const { result, rerender } = renderHook(() => useTerminalAppearance());

    act(() => useAppearanceStore.getState().setTheme('light'));
    rerender();
    expect(result.current.palette).toEqual(BUILT_IN_THEME.modes.light.terminal);

    act(() => useAppearanceStore.getState().setTheme('dark'));
    rerender();
    expect(result.current.palette).toEqual(BUILT_IN_THEME.modes.dark.terminal);
  });

  /**
   * The referential guard, and it is not a micro-optimisation.
   *
   * `TerminalSurface` re-themes when the palette's *identity* changes, so a
   * selector that spread or rebuilt the object would reassign the xterm theme
   * of every kept-alive terminal on every unrelated render. `useShallow`
   * compares one level deep and cannot save us: it is this field's reference
   * that it compares.
   */
  it('is the stored object, so an unrelated change cannot re-theme terminals', () => {
    const { result, rerender } = renderHook(() => useTerminalAppearance());

    const first = result.current.palette;
    expect(first).toBe(BUILT_IN_THEME.modes.dark.terminal);

    act(() => useAppearanceStore.getState().setTerminalFontSize(16));
    rerender();

    expect(result.current.fontSize).toBe(16);
    expect(result.current.palette).toBe(first);
  });

  /**
   * The dark branch above only proves the guard holds for the default mode.
   * A spread reintroduced on the light path would slip past it — this covers
   * that branch explicitly.
   */
  it('is the stored object on the light branch too', () => {
    const { result, rerender } = renderHook(() => useTerminalAppearance());

    act(() => useAppearanceStore.getState().setTheme('light'));
    rerender();

    expect(result.current.palette).toBe(BUILT_IN_THEME.modes.light.terminal);
  });
});

/**
 * Rail widths (HIVE-105).
 *
 * The arithmetic is proved in `tests/lib/rail-width.test.ts`. What is left for
 * the store is everything that arithmetic cannot answer: what is stored versus
 * what is painted, which custom property ends up on `<body>`, and what survives
 * a reload.
 */
describe('appearance-store — rail widths', () => {
  const COMFORTABLE = RAIL_MIN.comfortable;

  /** What `use-rail-widths` does, minus React. */
  const paint = (windowWidth = 1440, showActivityRail = true) =>
    syncRailWidths({
      storedLeft: useAppearanceStore.getState().railWidthLeft,
      storedRight: useAppearanceStore.getState().railWidthRight,
      min: RAIL_MIN[useAppearanceStore.getState().density],
      windowWidth,
      left: 'expanded',
      right: showActivityRail ? 'expanded' : 'hidden',
    });

  const inlineLeft = () => document.body.style.getPropertyValue('--cc-rail-w-left');
  const inlineRight = () => document.body.style.getPropertyValue('--cc-rail-w-right');

  it('starts following the stylesheet rather than at a number', () => {
    expect(useAppearanceStore.getState().railWidthLeft).toBeNull();
    expect(useAppearanceStore.getState().railWidthRight).toBeNull();
  });

  /**
   * The distinction the whole feature turns on. A rail nobody has dragged gets
   * *no* inline property, so `tokens.css` — density rules included — keeps
   * control of it. Writing today's number inline would freeze it there.
   */
  it('leaves an untouched rail to the stylesheet', () => {
    paint();

    expect(inlineLeft()).toBe('');
    expect(inlineRight()).toBe('');
  });

  it('writes an override once a rail is dragged', () => {
    useAppearanceStore.getState().setRailWidth('left', 400);
    paint();

    expect(inlineLeft()).toBe('400px');
    expect(inlineRight()).toBe('');
  });

  it('hands the rail back to the stylesheet on reset', () => {
    useAppearanceStore.getState().setRailWidth('left', 400);
    paint();
    expect(inlineLeft()).toBe('400px');

    useAppearanceStore.getState().resetRailWidth('left');
    paint();

    expect(useAppearanceStore.getState().railWidthLeft).toBeNull();
    expect(inlineLeft()).toBe('');
  });

  it('never writes a width for a rail that is not mounted', () => {
    useAppearanceStore.getState().setRailWidth('right', 400);
    paint(1440, false);

    expect(inlineRight()).toBe('');
  });

  describe('what gets stored', () => {
    it('refuses to store a width below the density minimum', () => {
      useAppearanceStore.getState().setRailWidth('left', 100);
      expect(useAppearanceStore.getState().railWidthLeft).toBe(COMFORTABLE.left);
    });

    it('refuses to store a width above the absolute cap', () => {
      useAppearanceStore.getState().setRailWidth('left', 9999);
      expect(useAppearanceStore.getState().railWidthLeft).toBe(520);
    });

    it('ignores a width that is not a number', () => {
      useAppearanceStore.getState().setRailWidth('left', Number.NaN);
      expect(useAppearanceStore.getState().railWidthLeft).toBeNull();
    });

    it('stores whole pixels', () => {
      useAppearanceStore.getState().setRailWidth('left', 400.6);
      expect(useAppearanceStore.getState().railWidthLeft).toBe(401);
    });

    /**
     * **Stored intent, not painted pixels.** The window is what squeezes a
     * width; the store must not learn from the squeeze, or a narrow moment
     * would permanently cost the user the width they chose.
     */
    it('survives a window that is too narrow to honour it', () => {
      useAppearanceStore.getState().setRailWidth('left', 500);

      const squeezed = paint(1100);
      expect(squeezed.left).toBe(Math.floor(railMaxWidth(1100)));
      expect(squeezed.left).toBeLessThan(500);
      expect(useAppearanceStore.getState().railWidthLeft).toBe(500);

      const restored = paint(1920);
      expect(restored.left).toBe(500);
    });
  });

  describe('density', () => {
    /** A rail nobody dragged still re-spaces when density changes. */
    it('leaves an untouched rail free to follow a density change', () => {
      useAppearanceStore.getState().setDensity('compact');
      expect(inlineLeft()).toBe('');

      expect(paint().left).toBe(RAIL_MIN.compact.left);
    });

    it('keeps a hand-set width across a density change', () => {
      useAppearanceStore.getState().setRailWidth('left', 400);
      useAppearanceStore.getState().setDensity('compact');

      expect(useAppearanceStore.getState().railWidthLeft).toBe(400);
      /*
        Asserted through a paint at a stated width rather than by reading the
        property `setDensity` just wrote. That write measured happy-dom's own
        narrow window, so it is legitimately a squeezed number — which is the
        behaviour under test two cases up, not this one.
      */
      expect(paint(1920).left).toBe(400);
    });

    /**
     * A width that was legal at compact is below the comfortable minimum.
     * Painting must lift it; the stored intent stays where the user put it.
     */
    it('lifts a width stored under a narrower density', () => {
      useAppearanceStore.getState().setDensity('compact');
      useAppearanceStore.getState().setRailWidth('left', RAIL_MIN.compact.left);
      useAppearanceStore.getState().setDensity('comfortable');

      expect(paint().left).toBe(COMFORTABLE.left);
    });
  });

  describe('persistence', () => {
    it('writes both widths to localStorage', () => {
      useAppearanceStore.getState().setRailWidth('left', 400);
      useAppearanceStore.getState().setRailWidth('right', 380);

      const raw = localStorage.getItem(APPEARANCE_STORAGE_KEY);
      expect(JSON.parse(raw ?? '{}').state).toMatchObject({
        railWidthLeft: 400,
        railWidthRight: 380,
      });
    });

    it('persists the null that means "follow the stylesheet"', () => {
      useAppearanceStore.getState().setRailWidth('left', 400);
      useAppearanceStore.getState().resetRailWidth('left');

      const raw = localStorage.getItem(APPEARANCE_STORAGE_KEY);
      expect(JSON.parse(raw ?? '{}').state.railWidthLeft).toBeNull();
    });

    it('returns to following the stylesheet on reset()', () => {
      useAppearanceStore.getState().setRailWidth('left', 400);
      useAppearanceStore.getState().reset();

      expect(useAppearanceStore.getState().railWidthLeft).toBeNull();
      expect(inlineLeft()).toBe('');
    });
  });
});

describe('appearance-store — persistence', () => {
  it('writes only the whitelisted preferences to localStorage', () => {
    useAppearanceStore.getState().setTheme('light');
    useAppearanceStore.getState().setDensity('compact');

    const raw = localStorage.getItem(APPEARANCE_STORAGE_KEY);
    expect(raw).not.toBeNull();

    const { state } = JSON.parse(raw as string) as { state: Record<string, unknown> };

    expect(state).toEqual({
      theme: 'light',
      terminalFont: 'system',
      terminalFontSize: 12.5,
      terminalScrollback: 5000,
      density: 'compact',
      railWidthLeft: null,
      railWidthRight: null,
      railCollapsedLeft: false,
      railCollapsedRight: false,
      teamName: 'Swarm Command',
      editorPlacement: 'full',
      editorSplitAxis: 'vertical',
      editorSplitRatio: 0.5,
      consoleSplitRatio: 0.5,
      editorNav: 'tabs',
      editorEditable: true,
      editorFont: 'system',
      editorFontSize: 13,
      editorWordWrap: true,
      editorLineNumbers: true,
      editorTabWidth: 2,
      themes: {},
      activeThemeId: 'hive',
    });
    // The environment is not a preference: persisting it would restore a stale
    // answer on a machine whose OS theme has since changed.
    expect(state).not.toHaveProperty('systemDark');
  });

  it('restores a stored preference on rehydrate and applies it to the DOM', async () => {
    localStorage.setItem(
      APPEARANCE_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        state: {
          theme: 'light',
          terminalFont: 'monaco',
          terminalFontSize: 16,
          terminalScrollback: 1000,
          density: 'compact',
        },
      }),
    );

    vi.resetModules();
    const { useAppearanceStore: store } = await import('@stores/appearance-store');

    expect(store.getState()).toMatchObject({
      theme: 'light',
      terminalFont: 'monaco',
      terminalFontSize: 16,
      terminalScrollback: 1000,
      density: 'compact',
    });
    // The point of a synchronous store: this is already true before React runs.
    expect(document.body.getAttribute('data-theme')).toBe('light');
    expect(document.body.getAttribute('data-density')).toBe('compact');
  });

  it('falls back to defaults when the stored entry is corrupt', async () => {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, 'not json at all');

    vi.resetModules();
    const { useAppearanceStore: store } = await import('@stores/appearance-store');

    expect(store.getState()).toMatchObject({
      theme: 'dark',
      terminalFont: 'system',
      terminalFontSize: 12.5,
      terminalScrollback: 5000,
      density: 'comfortable',
    });
  });
});

describe('appearance-store — watchSystemTheme', () => {
  it('seeds from the OS and follows later changes', () => {
    const media = stubMatchMedia(false);
    useAppearanceStore.getState().setTheme('system');

    const stop = watchSystemTheme();

    // Seeded: the OS may have changed between module evaluation and this call.
    expect(useAppearanceStore.getState().systemDark).toBe(false);
    expect(document.body.getAttribute('data-theme')).toBe('light');

    media.emit(true);
    expect(useAppearanceStore.getState().systemDark).toBe(true);
    expect(document.body.hasAttribute('data-theme')).toBe(false);

    stop();
    expect(media.listenerCount()).toBe(0);
  });

  it('is a no-op teardown when the environment has no matchMedia', () => {
    vi.stubGlobal('matchMedia', undefined);

    const stop = watchSystemTheme();

    expect(() => stop()).not.toThrow();
  });
});

/**
 * The editor block.
 *
 * Here rather than in a store of its own for the reason this store exists at
 * all: every one of these is a durable choice about how the screen looks, and
 * the browser target has no config file to read it from.
 */
describe('appearance-store — the editor', () => {
  it('opens on the documented defaults', () => {
    const state = useAppearanceStore.getState();

    expect(state.editorPlacement).toBe('full');
    expect(state.editorSplitAxis).toBe('vertical');
    expect(state.editorSplitRatio).toBe(0.5);
    expect(state.editorNav).toBe('tabs');
    expect(state.editorEditable).toBe(true);
    expect(state.editorFontSize).toBe(13);
    expect(state.editorWordWrap).toBe(true);
    expect(state.editorLineNumbers).toBe(true);
    expect(state.editorTabWidth).toBe(2);
  });

  it('sets each preference independently', () => {
    const store = useAppearanceStore.getState();

    store.setEditorPlacement('split');
    store.setEditorSplitAxis('horizontal');
    store.setEditorNav('single');
    store.setEditorEditable(true);
    store.setEditorFont('menlo');
    store.setEditorFontSize(16);
    store.setEditorWordWrap(false);
    store.setEditorLineNumbers(false);
    store.setEditorTabWidth(8);

    expect(useAppearanceStore.getState()).toMatchObject({
      editorPlacement: 'split',
      editorSplitAxis: 'horizontal',
      editorNav: 'single',
      editorEditable: true,
      editorFont: 'menlo',
      editorFontSize: 16,
      editorWordWrap: false,
      editorLineNumbers: false,
      editorTabWidth: 8,
    });
  });

  /**
   * The ratio arrives from a pointer drag, which can produce anything a fast
   * gesture past the edge of the window produces — including `NaN` on a
   * zero-width container. Clamped on the way in, so every reader gets a usable
   * value without repeating the bound.
   */
  it('clamps the split ratio, including a non-finite one', () => {
    const store = useAppearanceStore.getState();

    store.setEditorSplitRatio(0.01);
    expect(useAppearanceStore.getState().editorSplitRatio).toBe(0.2);

    store.setEditorSplitRatio(0.99);
    expect(useAppearanceStore.getState().editorSplitRatio).toBe(0.8);

    store.setEditorSplitRatio(Number.NaN);
    expect(useAppearanceStore.getState().editorSplitRatio).toBe(0.5);

    store.setEditorSplitRatio(0.35);
    expect(useAppearanceStore.getState().editorSplitRatio).toBe(0.35);
  });

  /**
   * The overmind's divider writes through the same clamp. Half by default:
   * the fleet table and the transcript share the column, and neither gives
   * way to the other unasked.
   */
  it('holds the console split at half by default and clamps it like the editor’s', () => {
    expect(useAppearanceStore.getState().consoleSplitRatio).toBe(0.5);

    const store = useAppearanceStore.getState();

    store.setConsoleSplitRatio(0.01);
    expect(useAppearanceStore.getState().consoleSplitRatio).toBe(0.2);

    store.setConsoleSplitRatio(0.99);
    expect(useAppearanceStore.getState().consoleSplitRatio).toBe(0.8);

    store.setConsoleSplitRatio(Number.NaN);
    expect(useAppearanceStore.getState().consoleSplitRatio).toBe(0.5);

    store.setConsoleSplitRatio(0.3);
    expect(useAppearanceStore.getState().consoleSplitRatio).toBe(0.3);
    // Its own field: dragging one divider must not move the other.
    expect(useAppearanceStore.getState().editorSplitRatio).toBe(0.5);
  });

  it('puts every editor preference back on reset', () => {
    const store = useAppearanceStore.getState();
    store.setEditorPlacement('split');
    store.setEditorEditable(false);
    store.setEditorTabWidth(8);

    useAppearanceStore.getState().reset();

    expect(useAppearanceStore.getState()).toMatchObject({
      editorPlacement: 'full',
      editorEditable: true,
      editorTabWidth: 2,
    });
  });
});

describe('the theme library', () => {
  it('starts with the built-in active and nothing imported', () => {
    const s = useAppearanceStore.getState();
    expect(s.activeThemeId).toBe('hive');
    expect(s.themes).toEqual({});
  });

  it('activating an imported theme writes the style element', () => {
    useAppearanceStore.getState().addTheme('nord', nordFixture);
    useAppearanceStore.getState().activateTheme('nord');
    expect(document.getElementById('hive-theme')).not.toBeNull();
  });

  it('removing the active theme falls back to Hive in the same action', () => {
    useAppearanceStore.getState().addTheme('nord', nordFixture);
    useAppearanceStore.getState().activateTheme('nord');
    useAppearanceStore.getState().removeTheme('nord');

    expect(useAppearanceStore.getState().activeThemeId).toBe('hive');
    expect(useAppearanceStore.getState().themes).toEqual({});
    // and the app is never left pointing at a theme that is not there
    expect(document.getElementById('hive-theme')).toBeNull();
  });

  it('resolves a dangling activeThemeId to the built-in rather than throwing', () => {
    useAppearanceStore.setState({ activeThemeId: 'gone', themes: {} });
    expect(activeThemeOf(useAppearanceStore.getState())).toBeNull();
  });
});

/**
 * The six that ship beside the Hive.
 *
 * The distinction that matters here is which of them `activeThemeOf` answers
 * `null` for. `null` means *the stylesheet already is this palette* — true of
 * the Hive and of nothing else — so a shipped theme that resolved to `null`
 * would activate by removing the style element and leave the Hive on screen
 * under another theme's name.
 */
describe('the shipped themes beside the Hive', () => {
  const SHIPPED = ['honeycomb', 'graphite', 'tidewater', 'terracotta', 'porcelain', 'cinder'];

  it('resolves the Hive to null — the stylesheet is already that palette', () => {
    useAppearanceStore.getState().activateTheme('hive');
    expect(activeThemeOf(useAppearanceStore.getState())).toBeNull();
    expect(document.getElementById('hive-theme')).toBeNull();
  });

  it.each(SHIPPED)('resolves %s to its own theme, not to null', (id) => {
    useAppearanceStore.setState({ activeThemeId: id, themes: {} });
    expect(activeThemeOf(useAppearanceStore.getState())).toBe(BUILT_IN_THEMES[id]);
  });

  it.each(SHIPPED)('activating %s writes the style element', (id) => {
    useAppearanceStore.getState().activateTheme(id);

    expect(useAppearanceStore.getState().activeThemeId).toBe(id);
    const style = document.getElementById('hive-theme');
    expect(style).not.toBeNull();
    expect(style?.textContent).toContain(BUILT_IN_THEMES[id].modes.dark.ui.brand);
  });

  it('switching from a shipped theme back to the Hive removes the element again', () => {
    useAppearanceStore.getState().activateTheme('cinder');
    expect(document.getElementById('hive-theme')).not.toBeNull();

    useAppearanceStore.getState().activateTheme('hive');
    expect(document.getElementById('hive-theme')).toBeNull();
  });

  it.each(SHIPPED)('will not let removeTheme drop %s', (id) => {
    useAppearanceStore.getState().activateTheme(id);
    useAppearanceStore.getState().removeTheme(id);

    expect(useAppearanceStore.getState().activeThemeId).toBe(id);
    expect(activeThemeOf(useAppearanceStore.getState())).toBe(BUILT_IN_THEMES[id]);
  });

  /**
   * A stored theme must never shadow a shipped id. `localStorage` is reachable
   * by another tab and an older build, and the library is looked up *second*
   * for exactly this reason.
   */
  it('prefers the shipped theme when a stored one squats on its id', () => {
    useAppearanceStore.setState({
      activeThemeId: 'cinder',
      themes: { cinder: nordFixture },
    });
    expect(activeThemeOf(useAppearanceStore.getState())).toBe(BUILT_IN_THEMES.cinder);
  });

  it('hands the terminal the shipped palette when one is active', () => {
    useAppearanceStore.getState().activateTheme('honeycomb');
    useAppearanceStore.setState({ theme: 'dark' });

    const { result } = renderHook(() => useTerminalAppearance());
    expect(result.current.palette).toBe(BUILT_IN_THEMES.honeycomb.modes.dark.terminal);
  });
});

/**
 * The Critical fix from the whole-branch review.
 *
 * `localStorage` is reachable by another tab, a devtools session, an older
 * build and a write that was interrupted, and a malformed theme that is still
 * valid *JSON* used to rehydrate verbatim. `applyThemeColors` then threw inside
 * `onRehydrateStorage` — where zustand swallows it — and the terminal-palette
 * selector threw on `.modes[…].terminal`, crashing the centre stage on every
 * render. The entry stayed in storage, so every restart crashed identically and
 * there was no way back from inside the app.
 */
describe('a malformed persisted theme', () => {
  const corrupt = JSON.stringify({
    version: 2,
    state: {
      theme: 'dark',
      themes: { nord: { hiveThemeVersion: 1, name: 'Nord' } },
      activeThemeId: 'nord',
    },
  });

  async function bootFrom(raw: string) {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, raw);
    vi.resetModules();
    return import('@stores/appearance-store');
  }

  it('boots on the built-in rather than crashing', async () => {
    const { useAppearanceStore: store } = await bootFrom(corrupt);

    expect(store.getState().themes).toEqual({});
    // Not merely dangling: the gallery would ring a card that is not there.
    expect(store.getState().activeThemeId).toBe('hive');
    // tokens.css is painting, and it is the only thing painting.
    expect(document.getElementById('hive-theme')).toBeNull();
  });

  it('leaves the terminal palette readable, which is what crashed the stage', async () => {
    const { useAppearanceStore: store, useTerminalAppearance: palette } =
      await bootFrom(corrupt);

    // Reading it at all is the assertion: this selector threw
    // `Cannot read properties of undefined (reading 'dark')`.
    const { result } = renderHook(() => palette());
    expect(result.current.palette).toEqual(BUILT_IN_THEME.modes.dark.terminal);
    expect(store.getState().activeThemeId).toBe('hive');
  });

  it('keeps the valid entries and drops only the broken one', async () => {
    const { useAppearanceStore: store } = await bootFrom(
      JSON.stringify({
        version: 2,
        state: {
          themes: { nord: nordFixture, broken: { hiveThemeVersion: 1 } },
          activeThemeId: 'nord',
        },
      }),
    );

    expect(Object.keys(store.getState().themes)).toEqual(['nord']);
    expect(store.getState().activeThemeId).toBe('nord');
  });

  it('drops a theme whose colours are not colours', async () => {
    const broken = structuredClone(nordFixture) as unknown as Record<string, any>;
    broken.modes.light.ui.panel = 'rgba(0, 0, 0, 0.3)';

    const { useAppearanceStore: store } = await bootFrom(
      JSON.stringify({
        version: 2,
        state: { themes: { nord: broken }, activeThemeId: 'nord' },
      }),
    );

    expect(store.getState().themes).toEqual({});
    expect(store.getState().activeThemeId).toBe('hive');
  });

  it('survives a themes field that is not even an object', async () => {
    const { useAppearanceStore: store } = await bootFrom(
      JSON.stringify({
        version: 2,
        state: { themes: 'nord', activeThemeId: 42 },
      }),
    );

    expect(store.getState().themes).toEqual({});
    expect(store.getState().activeThemeId).toBe('hive');
  });
});

describe('the v1 → v2 migration', () => {
  it('adds the two fields and keeps every existing one', () => {
    const v1 = {
      theme: 'light', terminalFont: 'menlo', terminalFontSize: 14,
      terminalScrollback: 5000, density: 'compact', teamName: 'Swarm',
      editorTabWidth: 4,
    };
    const migrated = migrateAppearance(v1, 1);

    expect(migrated.themes).toEqual({});
    expect(migrated.activeThemeId).toBe('hive');
    expect(migrated.theme).toBe('light');
    expect(migrated.density).toBe('compact');
    expect(migrated.teamName).toBe('Swarm');
    expect(migrated.editorTabWidth).toBe(4);
  });

  /**
   * "Already at v2" is not "already trustworthy": a v2 payload has been
   * writable by anything holding a `localStorage` handle since the day the
   * field existed, and this used to copy `themes` through verbatim.
   */
  it('re-checks the library even when there is no version to migrate', () => {
    const migrated = migrateAppearance(
      { themes: { nord: { hiveThemeVersion: 1, name: 'Nord' } }, activeThemeId: 'nord' },
      3,
    );

    expect(migrated.themes).toEqual({});
    expect(migrated.activeThemeId).toBe('hive');
  });
});

/**
 * The editor becomes editable by default, and the point of the migration is
 * that a default change alone reaches nobody who already has the app: the
 * persist middleware writes the whole partialized state on the first save of
 * anything, so `editorEditable: false` is on disk for almost every install.
 */
describe('the v2 → v3 migration', () => {
  it('drops a stored editorEditable so the new default applies', () => {
    const migrated = migrateAppearance(
      { theme: 'light', editorEditable: false, editorTabWidth: 4 },
      2,
    );

    // Absent, not `true` — the default lives in `initialAppearanceState` and
    // this must not become a second copy of it.
    expect(migrated).not.toHaveProperty('editorEditable');
    expect(migrated.theme).toBe('light');
    expect(migrated.editorTabWidth).toBe(4);
  });

  it('drops it from a v1 payload too, on the way through', () => {
    const migrated = migrateAppearance(
      { theme: 'dark', editorEditable: false },
      1,
    );

    expect(migrated).not.toHaveProperty('editorEditable');
    expect(migrated.themes).toEqual({});
  });

  it('leaves a v3 payload alone, editorEditable included', () => {
    // Past the migration, the toggle is the user's again — including off.
    const migrated = migrateAppearance({ editorEditable: false }, 3);

    expect(migrated.editorEditable).toBe(false);
  });
});

describe('sanitizeThemeState', () => {
  it('keeps a whole theme and the id pointing at it', () => {
    expect(
      sanitizeThemeState({ themes: { nord: nordFixture }, activeThemeId: 'nord' }),
    ).toEqual({ themes: { nord: nordFixture }, activeThemeId: 'nord' });
  });

  it('leaves an explicit built-in id alone even with nothing imported', () => {
    expect(sanitizeThemeState({ themes: {}, activeThemeId: 'hive' })).toEqual({
      themes: {},
      activeThemeId: 'hive',
    });
  });

  it('returns the built-in for a state with no theme fields at all', () => {
    expect(sanitizeThemeState({})).toEqual({ themes: {}, activeThemeId: 'hive' });
  });

  it.each(['honeycomb', 'graphite', 'tidewater', 'terracotta', 'porcelain', 'cinder'])(
    'keeps %s, which is shipped rather than imported',
    (id) => {
      expect(sanitizeThemeState({ themes: {}, activeThemeId: id })).toEqual({
        themes: {},
        activeThemeId: id,
      });
    },
  );

  it('still rejects an id that is neither shipped nor in the library', () => {
    expect(sanitizeThemeState({ themes: {}, activeThemeId: 'nord' })).toEqual({
      themes: {},
      activeThemeId: 'hive',
    });
  });

  /**
   * `localStorage` is reachable by another tab, devtools and an older build,
   * and `'toString' in BUILT_IN_THEMES` is `true` for any object literal — the
   * lookup then yields `Object.prototype.toString`, a function, so a `??`
   * guard never fires. That used to survive sanitising, reach
   * `applyThemeColors` and the terminal-palette selector, and throw on
   * `.modes` on every render, with the bad value still in storage.
   */
  it.each(['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__'])(
    'refuses %s as an active id',
    (key) => {
      expect(sanitizeThemeState({ themes: {}, activeThemeId: key })).toEqual({
        themes: {},
        activeThemeId: 'hive',
      });
      expect(
        activeThemeOf({ themes: {}, activeThemeId: key }),
      ).toBeNull();
    },
  );

  /**
   * Before the shipped set landed, only `hive` was reserved — so a theme
   * imported as "Graphite" legitimately took the key `graphite`. A built-in
   * owns that key now, and built-ins resolve first, so without this repair the
   * person's own theme is unreachable and the gallery rings two cards active.
   */
  it('moves a library theme aside when a shipped id took its key', () => {
    const result = sanitizeThemeState({
      themes: { graphite: nordFixture },
      activeThemeId: 'graphite',
    });

    expect(result.themes).toEqual({ 'graphite-2': nordFixture });
    // The active pointer follows: that theme is what was on screen, and the
    // shipped Graphite is not a substitute for it.
    expect(result.activeThemeId).toBe('graphite-2');
  });

  it('leaves a non-colliding library theme exactly where it is', () => {
    const result = sanitizeThemeState({
      themes: { nord: nordFixture },
      activeThemeId: 'nord',
    });

    expect(result.themes).toEqual({ nord: nordFixture });
    expect(result.activeThemeId).toBe('nord');
  });

  it('keeps a shipped id active when nothing in the library claims it', () => {
    const result = sanitizeThemeState({ themes: {}, activeThemeId: 'graphite' });
    expect(result).toEqual({ themes: {}, activeThemeId: 'graphite' });
  });
});

describe('rail collapse', () => {
  it('starts expanded on both sides', () => {
    const state = useAppearanceStore.getState();
    expect(state.railCollapsedLeft).toBe(false);
    expect(state.railCollapsedRight).toBe(false);
  });

  it('toggles one side and leaves the other alone', () => {
    useAppearanceStore.getState().toggleRailCollapsed('left');

    expect(useAppearanceStore.getState().railCollapsedLeft).toBe(true);
    expect(useAppearanceStore.getState().railCollapsedRight).toBe(false);
  });

  it('sets a side explicitly', () => {
    useAppearanceStore.getState().setRailCollapsed('right', true);
    expect(useAppearanceStore.getState().railCollapsedRight).toBe(true);

    useAppearanceStore.getState().setRailCollapsed('right', false);
    expect(useAppearanceStore.getState().railCollapsedRight).toBe(false);
  });

  it('clears the flag when a width is written to the same side', () => {
    // Drag-to-expand calls only `setRailWidth`. Clearing here is what
    // makes that one call enough, and what stops the width and the flag
    // from ever disagreeing.
    useAppearanceStore.getState().setRailCollapsed('left', true);
    useAppearanceStore.getState().setRailWidth('left', 360);

    expect(useAppearanceStore.getState().railCollapsedLeft).toBe(false);
    expect(useAppearanceStore.getState().railWidthLeft).toBe(360);
  });

  it('does not clear the flag on the other side', () => {
    useAppearanceStore.getState().setRailCollapsed('right', true);
    useAppearanceStore.getState().setRailWidth('left', 360);

    expect(useAppearanceStore.getState().railCollapsedRight).toBe(true);
  });

  it('leaves the flag alone when the width is reset', () => {
    // "Go back to the default width" is a statement about width. A
    // collapsed rail has no width opinion to reset.
    useAppearanceStore.getState().setRailCollapsed('left', true);
    useAppearanceStore.getState().resetRailWidth('left');

    expect(useAppearanceStore.getState().railCollapsedLeft).toBe(true);
  });

  it('restores both to expanded on reset', () => {
    useAppearanceStore.getState().toggleRailCollapsed('left');
    useAppearanceStore.getState().toggleRailCollapsed('right');
    useAppearanceStore.getState().reset();

    expect(useAppearanceStore.getState().railCollapsedLeft).toBe(false);
    expect(useAppearanceStore.getState().railCollapsedRight).toBe(false);
  });
});

describe('rail collapse migration', () => {
  it('migrateAppearance passes unknown-key-absence through untouched', () => {
    // Documents the input to the real pipeline exercised below: a v3 payload
    // written before collapse existed simply has no opinion on the flag.
    const migrated = migrateAppearance({ density: 'comfortable' }, 3);
    expect(migrated.railCollapsedLeft).toBeUndefined();
  });

  it('reads a v3 payload written before collapse existed as expanded', async () => {
    // The regression this guards: the persist `merge` option spreads
    // `currentState` before the persisted payload, so a payload that lacks
    // `railCollapsedLeft`/`railCollapsedRight` (as every payload written
    // before this feature existed does) must fall back to `initialAppearanceState`'s
    // `false` — not to `undefined`, which would render a strip on first
    // launch for every existing user. This goes through the actual `persist`
    // rehydration path (matching the store's current `version: 3`, so no
    // `migrate` branch runs — only `merge`) rather than reimplementing it.
    localStorage.setItem(
      APPEARANCE_STORAGE_KEY,
      JSON.stringify({
        version: 3,
        state: {
          density: 'compact',
        },
      }),
    );

    vi.resetModules();
    const { useAppearanceStore: store } = await import('@stores/appearance-store');

    expect(store.getState().railCollapsedLeft).toBe(false);
    expect(store.getState().railCollapsedRight).toBe(false);
  });
});
