import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DECLINED_BACK_MS,
  useDeclinedBack,
} from '@/hooks/use-declined-back';
import {
  TERMINAL_CHORD_EVENT,
  type TerminalChordDetail,
} from '@lib/terminal/keymap';

/**
 * The app's half of the declined-`←` announcement (HIVE-79).
 *
 * Fake timers throughout — the rule for anything time-based in this suite, and
 * doubly so here: the whole behaviour under test is "true, then false four
 * seconds later", and a real wait would put four seconds on every run to prove
 * something a fake clock proves instantly.
 */
function announce(chord: TerminalChordDetail['chord']) {
  act(() => {
    window.dispatchEvent(
      new CustomEvent(TERMINAL_CHORD_EVENT, {
        detail: { chord } satisfies TerminalChordDetail,
      }),
    );
  });
}

describe('useDeclinedBack', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts quiet', () => {
    const { result } = renderHook(() => useDeclinedBack('sess-01'));
    expect(result.current).toBe(false);
  });

  it('raises on a declined bare ←', () => {
    const { result } = renderHook(() => useDeclinedBack('sess-01'));
    announce('back-declined');
    expect(result.current).toBe(true);
  });

  it('ignores the chord that navigates', () => {
    /**
     * `back` is a claim the app *won* — the stage is already navigating away
     * from this terminal. A strip saying "← went to the session" over a
     * successful departure would be describing the opposite of what happened.
     */
    const { result } = renderHook(() => useDeclinedBack('sess-01'));
    announce('back');
    expect(result.current).toBe(false);
  });

  it('falls quiet again on its own', () => {
    const { result } = renderHook(() => useDeclinedBack('sess-01'));
    announce('back-declined');

    act(() => {
      vi.advanceTimersByTime(DECLINED_BACK_MS - 1);
    });
    expect(result.current).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(false);
  });

  it('re-arms rather than flickering when the key is held down', () => {
    /**
     * The bug a boolean would have. `true -> true` is not a state change, so a
     * second decline would not restart the timer and the strip would vanish on
     * the *first* one's clock — mid-keypress, while the user is still pressing
     * the key it is explaining.
     */
    const { result } = renderHook(() => useDeclinedBack('sess-01'));
    announce('back-declined');

    act(() => {
      vi.advanceTimersByTime(DECLINED_BACK_MS - 100);
    });
    announce('back-declined');

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current).toBe(true);

    act(() => {
      vi.advanceTimersByTime(DECLINED_BACK_MS);
    });
    expect(result.current).toBe(false);
  });

  it('goes quiet when the user leaves the terminal that raised it', () => {
    /**
     * Otherwise the strip outlives its subject: press `←` with a half-written
     * message, leave with `⌘[`, and it follows the user to the overmind — where
     * it advises pressing `⌘[` to reach the overmind. Same on the way to
     * another session, describing a terminal they are no longer looking at.
     */
    const { result, rerender } = renderHook(
      ({ surface }: { surface: string | null }) => useDeclinedBack(surface),
      { initialProps: { surface: 'sess-01' as string | null } },
    );
    announce('back-declined');
    expect(result.current).toBe(true);

    rerender({ surface: 'orch' });
    expect(result.current).toBe(false);
  });

  it('stops listening when it goes away', () => {
    const { result, unmount } = renderHook(() => useDeclinedBack('sess-01'));
    unmount();

    // No act() wrapper: nothing should be listening, so nothing should update.
    window.dispatchEvent(
      new CustomEvent(TERMINAL_CHORD_EVENT, {
        detail: { chord: 'back-declined' } satisfies TerminalChordDetail,
      }),
    );
    expect(result.current).toBe(false);
  });
});
