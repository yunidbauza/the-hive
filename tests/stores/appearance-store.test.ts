import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BUILT_IN_THEME } from '@lib/theme/built-in';
import { type HiveTheme } from '@lib/theme/contract';
import {
  APPEARANCE_STORAGE_KEY,
  DEFAULT_TEAM_NAME,
  activeThemeOf,
  migrateAppearance,
  resolveTheme,
  sanitizeThemeState,
  useAppearanceStore,
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
      teamName: 'Swarm Command',
      editorPlacement: 'full',
      editorSplitAxis: 'vertical',
      editorSplitRatio: 0.5,
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
});
