import { useEffect, type RefObject } from 'react';

import { useMarkSessionReady, useSessionBooting } from '@stores/hive-store';

/**
 * How long the cover may hold before it lifts itself (HIVE-101).
 *
 * Sixty seconds, and the two ends of that number are set by different things.
 *
 * The **floor** is a cold `direnv`, which is the whole reason this surface
 * exists and which prints its own advice about getting up to stretch. A ready
 * signal measured at ~2s on a warm environment says nothing about a first run
 * that compiles something.
 *
 * The **ceiling** is a session that will never report at all — no `claude` on
 * `PATH`, an expired login, a wedged process — where the explanation is sitting
 * in the terminal underneath, unread. A minute is a long time to withhold an
 * error message.
 *
 * The keystroke escape is what makes a number this large defensible: the user
 * is never actually held here, and the cover says so.
 */
export const BOOT_COVER_TIMEOUT_MS = 60_000;

/**
 * Should this session's terminal still be covered while it starts?
 *
 * The store holds the flag; this hook owns the two ways out that do **not**
 * come from a `SessionStart`, and it owns them because both are facts about the
 * user and the screen rather than about the process:
 *
 * - **the timeout**, for a session that never reports;
 * - **the first keystroke**, for a user who would rather watch it boot, or who
 *   needs to read the error the cover is hiding.
 *
 * Nothing here waits on the ready signal alone. That was the whole risk of this
 * feature: an overlay that outlives the thing it is covering is worse than the
 * noise it replaced, because it hides the explanation as well.
 *
 * `keydown` and `pointerdown` on the window rather than on the cover: it takes
 * neither focus nor pointer events,
 * so a key pressed while it is up is already on its way to the pty. Lifting on
 * it means the user's first character both reaches Claude *and* reveals the
 * terminal it landed in — which is the behaviour someone impatiently typing
 * would expect, rather than a keystroke that seems to vanish.
 */
export function useSessionBoot(
  entityId: string | null,
  /**
   * The terminal's box, for the pointer escape only.
   *
   * A press is an escape when it lands on the *terminal* — that is what "click
   * through to see it" means. Left unscoped it also fired for **Back to
   * overmind**, which marked a session ready on the way out of it, so returning
   * found raw boot output where the cover should have been. Caught by the spec
   * that navigates away and back.
   *
   * Keys stay unscoped deliberately: a keystroke while a session is on screen
   * is meant for its terminal wherever focus happens to be, and that is the
   * affordance the cover advertises in as many words.
   */
  regionRef?: RefObject<HTMLElement | null>,
): boolean {
  const booting = useSessionBooting(entityId ?? '');
  const markSessionReady = useMarkSessionReady();

  useEffect(() => {
    if (!booting || entityId === null) return;

    /**
     * When the cover went up, so the key that *raised* it cannot dismiss it.
     *
     * This is not defensive coding, it is a bug that shipped in the first draft
     * and made the feature invisible to anyone using the keyboard. The picker
     * commits on **Enter**; React flushes that discrete update and runs this
     * effect *while the keydown is still propagating*; the listener is
     * therefore registered before the event finishes bubbling to `window`, and
     * the same Enter that started the session immediately dismissed its cover.
     *
     * Mouse-started sessions were unaffected, which is what made it look like a
     * flake rather than a rule.
     *
     * `timeStamp` and `performance.now()` share a time origin, so the
     * comparison is exact and needs no timer to sidestep the dispatch.
     */
    const armedAt = performance.now();

    const uncover = () => markSessionReady(entityId);

    const escaped = (event: Event) => {
      if (event.timeStamp < armedAt) return;
      uncover();
    };

    const onPointer = (event: Event) => {
      const region = regionRef?.current;
      const target = event.target;
      if (region && target instanceof Node && !region.contains(target)) return;
      escaped(event);
    };

    const timer = setTimeout(uncover, BOOT_COVER_TIMEOUT_MS);
    /*
      **Capture, not bubble.** The terminal underneath keeps focus while the
      cover is up — that is deliberate, so the user's first character reaches
      the pty — and xterm stops the keydown at its own textarea. On the bubble
      phase this listener therefore never ran, and the escape existed only in
      the tests that dispatched on `window` directly.

      Capture runs from `window` down, so it sees the key before xterm does and
      cannot be silenced by it. The `armedAt` guard above is what keeps that
      from re-introducing the Enter problem: capture makes this listener earlier
      still in the very dispatch that created the cover.
    */
    window.addEventListener('keydown', escaped, true);
    /*
      And a pointer press, on the same terms. The cover takes no pointer events,
      so a click already reaches the terminal underneath and focuses it — this
      is what makes it *visible* at the same moment, rather than leaving the
      user looking at a hydralisk they have just successfully clicked through.

      `pointerdown` rather than `click`: it fires first, so the cover is on its
      way out before the press completes.
    */
    window.addEventListener('pointerdown', onPointer, true);

    return () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', escaped, true);
      window.removeEventListener('pointerdown', onPointer, true);
    };
  }, [booting, entityId, markSessionReady, regionRef]);

  return booting;
}
