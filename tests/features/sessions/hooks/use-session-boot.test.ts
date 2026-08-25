import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BOOT_COVER_TIMEOUT_MS,
  useSessionBoot,
} from '@features/sessions/hooks/use-session-boot';
import { useHiveStore } from '@stores/hive-store';

/**
 * The two ways out of the boot cover that do not come from Claude (HIVE-101).
 *
 * The ready signal has its own tests, in the receiver and in
 * `use-session-status`. These are the fallbacks, and they matter more than the
 * happy path does: a cover that outlives the thing it is covering is worse than
 * the noise it replaced, because a session whose `claude` is missing or wedged
 * has its explanation sitting in the terminal *underneath* it.
 */
describe('useSessionBoot', () => {
  beforeEach(() => {
    useHiveStore.getState().reset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** A session in the state a fresh spawn leaves it in. */
  const booting = (id = 'sess-01') => {
    act(() => {
      useHiveStore.setState((state) => ({
        entities: {
          ...state.entities,
          [id]: {
            kind: 'session',
            id,
            project: 'nova-web',
            status: 'idle',
            task: '',
            cost: '$0.00',
            lines: [],
            booting: true,
          },
        },
        order: [...state.order, id],
      }));
    });
    return id;
  };

  it('covers a session that is still starting', () => {
    const id = booting();
    const { result } = renderHook(() => useSessionBoot(id));

    expect(result.current).toBe(true);
  });

  it('covers nothing when no session is on screen', () => {
    const { result } = renderHook(() => useSessionBoot(null));

    expect(result.current).toBe(false);
  });

  it('covers nothing for a session that never reported booting', () => {
    // Every row that existed before this feature, and every restored one.
    act(() => {
      useHiveStore.setState((state) => ({
        entities: {
          ...state.entities,
          'sess-old': {
            kind: 'session',
            id: 'sess-old',
            project: 'nova-web',
            status: 'idle',
            task: '',
            cost: '$0.00',
            lines: [],
          },
        },
      }));
    });

    const { result } = renderHook(() => useSessionBoot('sess-old'));

    expect(result.current).toBe(false);
  });

  /**
   * The backstop for a session that never reports. Without it, a missing
   * `claude` shows a cheerful hydralisk forever and the error explaining why is
   * hidden behind it.
   */
  it('lifts itself when the boot times out', () => {
    const id = booting();
    const { result, rerender } = renderHook(() => useSessionBoot(id));
    expect(result.current).toBe(true);

    act(() => {
      vi.advanceTimersByTime(BOOT_COVER_TIMEOUT_MS);
    });
    rerender();

    expect(result.current).toBe(false);
  });

  it('holds until the timeout actually elapses', () => {
    const id = booting();
    const { result, rerender } = renderHook(() => useSessionBoot(id));

    act(() => {
      vi.advanceTimersByTime(BOOT_COVER_TIMEOUT_MS - 1);
    });
    rerender();

    expect(result.current).toBe(true);
  });

  /**
   * The escape a user can actually find — and the reason the timeout is allowed
   * to be as long as a minute. The cover says this in as many words.
   */
  it('lifts on the first keystroke', () => {
    const id = booting();
    const { result, rerender } = renderHook(() => useSessionBoot(id));

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    });
    rerender();

    expect(result.current).toBe(false);
  });

  /**
   * The bug that made this feature invisible to anyone using the keyboard.
   *
   * The picker commits on **Enter**. React flushes that discrete update and
   * runs the cover's effect *while the keydown is still propagating*, so the
   * listener is registered before the event finishes reaching `window` — and
   * the very key that started the session dismissed its cover. Mouse-started
   * sessions were unaffected, which is what made it look like a flake.
   *
   * Reproduced here by constructing the event *before* the hook mounts, which
   * is exactly the ordering the real dispatch produces: a key whose `timeStamp`
   * predates the cover is a key that was pressed at something else.
   */
  it('ignores the keystroke that raised it', () => {
    /*
      Real timers here alone: the guard compares `event.timeStamp` against
      `performance.now()`, and the fake clock moves one of those two and not
      the other — which would make this pass or fail for a reason that has
      nothing to do with the rule.
    */
    vi.useRealTimers();

    const id = booting();
    const earlier = new KeyboardEvent('keydown', { key: 'Enter' });

    const { result, rerender } = renderHook(() => useSessionBoot(id));
    act(() => {
      window.dispatchEvent(earlier);
    });
    rerender();

    expect(result.current).toBe(true);
  });

  /**
   * Capture, not bubble — the other half of the same escape.
   *
   * The terminal underneath keeps focus while the cover is up, deliberately, so
   * the user's first character reaches the pty. xterm stops the keydown at its
   * own textarea, so a bubble-phase listener on `window` never ran in the real
   * app and the escape existed only in tests that dispatched on `window`
   * directly. This asserts the flag rather than the behaviour, because
   * happy-dom has no xterm to be silenced by.
   */
  it('listens in the capture phase, where xterm cannot silence it', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const id = booting();

    renderHook(() => useSessionBoot(id));

    expect(addSpy).toHaveBeenCalledWith('keydown', expect.any(Function), true);
    addSpy.mockRestore();
  });

  /**
   * A click lands on the terminal *and* reveals it.
   *
   * The cover takes no pointer events, so the press already reaches the
   * terminal and focuses it. Without this the user would click a session into
   * focus and go on looking at a hydralisk, with nothing to distinguish the
   * cover from a hang.
   */
  it('lifts on a pointer press as well as a key', () => {
    vi.useRealTimers();
    const id = booting();
    const { result, rerender } = renderHook(() => useSessionBoot(id));

    act(() => {
      window.dispatchEvent(new Event('pointerdown'));
    });
    rerender();

    expect(result.current).toBe(false);
  });

  /**
   * A press outside the terminal is not an escape.
   *
   * Left unscoped, **Back to overmind** dismissed the cover on the way out of a
   * session — so returning to it found raw boot output where the cover should
   * have been. The rule is the one the affordance actually means: clicking
   * *through* to the terminal reveals it; clicking somewhere else is somewhere
   * else.
   */
  it('ignores a pointer press outside the terminal region', () => {
    vi.useRealTimers();
    const id = booting();

    const region = document.createElement('div');
    document.body.append(region);
    const outside = document.createElement('button');
    document.body.append(outside);

    const { result, rerender } = renderHook(() =>
      useSessionBoot(id, { current: region }),
    );

    act(() => {
      outside.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    rerender();

    expect(result.current).toBe(true);

    // And a press that *is* in the terminal still lifts it.
    act(() => {
      region.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    rerender();

    expect(result.current).toBe(false);

    region.remove();
    outside.remove();
  });

  /**
   * The listener and the timer are torn down together. A leaked `keydown`
   * would call an action for a session the shell no longer shows, and a leaked
   * timer would fire a minute after the surface went away.
   */
  it('stops listening once the cover is gone', () => {
    const id = booting();
    const { unmount } = renderHook(() => useSessionBoot(id));
    const removeSpy = vi.spyOn(window, 'removeEventListener');

    unmount();

    expect(removeSpy).toHaveBeenCalledWith(
      'keydown',
      expect.any(Function),
      true,
    );
    removeSpy.mockRestore();
  });

  /**
   * A keystroke aimed at a session that is *not* covered must not reach into
   * the store at all — the listener only exists while the cover does.
   */
  it('registers nothing while there is nothing to uncover', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');

    renderHook(() => useSessionBoot(null));

    expect(addSpy).not.toHaveBeenCalledWith(
      'keydown',
      expect.any(Function),
      true,
    );
    addSpy.mockRestore();
  });
});
