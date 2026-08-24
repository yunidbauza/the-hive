import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionBootCover } from '@features/sessions/components/session-boot-cover';
import { PHRASES } from '@lib/swarm/phrases';

/**
 * What a session shows while its shell boots (HIVE-101).
 *
 * `matchMedia` is not implemented in happy-dom, so anything reaching
 * `useReducedMotion` has to install one — see `swarm-creature.test.tsx`, whose
 * stub this mirrors.
 */
function stubMatchMedia(matches: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches,
      media: '(prefers-reduced-motion: reduce)',
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('SessionBootCover', () => {
  it('shows the hydralisk — the unit that does the work', () => {
    stubMatchMedia(false);
    const { container } = render(<SessionBootCover />);

    expect(container.querySelector('[data-creature]')).toHaveAttribute(
      'data-creature',
      'hydralisk',
    );
  });

  it('draws a line from the session pool', () => {
    stubMatchMedia(false);
    render(<SessionBootCover />);

    const cover = screen.getByTestId('session-boot-cover');
    const shown = PHRASES['loading.session'].filter((phrase) =>
      cover.textContent?.includes(phrase),
    );

    expect(shown).toHaveLength(1);
  });

  /**
   * The way out, written where somebody staring at a hydralisk for longer than
   * they expected will read it.
   *
   * Not decoration: a session whose `claude` never starts has its error in the
   * terminal *underneath this*, and the sixty-second timeout is a long time to
   * withhold it. This sentence is what makes that timeout defensible.
   */
  it('says how to get to the terminal underneath', () => {
    stubMatchMedia(false);
    render(<SessionBootCover />);

    expect(
      screen.getByText('press any key to watch it boot'),
    ).toBeInTheDocument();
  });

  /**
   * The line is announced once, and its changes are not: a phrase that
   * re-reads itself every four seconds is a screen reader talking over whatever
   * the user is doing.
   */
  it('announces the wait politely rather than assertively', () => {
    stubMatchMedia(false);
    render(<SessionBootCover />);

    const cover = screen.getByTestId('session-boot-cover');
    expect(cover.querySelector('[aria-live]')).toHaveAttribute(
      'aria-live',
      'polite',
    );
  });

  it('covers the terminal completely rather than floating over part of it', () => {
    stubMatchMedia(false);
    render(<SessionBootCover />);

    const cover = screen.getByTestId('session-boot-cover');
    /*
      `inset-0` over a `relative` parent, and an opaque terminal ground: the
      terminal underneath stays mounted and laid out, because xterm cannot
      measure a cell in a box with no layout.
    */
    expect(cover).toHaveClass('absolute', 'inset-0', 'bg-term-bg');
    /*
      And takes no pointer events: a click while the cover is up belongs to the
      terminal underneath and lands there, rather than being swallowed by a
      panel the user cannot tell from a hang.
    */
    expect(cover).toHaveClass('pointer-events-none');
  });

  it('holds one line still when the user asked for reduced motion', () => {
    stubMatchMedia(true);
    vi.useFakeTimers();
    render(<SessionBootCover />);

    const before = screen.getByTestId('session-boot-cover').textContent;
    vi.advanceTimersByTime(60_000);

    expect(screen.getByTestId('session-boot-cover').textContent).toBe(before);
  });
});
