import { useCallback, useEffect, useState } from 'react';

import { DECLINED_BACK_MS } from '@/hooks/use-declined-back';

/**
 * Whether the stage just refused a drop of files onto a terminal.
 *
 * The drop itself is handled by the surface, which only asks the stage what
 * to type; a refusal therefore leaves the terminal exactly as it was, and
 * without this the user sees nothing at all — the silence that made dropping
 * files look broken in the first place. So the stage says why, for as long as
 * {@link useDeclinedBack} says its own news, and on the same strip.
 *
 * A counter for the same reason that hook keeps one: a second refusal while
 * the first is showing must restart the clock, and `true -> true` would not.
 * `surface` clears it, so the news never follows the user to another terminal.
 */
export function useRefusedDrop(surface: string | null): {
  refused: boolean;
  refuse: () => void;
} {
  const [at, setAt] = useState<number | null>(null);

  const refuse = useCallback(() => {
    setAt((previous) => (previous ?? 0) + 1);
  }, []);

  useEffect(() => {
    if (at === null) return;
    const timer = setTimeout(() => setAt(null), DECLINED_BACK_MS);
    return () => clearTimeout(timer);
  }, [at]);

  useEffect(() => {
    setAt(null);
  }, [surface]);

  return { refused: at !== null, refuse };
}
