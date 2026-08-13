import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { BrandBlock } from '@components/layout/brand-block';

describe('BrandBlock', () => {
  it('renders the wordmark and the eyebrow', () => {
    render(<BrandBlock />);

    expect(screen.getByText('The Hive')).toBeInTheDocument();
    expect(screen.getByText('APFM Engineering')).toBeInTheDocument();
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
