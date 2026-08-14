import { useState } from 'react';

import { type PhraseKey, pickPhrase } from '@lib/swarm/phrases';

/**
 * One phrase from a surface's pool, chosen once and held.
 *
 * ## Why this is a hook and not a call
 *
 * `pickPhrase()` in a render body would re-roll on every render, and these
 * surfaces re-render for reasons that have nothing to do with them — a sibling
 * panel's count changing, a theme flip, a resize. The phrase would flicker
 * through the pool while the user read it.
 *
 * `useState`'s lazy initialiser is the whole fix: the function runs on the first
 * render of this component instance and never again.
 *
 * ## When it re-rolls
 *
 * On remount, which is exactly the cadence that makes this feel alive rather
 * than random. Both rails unmount the inactive panel when a tab changes, so
 * leaving the inbox and coming back draws a new line — a few times an hour, not
 * a few times a second.
 *
 * A surface that stays mounted keeps its phrase for as long as it is on screen,
 * which is the other half of the same property: nothing changes under the eye.
 */
export function useSwarmPhrase(key: PhraseKey): string {
  const [phrase] = useState(() => pickPhrase(key));

  return phrase;
}
