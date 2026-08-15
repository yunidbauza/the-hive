import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ThemeGallery } from '@features/settings/components/theme-gallery';
import { BUILT_IN_THEME } from '@lib/theme/built-in';
import { PickThemeFailure, pickThemeFile, saveThemeFile } from '@lib/theme/files';
import { themeToJson } from '@lib/theme/template';
import { useAppearanceStore } from '@stores/appearance-store';

// `importOriginal` keeps the real `PickThemeFailure` (and `sanitizeFileName`,
// unused here but harmless) so a rejection built with `new PickThemeFailure(...)`
// below is the exact class the component's `instanceof` check expects — only
// `pickThemeFile` and `saveThemeFile` are swapped for controllable stubs.
vi.mock('@lib/theme/files', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lib/theme/files')>();
  return { ...actual, pickThemeFile: vi.fn(), saveThemeFile: vi.fn() };
});

const nordJson = themeToJson({
  ...BUILT_IN_THEME,
  name: 'Nord',
  author: 'Arctic Ice Studio',
  version: '1.0.0',
});

describe('ThemeGallery', () => {
  beforeEach(() => {
    localStorage.clear();
    useAppearanceStore.getState().reset();
    vi.mocked(pickThemeFile).mockReset();
    vi.mocked(saveThemeFile).mockReset();
  });

  it('always shows the built-in, three across', () => {
    render(<ThemeGallery />);
    expect(screen.getByRole('button', { name: /Hive/ })).toBeInTheDocument();
  });

  it('imports a picked file and activates it', async () => {
    vi.mocked(pickThemeFile).mockResolvedValue({
      name: 'nord.json',
      contents: nordJson,
    });

    render(<ThemeGallery />);
    await userEvent.click(screen.getByRole('button', { name: 'Import theme…' }));

    expect(
      await screen.findByText('Nord imported and activated'),
    ).toBeInTheDocument();
    expect(useAppearanceStore.getState().activeThemeId).not.toBe('hive');
  });

  it('reports a bad file and changes nothing', async () => {
    vi.mocked(pickThemeFile).mockResolvedValue({
      name: 'midnight.json',
      contents: '{"hiveThemeVersion":1,"modes":{"dark":{}}}',
    });

    render(<ThemeGallery />);
    await userEvent.click(screen.getByRole('button', { name: 'Import theme…' }));

    expect(
      await screen.findByText("Couldn't import midnight.json"),
    ).toBeInTheDocument();
    expect(useAppearanceStore.getState().activeThemeId).toBe('hive');
  });

  it('reports a rejected pick (oversize file) rather than treating it as a cancel', async () => {
    vi.mocked(pickThemeFile).mockRejectedValue(
      new PickThemeFailure('the file is 300 KB, over the 256 KB limit.'),
    );

    render(<ThemeGallery />);
    await userEvent.click(screen.getByRole('button', { name: 'Import theme…' }));

    expect(
      await screen.findByText("Couldn't import that file"),
    ).toBeInTheDocument();
    // The title and the detail render once each — not the title baked a
    // second time into the detail line underneath it.
    expect(
      screen.getByText('the file is 300 KB, over the 256 KB limit.'),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/Couldn't import that file/)).toHaveLength(1);
    expect(useAppearanceStore.getState().activeThemeId).toBe('hive');
  });

  it('a cancelled pick changes nothing and shows no banner', async () => {
    vi.mocked(pickThemeFile).mockResolvedValue(null);

    render(<ThemeGallery />);
    await userEvent.click(screen.getByRole('button', { name: 'Import theme…' }));

    // Let any pending microtasks settle before asserting the negative.
    await Promise.resolve();

    expect(screen.queryByText(/imported/i)).toBeNull();
    expect(useAppearanceStore.getState().activeThemeId).toBe('hive');
  });

  it('hands out a template that is a real theme', async () => {
    render(<ThemeGallery />);
    await userEvent.click(
      screen.getByRole('button', { name: 'Download template' }),
    );
    expect(vi.mocked(saveThemeFile)).toHaveBeenCalledWith(
      'hive-theme-template.json',
      expect.stringContaining('"hiveThemeVersion": 1'),
    );
  });

  it('de-duplicates the id when two imports share a name', async () => {
    vi.mocked(pickThemeFile).mockResolvedValue({
      name: 'nord.json',
      contents: nordJson,
    });

    render(<ThemeGallery />);
    await userEvent.click(screen.getByRole('button', { name: 'Import theme…' }));
    await screen.findByText('Nord imported and activated');

    await userEvent.click(screen.getByRole('button', { name: 'Import theme…' }));
    await screen.findByText('Nord imported and activated');

    expect(Object.keys(useAppearanceStore.getState().themes)).toEqual([
      'nord',
      'nord-2',
    ]);
    expect(useAppearanceStore.getState().activeThemeId).toBe('nord-2');
  });

  it('exports a card by its assigned id, never by the built-in id', async () => {
    vi.mocked(pickThemeFile).mockResolvedValue({
      name: 'nord.json',
      contents: nordJson,
    });

    render(<ThemeGallery />);
    await userEvent.click(screen.getByRole('button', { name: 'Import theme…' }));
    await screen.findByText('Nord imported and activated');

    const menus = screen.getAllByRole('button', { name: 'Theme actions' });
    // Built-in first, the freshly imported Nord card second.
    await userEvent.click(menus[1]);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Export…' }));

    expect(vi.mocked(saveThemeFile)).toHaveBeenCalledWith(
      'nord.json',
      expect.stringContaining('"name": "Nord"'),
    );
  });

  it('exports the built-in theme too, under its own id', async () => {
    render(<ThemeGallery />);
    await userEvent.click(screen.getByRole('button', { name: 'Theme actions' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Export…' }));

    expect(vi.mocked(saveThemeFile)).toHaveBeenCalledWith(
      'hive.json',
      expect.stringContaining('"name": "Hive"'),
    );
  });

  it('reports a rejection that is not an Error instance', async () => {
    vi.mocked(pickThemeFile).mockRejectedValue('not an Error');

    render(<ThemeGallery />);
    await userEvent.click(screen.getByRole('button', { name: 'Import theme…' }));

    expect(
      await screen.findByText("Couldn't import that file"),
    ).toBeInTheDocument();
    expect(screen.getByText('not an Error')).toBeInTheDocument();
  });

  it('falls back to a plain id when the name has nothing sluggable', async () => {
    const symbolNamedJson = themeToJson({ ...BUILT_IN_THEME, name: '★★★' });
    vi.mocked(pickThemeFile).mockResolvedValue({
      name: 'symbols.json',
      contents: symbolNamedJson,
    });

    render(<ThemeGallery />);
    await userEvent.click(screen.getByRole('button', { name: 'Import theme…' }));
    await screen.findByText('★★★ imported and activated');

    expect(Object.keys(useAppearanceStore.getState().themes)).toEqual(['theme']);
  });

  /**
   * `zustand/persist` calls `setItem` **synchronously inside `set`**, so a
   * `QuotaExceededError` propagates straight out of `addTheme` — through
   * `onImport`, whose `try/finally` had no `catch`, and out of `void
   * onImport()` at the call site as an unhandled rejection. No banner, no
   * activation, and the in-memory store already mutated: the gallery showed a
   * theme storage never took.
   */
  it('surfaces a banner when storage refuses the write', async () => {
    vi.mocked(pickThemeFile).mockResolvedValue({
      name: 'nord.json',
      contents: nordJson,
    });
    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });

    try {
      render(<ThemeGallery />);
      await userEvent.click(screen.getByRole('button', { name: 'Import theme…' }));

      expect(await screen.findByText("Couldn't save Nord")).toBeInTheDocument();
      expect(screen.getByText(/no room left to store it/)).toBeInTheDocument();
      // Rolled back, so what the gallery shows is what storage holds.
      expect(useAppearanceStore.getState().themes).toEqual({});
      expect(useAppearanceStore.getState().activeThemeId).toBe('hive');
    } finally {
      setItem.mockRestore();
    }
  });

  /**
   * A theme's `name` is untrusted text from a file that may be 256 KB, and
   * the slug becomes a `localStorage` key — so an unbounded one let a single
   * import spend the whole quota on a key.
   */
  it('bounds the id it derives from an absurd name', async () => {
    const longNamed = themeToJson({ ...BUILT_IN_THEME, name: 'n'.repeat(200_000) });
    vi.mocked(pickThemeFile).mockResolvedValue({
      name: 'long.json',
      contents: longNamed,
    });

    render(<ThemeGallery />);
    await userEvent.click(screen.getByRole('button', { name: 'Import theme…' }));

    await vi.waitFor(() =>
      expect(Object.keys(useAppearanceStore.getState().themes)).toHaveLength(1),
    );
    const [id] = Object.keys(useAppearanceStore.getState().themes);
    expect(id.length).toBeLessThanOrEqual(48);
  });

  it('dismissing the banner clears it', async () => {
    vi.mocked(pickThemeFile).mockResolvedValue({
      name: 'nord.json',
      contents: nordJson,
    });

    render(<ThemeGallery />);
    await userEvent.click(screen.getByRole('button', { name: 'Import theme…' }));
    await screen.findByText('Nord imported and activated');

    await userEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(screen.queryByText('Nord imported and activated')).toBeNull();
  });
});
