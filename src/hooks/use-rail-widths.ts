import { useCallback, useLayoutEffect, useMemo, useState } from 'react';

import { clampRailWidths, RAIL_MIN, railMaxWidth, type RailDisplay } from '@lib/rail-width';
import { applyRailWidths, useRailWidthState } from '@stores/appearance-store';
import { useShowActivityRail } from '@stores/ui-store';

/**
 * What one handle needs to drive and announce itself.
 *
 * `min` and `max` are the **effective** bounds, not the constants — see
 * {@link useRailWidths} on why the difference matters.
 */
export interface RailHandleBounds {
  value: number;
  min: number;
  max: number;
}

export interface RailWidths {
  left: RailHandleBounds;
  right: RailHandleBounds;
}

/**
 * Keep the painted rail widths correct (HIVE-105).
 *
 * ## Why a hook, and why not in `app-shell`
 *
 * The answer depends on three facts that live in three different places: the
 * stored widths and the density (`appearance-store`), whether the activity rail
 * is mounted (`ui-store`), and how wide the window is (the DOM). No store may
 * read another, and the DOM is nobody's state — so the assembly has to happen
 * in a component.
 *
 * It happens in `rail-handles.tsx`, a leaf, rather than in the shell that
 * mounts it. That is deliberate and it is the difference between a drag costing
 * two renders and costing every mounted surface in the app: `app-shell` renders
 * `LeftRail`, `CenterStage` and `ActivityRail`, none of them memoized, and
 * `center-stage.tsx` notes that a render of it "costs a render of every mounted
 * surface". Subscribing the shell to a value that changes on every `pointermove`
 * would have made a drag the most expensive gesture in the app.
 *
 * ## Why there is no `setState` here
 *
 * The widths are derived, not held. `clampRailWidths` is pure, so it runs in
 * render through `useMemo`; the layout effect only *writes* the result to
 * `<body>`. Keeping them in state instead would mean a second render for every
 * one of the first — the store update renders, the effect sets state, that
 * renders again — for a value that was already knowable during the first.
 *
 * The one thing that genuinely is state is the window's width, because
 * `window.innerWidth` is not reactive and nothing else will tell us it changed.
 *
 * ## Why `useLayoutEffect`
 *
 * The write must land before the browser paints. In a `useEffect` a stored
 * width would apply one frame after the rails had already drawn at their
 * default — a visible jump on every launch for anyone who has resized a rail.
 */
export function useRailWidths(): RailWidths {
  const { railWidthLeft, railWidthRight, railCollapsedLeft, railCollapsedRight, density } =
    useRailWidthState();
  const showActivityRail = useShowActivityRail();

  /*
    `window.innerWidth` is not React state, so it is mirrored into some. The
    initial value is read synchronously rather than defaulting to 0: the first
    render is the one that has to be right.
  */
  const [windowWidth, setWindowWidth] = useState(() =>
    typeof window === 'undefined' ? 0 : window.innerWidth,
  );

  const onResize = useCallback(() => setWindowWidth(window.innerWidth), []);

  useLayoutEffect(() => {
    if (typeof window === 'undefined') return;

    window.addEventListener('resize', onResize);
    /*
      Once on mount too. Between the `useState` initialiser and this effect the
      window can have changed — a restored window animating to its saved size is
      the ordinary case — and the listener alone would miss it.
    */
    onResize();

    return () => window.removeEventListener('resize', onResize);
  }, [onResize]);

  const min = RAIL_MIN[density];

  /*
    Three facts from three places, which is why this assembly happens in a
    component: the widths and collapse flags (`appearance-store`), whether the
    activity rail is mounted at all (`ui-store`), and the window (the DOM).

    `hidden` outranks `collapsed`: an unmounted rail claims no width, and a
    collapsed one claims 44px, so asking "is it mounted?" first is the only
    order that cannot paint a strip for a rail nobody renders.
  */
  const rightDisplay: RailDisplay = !showActivityRail
    ? 'hidden'
    : railCollapsedRight
      ? 'collapsed'
      : 'expanded';

  const widths = useMemo(
    () =>
      clampRailWidths({
        storedLeft: railWidthLeft,
        storedRight: railWidthRight,
        min,
        windowWidth,
        left: railCollapsedLeft ? 'collapsed' : 'expanded',
        right: rightDisplay,
      }),
    [railWidthLeft, railWidthRight, min, windowWidth, railCollapsedLeft, rightDisplay],
  );

  /*
    The same clamp, run a second time with both rails forced to `expanded`.

    `header.tsx` aligns to where a rail's edge sits when it is open, never to
    where a collapsed 44px strip happens to end — see `applyRailWidths` on why.
    That means the header needs the expanded answer regardless of what either
    rail is actually doing right now, and `clampRailWidths` is pure, so getting
    it is a second call with different `display` flags rather than a second
    subscription to anything.
  */
  const openWidths = useMemo(
    () =>
      clampRailWidths({
        storedLeft: railWidthLeft,
        storedRight: railWidthRight,
        min,
        windowWidth,
        left: 'expanded',
        right: 'expanded',
      }),
    [railWidthLeft, railWidthRight, min, windowWidth],
  );

  useLayoutEffect(() => {
    applyRailWidths(widths, min, openWidths);
  }, [widths, min, openWidths]);

  /**
   * The bounds handed to each handle, which are **not** simply the constants.
   *
   * Below `railFloorWindowWidth` the stage floor wins and a rail is painted
   * *narrower than its own minimum*. Handing the handle the unreduced minimum
   * there produces a slider whose `min` exceeds its `value` — invalid to
   * announce, and actively wrong to drive: the shrink key would evaluate
   * `Math.max(320, …)` on a rail painted at 308 and *grow* it, writing a stored
   * width the user never chose.
   *
   * So the floor follows the paint down, and the ceiling is never allowed below
   * the floor. At a window that narrow the range collapses to a single value,
   * which is the honest answer — there is no room to move.
   */
  const bounds = (value: number, floor: number): RailHandleBounds => {
    const effectiveMin = Math.min(floor, value);
    return {
      value,
      min: effectiveMin,
      max: Math.max(effectiveMin, railMaxWidth(windowWidth)),
    };
  };

  return {
    left: bounds(widths.left, min.left),
    right: bounds(widths.right, min.right),
  };
}
