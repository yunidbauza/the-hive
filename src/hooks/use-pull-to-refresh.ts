import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Overscroll at the top of a list to force a refresh.
 *
 * ## Why the wheel and not a drag
 *
 * This is a desktop app driven by a trackpad. A two-finger scroll past the top
 * of a list already *means* "there is nothing above this" — the gesture is
 * being made anyway and currently does nothing, so it costs the user no new
 * knowledge. A press-and-drag would work for a mouse too, but it collides with
 * selecting the text inside a card, which is a thing people do to these panels.
 *
 * A mouse wheel still reaches it. The deltas arrive in coarse notches instead
 * of a continuous ramp, so it takes a few clicks rather than feeling like a
 * pull, which is a fair trade for not breaking selection.
 *
 * ## Why the scroll parent is found rather than owned
 *
 * The element that scrolls is the rail's `role="tabpanel"` wrapper, and that
 * wrapper is shared by every panel in the rail. A panel cannot be handed a ref
 * to it without the rail knowing which panels refresh — pushing a feature
 * concern into the composition root. So the panel attaches this to its own
 * root and the hook walks up to the nearest scrollable ancestor. Scoping falls
 * out for free: the listener only exists while a panel that asked for it is
 * mounted.
 *
 * ## Why a gesture-end timer
 *
 * `wheel` has no end event. Firing the moment the threshold is crossed would
 * refresh mid-gesture, while the user is still moving and before they can see
 * that they armed anything. So crossing the threshold only *arms* it, and the
 * refresh runs once the deltas stop — which is the release, as far as a wheel
 * has one.
 */

/** How far past the top before the gesture counts as a pull, in pixels. */
export const PULL_THRESHOLD = 64;

/**
 * The furthest the indicator travels. Beyond this the gesture keeps being
 * accepted but stops growing, so leaning on the trackpad cannot push the list
 * off the bottom of the rail.
 */
export const PULL_MAX = 96;

/** How long the deltas must stop for before the gesture counts as released. */
const RELEASE_MS = 140;

export type PullPhase = 'idle' | 'pulling' | 'armed' | 'refreshing';

interface UsePullToRefresh {
  /** Attach to the panel's own root; the scroll parent is found from it. */
  ref: (node: HTMLElement | null) => void;
  /** How far the list has been pulled, in pixels, already clamped. */
  distance: number;
  phase: PullPhase;
}

interface Options {
  onRefresh: () => void | Promise<unknown>;
  /**
   * Turn the gesture off without unmounting — a panel showing its first-load
   * skeleton has nothing to refresh *to*, and a panel showing search results
   * would refresh the list behind them.
   */
  disabled?: boolean;
}

function scrollParentOf(node: HTMLElement | null): HTMLElement | null {
  for (let el = node?.parentElement ?? null; el !== null; el = el.parentElement) {
    const { overflowY } = getComputedStyle(el);
    if (overflowY === 'auto' || overflowY === 'scroll') return el;
  }
  return null;
}

export function usePullToRefresh({ onRefresh, disabled = false }: Options): UsePullToRefresh {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [distance, setDistance] = useState(0);
  const [phase, setPhase] = useState<PullPhase>('idle');

  /**
   * The callback is read through a ref so a panel that re-renders — which these
   * do on every poll — does not detach and re-attach the wheel listener, and
   * so the listener never closes over a stale `onRefresh`.
   */
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;

  const ref = useCallback((node: HTMLElement | null) => {
    setContainer(scrollParentOf(node));
  }, []);

  useEffect(() => {
    if (container === null || disabled) return;

    let travelled = 0;
    let releaseTimer: ReturnType<typeof setTimeout> | undefined;
    /** Set for the length of one refresh, so a second pull cannot stack on it. */
    let running = false;

    const settle = () => {
      travelled = 0;
      setDistance(0);
      setPhase('idle');
    };

    const release = () => {
      if (travelled < PULL_THRESHOLD) {
        settle();
        return;
      }

      running = true;
      setPhase('refreshing');
      // Held at the threshold rather than wherever the gesture ended, so the
      // spinner sits in one place instead of wherever the user let go.
      setDistance(PULL_THRESHOLD);

      /**
       * Swallowed, not ignored: whether the read succeeded is the panel's
       * story to tell — it already turns a failure into a source notice with a
       * retry — and this gesture owns only the indicator. Without the `catch`
       * the `finally` re-raises into an unhandled rejection every time a
       * refresh fails, which is exactly when the app is already unhappy.
       */
      void Promise.resolve(refreshRef.current())
        .catch(() => undefined)
        .finally(() => {
          running = false;
          settle();
        });
    };

    const onWheel = (event: WheelEvent) => {
      if (running) return;

      // Only from a standstill at the very top, and only pulling downward.
      // `deltaY < 0` is a scroll *up*, which is what "pull the list down" is.
      if (container.scrollTop > 0 || event.deltaY >= 0) {
        if (travelled > 0) {
          clearTimeout(releaseTimer);
          settle();
        }
        return;
      }

      // The list cannot scroll any further up, so this delta is ours. Claiming
      // it stops the rubber-band bounce fighting the indicator for the same
      // gesture.
      if (event.cancelable) event.preventDefault();

      travelled = Math.min(travelled - event.deltaY, PULL_MAX);
      setDistance(travelled);
      setPhase(travelled >= PULL_THRESHOLD ? 'armed' : 'pulling');

      clearTimeout(releaseTimer);
      releaseTimer = setTimeout(release, RELEASE_MS);
    };

    container.addEventListener('wheel', onWheel, { passive: false });

    return () => {
      container.removeEventListener('wheel', onWheel);
      clearTimeout(releaseTimer);
    };
  }, [container, disabled]);

  /**
   * A panel that is disabled mid-pull — the search box gaining a term while the
   * list is held open — must not keep the indicator on screen with no listener
   * left to close it.
   */
  useEffect(() => {
    if (!disabled) return;
    setDistance(0);
    setPhase('idle');
  }, [disabled]);

  return { ref, distance, phase };
}
