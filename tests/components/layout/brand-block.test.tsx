import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { BrandBlock } from '@components/layout/brand-block';
import { DEFAULT_TEAM_NAME, useAppearanceStore } from '@stores/appearance-store';

describe('BrandBlock', () => {
  afterEach(() => {
    useAppearanceStore.setState({ teamName: DEFAULT_TEAM_NAME });
  });

  it('renders the wordmark and the team name under it', () => {
    render(<BrandBlock />);

    expect(screen.getByText('The Hive')).toBeInTheDocument();
    expect(screen.getByText(DEFAULT_TEAM_NAME)).toBeInTheDocument();
  });

  it('shows whatever team was set, trimmed', () => {
    useAppearanceStore.setState({ teamName: '  Zergling Battalion  ' });
    render(<BrandBlock />);

    expect(screen.getByText('Zergling Battalion')).toBeInTheDocument();
  });

  /**
   * An empty line is not rendered rather than rendered empty: a 10px span with
   * nothing in it still occupies a row, and the wordmark would sit off-centre
   * against the tile for no reason the user could see.
   */
  it('drops the line entirely when the team name is cleared', () => {
    useAppearanceStore.setState({ teamName: '   ' });
    const { container } = render(<BrandBlock />);

    expect(container.querySelectorAll('span')).toHaveLength(1);
    expect(screen.getByText('The Hive')).toBeInTheDocument();
  });

  it('hides the tile from screen readers — the wordmark already says it', () => {
    const { container } = render(<BrandBlock />);

    const tile = container.querySelector('img');
    expect(tile).toHaveAttribute('aria-hidden', 'true');
    expect(tile).toHaveAttribute('alt', '');
  });

  /**
   * The tile and the app icon are one design cut from one master
   * (`scripts/icon/generate-app-icon.py`). Pointing this back at a bare mark,
   * or at any other file, silently splits the two apart again.
   */
  it('shows the tile cut from the app icon, not a bare mark', () => {
    const { container } = render(<BrandBlock />);

    expect(container.querySelector('img')).toHaveAttribute(
      'src',
      '/hive-tile.png',
    );
  });

  /**
   * The tile carries its own colour. It used to be a `bg-brand-fill-strong`
   * div, chosen over `bg-brand` because `--cc-brand` is a text colour that
   * flips per theme and a logo must not. A baked raster keeps that guarantee,
   * so what needs asserting now is that nothing tints or resizes it.
   */
  it('renders at its 30px slot with no theme-dependent fill behind it', () => {
    const { container } = render(<BrandBlock />);

    const tile = container.querySelector('img');
    expect(tile).toHaveClass('size-[30px]');
    expect(tile?.parentElement?.className).not.toMatch(/\bbg-/);
  });
});
