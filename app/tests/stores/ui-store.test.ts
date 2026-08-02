import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useUiStore } from '@stores/ui-store';

/**
 * Reference pattern for store tests (story 013): call the action against a
 * fresh store and assert the resulting state. No React involved — the stores
 * are plain functions and are the highest-value target in the repo.
 */
describe('ui-store — theme', () => {
  beforeEach(() => {
    document.body.removeAttribute('data-theme');
    useUiStore.setState({ theme: 'dark' });
  });

  it('defaults to dark', () => {
    expect(useUiStore.getState().theme).toBe('dark');
  });

  it('toggleTheme flips dark to light and writes data-theme to the body', () => {
    useUiStore.getState().toggleTheme();

    expect(useUiStore.getState().theme).toBe('light');
    expect(document.body.getAttribute('data-theme')).toBe('light');
  });

  it('toggleTheme flips back to dark and removes the attribute', () => {
    const { toggleTheme } = useUiStore.getState();

    toggleTheme();
    toggleTheme();

    expect(useUiStore.getState().theme).toBe('dark');
    // Dark is the default and carries no attribute, so the :root block in
    // tokens.css applies unmodified.
    expect(document.body.hasAttribute('data-theme')).toBe(false);
  });

  it('setTheme is idempotent', () => {
    const { setTheme } = useUiStore.getState();

    setTheme('light');
    setTheme('light');

    expect(useUiStore.getState().theme).toBe('light');
    expect(document.body.getAttribute('data-theme')).toBe('light');
  });
});

describe('ui-store — theme without a DOM', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('tracks theme state even when there is no document to write to', async () => {
    vi.resetModules();
    vi.stubGlobal('document', undefined);

    const { useUiStore: store } = await import('@stores/ui-store');

    // Theme state is independent of the DOM: the store is the source of truth
    // and `data-theme` is only a projection of it.
    expect(() => store.getState().setTheme('light')).not.toThrow();
    expect(store.getState().theme).toBe('light');
  });
});
