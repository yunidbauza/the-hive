import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useReducedMotion } from '@hooks/use-reduced-motion';

function Probe() {
  return <p data-testid="reduced">{String(useReducedMotion())}</p>;
}

type Listener = (event: MediaQueryListEvent) => void;

function stubMatchMedia(initial: boolean) {
  const listeners = new Set<Listener>();

  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches: initial,
      media: '(prefers-reduced-motion: reduce)',
      addEventListener: (_: string, fn: Listener) => listeners.add(fn),
      removeEventListener: (_: string, fn: Listener) => listeners.delete(fn),
    })),
  );

  return {
    change(matches: boolean) {
      for (const fn of listeners) fn({ matches } as MediaQueryListEvent);
    },
    get size() {
      return listeners.size;
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useReducedMotion', () => {
  it('reads the preference at mount', () => {
    stubMatchMedia(true);
    render(<Probe />);

    expect(screen.getByTestId('reduced')).toHaveTextContent('true');
  });

  it('reports no preference when the query does not match', () => {
    stubMatchMedia(false);
    render(<Probe />);

    expect(screen.getByTestId('reduced')).toHaveTextContent('false');
  });

  /**
   * It is a system toggle, not a boot flag. A value read once at mount would
   * leave a creature breathing at somebody who just asked it to stop.
   */
  it('follows the preference while the app is open', () => {
    const media = stubMatchMedia(false);
    render(<Probe />);

    act(() => {
      media.change(true);
    });

    expect(screen.getByTestId('reduced')).toHaveTextContent('true');
  });

  it('unsubscribes on unmount', () => {
    const media = stubMatchMedia(false);
    const { unmount } = render(<Probe />);

    expect(media.size).toBe(1);
    unmount();

    expect(media.size).toBe(0);
  });

  /**
   * Absence is treated as "no preference", so a environment without matchMedia
   * gets the animated path rather than silently asserting the fallback.
   */
  it('defaults to motion when matchMedia is missing', () => {
    vi.stubGlobal('matchMedia', undefined);
    render(<Probe />);

    expect(screen.getByTestId('reduced')).toHaveTextContent('false');
  });
});
