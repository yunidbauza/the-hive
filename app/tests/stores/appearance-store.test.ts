import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  APPEARANCE_STORAGE_KEY,
  resolveTheme,
  useAppearanceStore,
  watchSystemTheme,
} from '@stores/appearance-store';

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
      editorPlacement: 'full',
      editorSplitAxis: 'vertical',
      editorSplitRatio: 0.5,
      editorNav: 'tabs',
      editorEditable: false,
      editorFont: 'system',
      editorFontSize: 13,
      editorWordWrap: true,
      editorLineNumbers: true,
      editorTabWidth: 2,
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
    expect(state.editorEditable).toBe(false);
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
    store.setEditorEditable(true);
    store.setEditorTabWidth(8);

    useAppearanceStore.getState().reset();

    expect(useAppearanceStore.getState()).toMatchObject({
      editorPlacement: 'full',
      editorEditable: false,
      editorTabWidth: 2,
    });
  });
});
