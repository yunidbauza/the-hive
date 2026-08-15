import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ThemeGallery } from '@features/settings/components/theme-gallery';
import { BUILT_IN_THEME } from '@lib/theme/built-in';
import { pickThemeFile, saveThemeFile } from '@lib/theme/files';
import { themeToJson } from '@lib/theme/template';
import { useAppearanceStore } from '@stores/appearance-store';

vi.mock('@lib/theme/files', () => ({
  pickThemeFile: vi.fn(),
  saveThemeFile: vi.fn(),
}));

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
      new Error("Couldn't import that file — the file is 300 KB, over the 256 KB limit."),
    );

    render(<ThemeGallery />);
    await userEvent.click(screen.getByRole('button', { name: 'Import theme…' }));

    expect(
      await screen.findByText("Couldn't import that file"),
    ).toBeInTheDocument();
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
