import { useCallback, useLayoutEffect, useState } from 'react';

import {
  RAIL_MIN,
  railMaxWidth,
  type RailMinimums,
  type RailWidths,
} from '@lib/rail-width';
import { syncRailWidths, useRailWidthState } from '@stores/appearance-store';
import { useShowActivityRail } from '@stores/ui-store';

/**
 * Keep the painted rail widths correct (HIVE-105).
 *
 * ## Why a hook, and why at the composition root
 *
 * The answer depends on three facts that live in three different places: the
 * stored widths and the density (`appearance-store`), whether the activity rail
 * is mounted (`ui-store`), and how wide the window is (the DOM). No store may
 * read another, and the DOM is nobody's state — so the assembly has to happen
 * in a component, and the only component entitled to know about all three is
 * the shell.
 *
 * Mounted once, in `app-shell.tsx`, alongside the other single-subscription
 * hooks there and for the same reason: this writes to `<body>`, and a second
 * copy would mean two writers racing over one property.
 *
 * ## Why `useLayoutEffect`
 *
 * The write must land before the browser paints. In a `useEffect` a stored
 * width would apply one frame after the rails had already drawn at their
 * default — a visible jump on every launch for anyone who has resized a rail.
 */
export function useRailWidths(): RailWidths & { max: number; min: RailMinimums } {
  const { railWidthLeft, railWidthRight, density } = useRailWidthState();
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
    The clamp runs during layout rather than in render, because it writes to
    `<body>`. Rendering is supposed to be free of side effects, and a render
    that is thrown away (StrictMode, a suspended sibling) must not leave a
    property behind on the document.
  */
  const [widths, setWidths] = useState<RailWidths>(() => ({
    left: min.left,
    right: showActivityRail ? min.right : 0,
  }));

  useLayoutEffect(() => {
    setWidths(
      syncRailWidths({
        storedLeft: railWidthLeft,
        storedRight: railWidthRight,
        min,
        windowWidth,
        showActivityRail,
      }),
    );
  }, [railWidthLeft, railWidthRight, min, windowWidth, showActivityRail]);

  /*
    The ceiling a *single* rail may reach, which is what the handles need for
    `aria-valuemax` and for stopping the gesture. Deliberately the per-rail
    bound and not the cross-rail one: two rails fighting over a shared budget
    would make each handle's maximum depend on the other's live position, and a
    handle that moves its own limit while you drag it is worse than one that
    stops slightly early.
  */
  return { ...widths, max: railMaxWidth(windowWidth), min };
}
