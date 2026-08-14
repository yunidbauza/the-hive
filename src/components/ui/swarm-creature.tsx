import { useReducedMotion } from '@hooks/use-reduced-motion';

import hiveStill from './swarm/hive-still.webp';
import hiveAnim from './swarm/hive.webp';
import hydraliskStill from './swarm/hydralisk-still.webp';
import hydraliskAnim from './swarm/hydralisk.webp';
import overlordStill from './swarm/overlord-still.webp';
import overlordAnim from './swarm/overlord.webp';
import spireStill from './swarm/spire-still.webp';
import spireAnim from './swarm/spire.webp';

/**
 * A small breathing creature, for the surfaces that have nothing else on them.
 *
 * ## Where this is allowed, and at what size
 *
 * Two registers, and the size is what separates them:
 *
 * - **Full-stage surfaces at 72–120 px** — the picker's first run, the dormant
 *   orchestrator, the editor with no file, the settings card. Those own the
 *   whole centre and have nothing to compete with.
 * - **Rails at 44 px** — small enough to read as a mark rather than an
 *   illustration.
 *
 * The rails were text-only when this shipped, on the argument that a decorative
 * empty state in a 268 px column beside a live terminal takes more attention
 * than the thing it is apologising for. That argument is about *size*, not about
 * whether an image may appear at all: at 44 px the creature occupies less height
 * than the two lines of copy beneath it, and the copy is still what the eye
 * lands on. Anything larger in a rail is the thing the original argument
 * correctly rules out.
 *
 * ## Why an <img> and not CSS
 *
 * Animated WebP plays in a plain `<img>` with no library and no canvas. The
 * splash sprite needs a canvas because it keys a white background out per frame;
 * these are already transparent, so there is nothing to do.
 *
 * ## Motion
 *
 * The animated file ignores `prefers-reduced-motion` — see `use-reduced-motion`.
 * Under the preference the element is handed a single-frame file instead, so the
 * creature is still there and simply holds still.
 */

const SPRITES = {
  hive: { animated: hiveAnim, still: hiveStill },
  hydralisk: { animated: hydraliskAnim, still: hydraliskStill },
  overlord: { animated: overlordAnim, still: overlordStill },
  spire: { animated: spireAnim, still: spireStill },
} as const;

export type Creature = keyof typeof SPRITES;

export function SwarmCreature({
  creature,
  size = 96,
}: {
  /**
   * Which one. The casting is a second channel, not decoration, so it is fixed
   * per surface rather than chosen per render:
   *
   * - **Hive** — the orchestrator's empty fleet, the picker's first run, the
   *   settings projects card, and the explorer's empty repository. The app's own
   *   face, territory, and the thing that leads the main screen.
   * - **Overlord** — the projects rail, and the inbox. It hovers and watches
   *   without acting, which is what both of those states are.
   * - **Spire** — work, pull requests, and the editor with no file. Things with
   *   a lifecycle, caught mid-morph.
   * - **Hydralisk** — agents. The unit that does the work.
   *
   * That is all ten call sites; a reviewer should be able to check any one of
   * them against this list and find it here.
   *
   * A surface that picks a different creature than its neighbours in the same
   * state turns the channel back into noise, which is the whole reason this is
   * a fixed prop and not a random draw like the phrase beneath it.
   */
  creature: Creature;
  /** Rendered height in px. The width follows the sprite's own ratio. */
  size?: number;
}) {
  const reduced = useReducedMotion();
  const sprite = SPRITES[creature];

  return (
    <img
      /**
       * Decorative in the strict sense: the flavour line beneath it is real
       * text and says the same thing. Announcing the creature too would make a
       * screen reader read the state twice.
       */
      aria-hidden="true"
      alt=""
      data-creature={creature}
      src={reduced ? sprite.still : sprite.animated}
      style={{ height: size }}
      className="w-auto select-none"
    />
  );
}
