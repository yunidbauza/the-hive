import { useEffect, useState } from 'react';

import {
  TERMINAL_CHORD_EVENT,
  type TerminalChordDetail,
} from '@lib/terminal/keymap';

/**
 * How long the news stays on screen.
 *
 * Long enough to read a seven-word line and act on it, short enough that it is
 * gone before the user's next keystroke lands. It is an answer to something
 * that just happened, not a status: a strip that outlived the moment would
 * start reading as a permanent part of the terminal's chrome.
 */
export const DECLINED_BACK_MS = 4_000;

/**
 * Whether the terminal just lost a bare `←` to the child process (HIVE-79).
 *
 * The app's half of the announcement. `components/terminal/` reports a
 * *keyboard* event and stops there — it does not know the app navigates, which
 * is what keeps it ignorant of domain concepts — so somebody has to turn "a
 * claim was declined" into "say so for four seconds". This is that somebody,
 * and it is a hook rather than state in the stage so the timer can be tested
 * against a fake clock without mounting thirteen terminals.
 *
 * Listens on `window` rather than on the terminal's own node, and that is safe
 * here in a way that a *chord* listener on `window` would not be: this event
 * exists only where a terminal dispatched it. The mistake story 110 records —
 * matching a key combination on `window`, and so firing for keystrokes
 * originating in any text field — is a mistake about matching keys, not about
 * where the listener sits.
 *
 * Re-armed on every announcement, so holding `←` down keeps the strip up rather
 * than flickering it: each event restarts the clock.
 *
 * `surface` is whatever the caller calls "the thing on screen" — an entity id
 * here. Changing it clears the strip; this hook never looks at the value.
 */
export function useDeclinedBack(surface: string | null): boolean {
  const [at, setAt] = useState<number | null>(null);

  useEffect(() => {
    const onChord = (event: Event) => {
      const { detail } = event as CustomEvent<TerminalChordDetail>;
      if (detail?.chord !== 'back-declined') return;
      /**
       * A counter, not a boolean, and not `Date.now()`.
       *
       * `true -> true` is not a state change, so a second decline while the
       * first is still showing would not re-run the effect below and the strip
       * would vanish on the *first* one's timer. A fresh value every time is
       * what re-arms it. A counter rather than a clock reading because the only
       * thing this value is ever compared against is its own predecessor.
       */
      setAt((previous) => (previous ?? 0) + 1);
    };
    window.addEventListener(TERMINAL_CHORD_EVENT, onChord);
    return () => window.removeEventListener(TERMINAL_CHORD_EVENT, onChord);
  }, []);

  useEffect(() => {
    if (at === null) return;
    const timer = setTimeout(() => setAt(null), DECLINED_BACK_MS);
    return () => clearTimeout(timer);
  }, [at]);

  /**
   * The news belongs to the surface it happened on.
   *
   * Without this the strip outlives the view that raised it: press `←` with a
   * half-written message, then leave with `⌘[`, and it follows the user to the
   * overmind — where it advises them to press `⌘[` to reach the overmind. It
   * would do the same on the way to another session, describing something that
   * happened in a terminal they are no longer looking at.
   */
  useEffect(() => {
    setAt(null);
  }, [surface]);

  return at !== null;
}
