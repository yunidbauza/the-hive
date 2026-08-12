import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { BrandBlock } from '@components/layout/brand-block';

describe('BrandBlock', () => {
  it('renders the wordmark and the eyebrow', () => {
    render(<BrandBlock />);

    expect(screen.getByText('The Hive')).toBeInTheDocument();
    expect(screen.getByText('APFM Engineering')).toBeInTheDocument();
  });

  it('hides the mark from screen readers — the wordmark already says it', () => {
    const { container } = render(<BrandBlock />);

    const mark = container.querySelector('img');
    expect(mark).toHaveAttribute('src', '/hive-mark.png');
    expect(mark).toHaveAttribute('aria-hidden', 'true');
    expect(mark).toHaveAttribute('alt', '');
  });

  /**
   * `bg-brand` would repaint the tile pale blue in dark mode — `--cc-brand` is
   * a text colour and flips per theme. The logo must not.
   */
  it('paints the tile with the theme-invariant brand fill', () => {
    const { container } = render(<BrandBlock />);

    const tile = container.querySelector('img')?.parentElement;
    expect(tile).toHaveClass('bg-brand-fill-strong');
  });
});
