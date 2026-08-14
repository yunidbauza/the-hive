import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SwarmCreature } from '@components/ui/swarm-creature';

/**
 * `matchMedia` is not implemented in happy-dom, so every test that cares about
 * it has to install one. Returning `matches` from the argument lets a test say
 * "the user asked for reduced motion" without reaching into the component.
 */
function stubMatchMedia(matches: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();

  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches,
      media: '(prefers-reduced-motion: reduce)',
      addEventListener: (_: string, fn: (event: MediaQueryListEvent) => void) =>
        listeners.add(fn),
      removeEventListener: (_: string, fn: (event: MediaQueryListEvent) => void) =>
        listeners.delete(fn),
    })),
  );

  return listeners;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SwarmCreature', () => {
  it('is hidden from assistive technology', () => {
    stubMatchMedia(false);
    render(<SwarmCreature creature="overlord" />);

    const img = screen.getByRole('presentation', { hidden: true });

    expect(img).toHaveAttribute('aria-hidden', 'true');
    expect(img).toHaveAttribute('alt', '');
  });

  it('plays the animation when motion is welcome', () => {
    stubMatchMedia(false);
    render(<SwarmCreature creature="spire" />);

    const img = screen.getByRole('presentation', { hidden: true });

    expect(img.getAttribute('src')).not.toContain('still');
  });

  /**
   * The reason this component needs JavaScript at all. Animated WebP ignores
   * `prefers-reduced-motion` — the browser plays it regardless — so honouring
   * the setting means handing the element a different file.
   */
  it('holds still when the user asked for less motion', () => {
    stubMatchMedia(true);
    render(<SwarmCreature creature="spire" />);

    expect(
      screen.getByRole('presentation', { hidden: true }).getAttribute('src'),
    ).toContain('still');
  });

  it('renders at the height it was given', () => {
    stubMatchMedia(false);
    render(<SwarmCreature creature="hive" size={120} />);

    expect(screen.getByRole('presentation', { hidden: true })).toHaveStyle({
      height: '120px',
    });
  });

  it('names which creature it is, so casting stays reviewable', () => {
    stubMatchMedia(false);
    render(<SwarmCreature creature="hive" />);

    expect(screen.getByRole('presentation', { hidden: true })).toHaveAttribute(
      'data-creature',
      'hive',
    );
  });
});
