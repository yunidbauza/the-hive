"""
Cuts the swarm creature sprites the app ships.

The sources are large animated WebPs (1.2–5 MB each). The app renders them at
96–120 px on four full-stage surfaces, so it ships a 180 px cut — enough for a
2x display at that size and a fraction of the weight.

Each creature is emitted twice:

  <name>.webp        the animation
  <name>-still.webp  frame 0, alone

The still is not an optimisation. Animated WebP ignores
`prefers-reduced-motion` entirely — the browser plays it regardless — so the
only way to honour the setting is to hand the element a different file, which
is what `swarm-creature.tsx` does. `src/splash/splash.ts` already works around
the same limitation for the cold-start sprite.

Pillow rather than ffmpeg or cwebp, matching `scripts/splash/make-gif.mjs`:
neither is in this project's toolchain.

    python3 scripts/swarm/make-creatures.py <source-dir>

where <source-dir> holds hive-180.webp, overlord-180.webp, spire-180.webp.
"""

import os
import shutil
import sys

from PIL import Image

CREATURES = ("hive", "overlord", "spire")
OUT = os.path.join("src", "components", "ui", "swarm")


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2

    source = sys.argv[1]
    os.makedirs(OUT, exist_ok=True)

    total = 0
    for name in CREATURES:
        src = os.path.join(source, f"{name}-180.webp")
        if not os.path.exists(src):
            print(f"missing source: {src}")
            return 1

        animated = os.path.join(OUT, f"{name}.webp")
        shutil.copyfile(src, animated)

        with Image.open(src) as im:
            im.seek(0)
            still_path = os.path.join(OUT, f"{name}-still.webp")
            im.convert("RGBA").save(still_path, quality=80, method=6)
            size = im.size

        a = os.path.getsize(animated)
        b = os.path.getsize(still_path)
        total += a + b
        print(f"{name:10} anim {a / 1024:7.1f} KB   still {b / 1024:6.1f} KB   {size}")

    print(f"total {total / 1024:.1f} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
