import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PHRASE_ROTATION_MS,
  useRotatingPhrase,
} from '@/hooks/use-rotating-phrase';
import { PHRASES } from '@lib/swarm/phrases';

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

/**
 * The one pool in the app that changes while it is being read (HIVE-101).
 *
 * `useSwarmPhrase` exists to pick once and hold, and its docstring makes the
 * case that a flickering line is unreadable. Nothing here disagrees — what
 * differs is that the boot cover can be on screen for as long as `direnv` takes
 * on a cold environment, where one frozen line stops reading as *waiting* and
 * starts reading as *hung*.
 */
describe('useRotatingPhrase', () => {
  it('starts on a line from the pool', () => {
    stubMatchMedia(false);
    const { result } = renderHook(() => useRotatingPhrase('loading.session'));

    expect(PHRASES['loading.session']).toContain(result.current);
  });

  it('moves on once the interval elapses', () => {
    stubMatchMedia(false);
    vi.useFakeTimers();
    const { result } = renderHook(() => useRotatingPhrase('loading.session'));
    const first = result.current;

    act(() => {
      vi.advanceTimersByTime(PHRASE_ROTATION_MS);
    });

    expect(result.current).not.toBe(first);
    expect(PHRASES['loading.session']).toContain(result.current);
  });

  it('holds the line until the interval elapses', () => {
    stubMatchMedia(false);
    vi.useFakeTimers();
    const { result } = renderHook(() => useRotatingPhrase('loading.session'));
    const first = result.current;

    act(() => {
      vi.advanceTimersByTime(PHRASE_ROTATION_MS - 1);
    });

    expect(result.current).toBe(first);
  });

  /**
   * A line that changes is motion. Under the preference the user still gets a
   * phrase — the first one — for the same reason the creature beside it still
   * appears and simply holds still.
   */
  it('does not rotate at all under reduced motion', () => {
    stubMatchMedia(true);
    vi.useFakeTimers();
    const { result } = renderHook(() => useRotatingPhrase('loading.session'));
    const first = result.current;

    act(() => {
      vi.advanceTimersByTime(PHRASE_ROTATION_MS * 10);
    });

    expect(result.current).toBe(first);
  });

  /**
   * A pool of one cannot rotate, and must not spin trying. `pickPhrase` can
   * only ever return the line already on screen, so the re-roll gives up after
   * a bounded number of attempts rather than looping.
   */
  it('survives a pool with nothing else in it', () => {
    stubMatchMedia(false);
    vi.useFakeTimers();
    // `empty.agents` and friends are multi-entry; `noMatch.picker` may not be.
    const { result } = renderHook(() => useRotatingPhrase('working.session'));
    const first = result.current;

    act(() => {
      vi.advanceTimersByTime(PHRASE_ROTATION_MS * 3);
    });

    expect(typeof result.current).toBe('string');
    expect(result.current.length).toBeGreaterThan(0);
    expect(PHRASES['working.session']).toContain(first);
  });

  it('stops rotating once it is gone', () => {
    stubMatchMedia(false);
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    const { unmount } = renderHook(() => useRotatingPhrase('loading.session'));

    unmount();

    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});
