import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
   * The mark is the live hive (HIVE-100).
   *
   * This test used to assert the opposite — that the corner showed
   * `hive-tile.png`, the app icon minus its prompt line, so that top-left and
   * dock could not drift apart. That invariant was **deliberately retired**,
   * not broken: the corner of a swarm command centre should do the thing the
   * app is named for. The dock icon is untouched and still cut from the master
   * by `scripts/icon/generate-app-icon.py`; it simply is no longer this image.
   *
   * Asserted through `SwarmCreature`'s own `data-creature` rather than a file
   * name, because the point is that the header draws the *same sprite* as the
   * seven other surfaces — a second copy of the asset would satisfy a `src`
   * check and defeat the reason for going through the component.
   */
  it('draws the shared hive sprite, not a baked tile', () => {
    const { container } = render(<BrandBlock />);
    const mark = container.querySelector('img');

    expect(mark).toHaveAttribute('data-creature', 'hive');
    expect(mark?.getAttribute('src')).not.toBe('/hive-tile.png');
  });

  /**
   * The mark carries its own colour. It used to be a `bg-brand-fill-strong`
   * div, chosen over `bg-brand` because `--cc-brand` is a text colour that
   * flips per theme and a logo must not. A raster sprite keeps that guarantee,
   * so what needs asserting now is that nothing tints or resizes it.
   *
   * 34px is the header register `SwarmCreature` documents — below the rails'
   * 44px, because this is the one call site that is never an empty state and
   * competes with the terminal on every screen.
   */
  it('renders at its 34px header slot with no theme-dependent fill behind it', () => {
    const { container } = render(<BrandBlock />);

    const mark = container.querySelector('img');
    expect(mark).toHaveStyle({ height: '34px' });
    expect(mark?.parentElement?.className).not.toMatch(/\bbg-/);
  });

  /**
   * The whole point of routing through `SwarmCreature`: the header inherits the
   * reduced-motion fallback rather than reimplementing it. Under the preference
   * the mark is a single-frame file — still there, simply holding still.
   */
  it('holds still when the user asked for reduced motion', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        matches: true,
        media: '(prefers-reduced-motion: reduce)',
        addEventListener: () => {},
        removeEventListener: () => {},
      })),
    );

    const { container } = render(<BrandBlock />);

    expect(container.querySelector('img')?.getAttribute('src')).toMatch(
      /hive-still/,
    );

    vi.unstubAllGlobals();
  });
});
