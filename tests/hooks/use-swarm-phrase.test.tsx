import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useSwarmPhrase } from '@hooks/use-swarm-phrase';
import { PHRASES } from '@lib/swarm/phrases';

function Probe() {
  const phrase = useSwarmPhrase('empty.inbox');

  return <p data-testid="phrase">{phrase}</p>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * The hook exists for one reason: `pickPhrase()` in a render body re-rolls on
 * every render, and these surfaces re-render for reasons that have nothing to
 * do with them. Both halves of that are asserted here.
 */
describe('useSwarmPhrase', () => {
  it('draws from the pool for the key it was given', () => {
    render(<Probe />);

    expect(PHRASES['empty.inbox']).toContain(
      screen.getByTestId('phrase').textContent,
    );
  });

  it('holds the same phrase across re-renders', () => {
    /**
     * Walked through the pool on every call, so a hook that re-rolled would
     * return a *different* phrase each render rather than accidentally the
     * same one — the failure has to be visible, not probabilistic.
     */
    let call = 0;
    const pool = PHRASES['empty.inbox'];
    vi.spyOn(Math, 'random').mockImplementation(() => {
      const value = (call % pool.length) / pool.length;
      call += 1;
      return value;
    });

    const { rerender } = render(<Probe />);
    const first = screen.getByTestId('phrase').textContent;

    rerender(<Probe />);
    rerender(<Probe />);
    rerender(<Probe />);

    expect(screen.getByTestId('phrase').textContent).toBe(first);
  });

  it('draws again on remount, which is what makes it feel alive', () => {
    /**
     * Both rails unmount the inactive panel on a tab change, so this is the
     * real cadence: leaving the inbox and coming back should be able to bring
     * back a different line.
     */
    let call = 0;
    const pool = PHRASES['empty.inbox'];
    vi.spyOn(Math, 'random').mockImplementation(() => {
      const value = (call % pool.length) / pool.length;
      call += 1;
      return value;
    });

    const first = render(<Probe />);
    const before = screen.getByTestId('phrase').textContent;
    first.unmount();

    render(<Probe />);

    expect(screen.getByTestId('phrase').textContent).not.toBe(before);
  });
});
