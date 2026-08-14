import { useEffect, useState } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

/**
 * Whether the user has asked for less motion.
 *
 * ## Why JavaScript has to answer this
 *
 * `global.css` already collapses CSS animation and transition durations under
 * this media query, and for everything the app draws itself that is enough.
 *
 * It does nothing for an animated WebP. The frames are inside the file and the
 * browser plays them regardless of the setting — there is no CSS property that
 * pauses one and no way to reach it from a stylesheet. The only lever is which
 * file the element is given, so something has to read the query in JS and
 * choose. `src/splash/splash.ts` reaches the same conclusion for the cold-start
 * sprite and paints a single frame instead.
 *
 * ## Why it subscribes
 *
 * The setting is changed while apps are running — it is a system toggle, not a
 * boot flag — and a value read once at mount would leave a creature breathing
 * at somebody who just asked it to stop.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    /**
     * `matchMedia` is missing in a non-DOM environment and, more relevantly
     * here, in happy-dom depending on the version. Treating absence as "no
     * preference" keeps the animated path as the default rather than making a
     * test environment silently assert the fallback.
     */
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false;
    }

    return window.matchMedia(QUERY).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }

    const list = window.matchMedia(QUERY);
    const onChange = (event: MediaQueryListEvent): void => setReduced(event.matches);

    setReduced(list.matches);
    list.addEventListener('change', onChange);

    return () => list.removeEventListener('change', onChange);
  }, []);

  return reduced;
}
