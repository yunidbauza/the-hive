import { useReducedMotion } from '@hooks/use-reduced-motion';

import hiveStill from './swarm/hive-still.webp';
import hiveAnim from './swarm/hive.webp';
import overlordStill from './swarm/overlord-still.webp';
import overlordAnim from './swarm/overlord.webp';
import spireStill from './swarm/spire-still.webp';
import spireAnim from './swarm/spire.webp';

/**
 * A small breathing creature, for the surfaces that have nothing else on them.
 *
 * ## Where this is allowed
 *
 * Full-stage surfaces only — the picker's first run, the dormant orchestrator,
 * the editor with no file, and the settings card. Those own the whole centre and
 * have nothing competing for attention.
 *
 * Not the rails. `empty-state.tsx` argues, correctly, that a decorative empty
 * state in a 268 px column beside a live terminal takes more attention than the
 * thing it is apologising for. The rails get the flavour *line* and no creature.
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
  overlord: { animated: overlordAnim, still: overlordStill },
  spire: { animated: spireAnim, still: spireStill },
} as const;

export type Creature = keyof typeof SPRITES;

export function SwarmCreature({
  creature,
  size = 96,
}: {
  /**
   * Which one. The casting is meaning, not decoration: the Overlord waits, the
   * Spire transforms, the Hive is home. A surface that picks a different
   * creature than its state implies makes the second channel noise.
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
