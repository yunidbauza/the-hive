import { useEffect, useState } from 'react';

import { useReducedMotion } from '@hooks/use-reduced-motion';
import { type PhraseKey, pickPhrase } from '@lib/swarm/phrases';

/** How long each line holds before the next is drawn. */
export const PHRASE_ROTATION_MS = 4_000;

/**
 * A phrase that changes while the user waits (HIVE-101).
 *
 * ## Why this is not `useSwarmPhrase`
 *
 * That hook exists to pick once and *hold*, and its docstring makes the case
 * plainly: these surfaces re-render for reasons that have nothing to do with
 * them, and a line that flickers through its pool is unreadable. Nothing here
 * disagrees with any of that.
 *
 * What differs is how long the surface is on screen. Every other pool covers a
 * state measured in milliseconds or one the user is browsing past; the boot
 * cover can hold for as long as `direnv` takes on a cold environment, which by
 * `direnv`'s own admission is long enough to get up and stretch. A single line
 * held for a minute stops reading as *waiting* and starts reading as *hung* —
 * which is the exact anxiety this surface exists to relieve.
 *
 * So it rotates, slowly, and only here.
 *
 * ## Motion
 *
 * A line that changes is motion, so `prefers-reduced-motion` stops the rotation
 * outright rather than slowing it. The user still gets a phrase — the first one
 * — for the same reason the creature still appears and simply holds still.
 */
export function useRotatingPhrase(
  key: PhraseKey,
  intervalMs: number = PHRASE_ROTATION_MS,
): string {
  const reduced = useReducedMotion();
  const [phrase, setPhrase] = useState(() => pickPhrase(key));

  useEffect(() => {
    if (reduced) return;

    const timer = setInterval(() => {
      /*
        Re-rolled rather than stepped through the pool in order. `pickPhrase`
        can return the line already on screen, which looks like the rotation
        stopped — so the draw is repeated until it differs. The pools this is
        used with have several entries, so this terminates immediately in
        practice; the bound is what makes that true rather than likely.
      */
      setPhrase((current) => {
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const next = pickPhrase(key);
          if (next !== current) return next;
        }
        return current;
      });
    }, intervalMs);

    return () => clearInterval(timer);
  }, [key, intervalMs, reduced]);

  return phrase;
}
