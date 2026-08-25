#!/usr/bin/env python3
"""Draw the desktop app icon: a stack of carapace plates carrying a prompt.

The hive this app is named for is the **Zerg** structure, not a beehive, and the
icon is drawn in that vocabulary: three overlapping scutes — smooth on the
leading edge, two hooked spines trailing — receding up and to the right, with a
terminal prompt on the front plate. One plate per session, the front one live.

## Why this replaced the window-and-mark icon

The previous icon composed a terminal window around `resources/hive-mark.png`,
the swarm insignia. The metaphor was right and the arithmetic was not: that mark
carries roughly forty hooks and curls, none of which survive being sixteen
pixels wide, so the dock read as a blue tile with grey soup in it. What is kept
here is the swarm; what is dropped is the detail count. Three plates, a chevron
and a caret still resolve at 16px, which is the size the icon actually has to
work at.

Nothing is traced from a bitmap any more — the geometry below *is* the mark, so
there is no master image to drift from. Every colour still comes from
`src/styles/tokens.css` and nothing is invented here:

    ink          #10152A   --cc-bg / the ground, and the seam between plates
    active       #222C55   --cc-active / the rearmost plate
    Serenity     #334FA9   --cc-brand-fill-strong / the middle plate
    lifted       #5E76D0   --cc-brand-fill / the front plate, the live one
    white        #FFFFFF   --cc-on-brand / the cursor

The chevron is the one derived value: `--cc-brand` (#8FA7F2) is calibrated to
read as text on a panel, and on the front plate it sits too close to the fill.
It is lifted to #C7D3FA, the same lift the previous icon used and for the same
reason. If a colour changes in the tokens it must change here too; the icon has
no palette of its own.

Outputs:

    resources/icon.png          1024 master, full-bleed (Linux, builder source)
    resources/icon-macos.png    on Apple's grid — 824 of 1024, margin around it
    resources/icon.icns         macOS, from the padded master via `iconutil`
    resources/icon.ico          Windows, 16-256
    resources/icons/<n>x<n>.png the Linux ladder
    public/favicon.png, apple-touch-icon.png   the browser tab

Requires Pillow (`pip install pillow`) and, for the `.icns`, macOS `iconutil`.
It is a one-off asset step, not part of `pnpm build` — run it only when the icon
design changes, and commit what it writes.

    python3 scripts/icon/generate-app-icon.py
"""

from __future__ import annotations

import math
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

try:
    from PIL import Image, ImageDraw
except ImportError:  # pragma: no cover - operator feedback, not app code
    sys.exit("Pillow is required: pip install pillow")

ROOT = Path(__file__).resolve().parents[2]
RESOURCES = ROOT / "resources"
PUBLIC = ROOT / "public"

S = 1024  # master canvas
SS = 4  # supersample factor for every mask we rasterise

INK = (0x10, 0x15, 0x2A)
PLATE_BACK = (0x22, 0x2C, 0x55)
PLATE_MID = (0x33, 0x4F, 0xA9)
PLATE_FRONT = (0x5E, 0x76, 0xD0)
CHEVRON = (0xC7, 0xD3, 0xFA)  # --cc-brand lifted, so it reads on the front plate
WHITE = (0xFF, 0xFF, 0xFF)

# macOS draws its own grid, and a full-bleed icon ignores it: in the dock ours
# stood a head taller than Docker and iTerm. Apple's rounded-rectangle app icon
# is 824pt inside a 1024pt canvas — the rest is the margin the dock counts on.
MACOS_TILE = 824 / 1024


# --------------------------------------------------------------------- masks


def squircle(size: int, n: float = 5.0) -> Image.Image:
    """A superellipse mask — the rounded square macOS and Windows both expect."""
    big = size * SS
    mask = Image.new("L", (big, big), 0)
    draw = ImageDraw.Draw(mask)
    r = (size / 2) * SS
    c = big / 2
    points = []
    for i in range(1440):
        t = 2 * math.pi * i / 1440
        ct, st = math.cos(t), math.sin(t)
        points.append(
            (
                c + r * math.copysign(abs(ct) ** (2 / n), ct),
                c + r * math.copysign(abs(st) ** (2 / n), st),
            )
        )
    draw.polygon(points, fill=255)
    return mask.resize((size, size), Image.LANCZOS)


def rounded(size: int, box: list[float], radius: float) -> Image.Image:
    big = size * SS
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [v * SS for v in box], radius=radius * SS, fill=255
    )
    return mask.resize((size, size), Image.LANCZOS)


def painted(size: int, mask: Image.Image, colour: tuple[int, int, int]) -> Image.Image:
    layer = Image.new("RGBA", (size, size), colour + (0,))
    layer.putalpha(mask)
    return layer


def clipped(layer: Image.Image, mask: Image.Image) -> Image.Image:
    out = layer.copy()
    alpha = out.split()[3]
    out.putalpha(Image.composite(alpha, Image.new("L", alpha.size, 0), mask))
    return out


Point = tuple[float, float]


def quad(start: Point, control: Point, end: Point, steps: int = 28) -> list[Point]:
    """A quadratic bezier, flattened.

    Pillow draws polygons, not curves, so every sweep in a plate arrives here
    first. Flattening happens in master coordinates and is rasterised at `SS`,
    so 28 steps is far finer than the output can resolve.
    """
    out: list[Point] = []
    for i in range(1, steps + 1):
        t = i / steps
        m = 1 - t
        out.append(
            (
                m * m * start[0] + 2 * m * t * control[0] + t * t * end[0],
                m * m * start[1] + 2 * m * t * control[1] + t * t * end[1],
            )
        )
    return out


# ------------------------------------------------------------------ the plate


# The stack is drawn in its own coordinates and then *placed* on the canvas:
# scaled up and recentred, because a shape's bounding box is never the canvas's
# and the dock sizes every icon by how much of the tile it fills. Changing these
# three numbers grows or shrinks the icon without touching a plate coordinate.
FIT_SCALE = 1.08
FIT_FROM = (497.0, 528.0)  # where the stack's own centre lands, undisturbed
FIT_TO = (S / 2, S / 2)


def place(points: list[Point]) -> list[Point]:
    return [
        (
            (px - FIT_FROM[0]) * FIT_SCALE + FIT_TO[0],
            (py - FIT_FROM[1]) * FIT_SCALE + FIT_TO[1],
        )
        for px, py in points
    ]


def scute(x: float, y: float, w: float, h: float, r: float) -> list[Point]:
    """One carapace plate: smooth leading edge, two hooked spines trailing.

    Proportional rather than absolute, so the receding plates are the same shape
    at a smaller size and the stack reads as depth instead of as three different
    objects. The two notches on the trailing edge are what separate chitin from
    a rounded rectangle — an earlier pass used an even sawtooth and read as the
    perforation on a ticket stub.
    """
    def fx(f: float) -> float:
        return x + w * f

    def fy(f: float) -> float:
        return y + h * f

    points: list[Point] = [(x + r, y), (fx(0.58), y)]
    points += quad((fx(0.58), y), (fx(0.86), fy(0.05)), (fx(1.00), fy(0.30)))
    points.append((fx(0.77), fy(0.41)))
    points += quad((fx(0.77), fy(0.41)), (fx(0.91), fy(0.49)), (fx(0.955), fy(0.68)))
    points.append((fx(0.72), fy(0.755)))
    points += quad((fx(0.72), fy(0.755)), (fx(0.85), fy(0.91)), (fx(0.56), y + h))
    points.append((x + r, y + h))
    points += quad((x + r, y + h), (x, y + h), (x, y + h - r))
    points.append((x, y + r))
    points += quad((x, y + r), (x, y), (x + r, y))
    return points


def polygon_mask(points: list[Point], outline: float = 0.0) -> Image.Image:
    """The polygon, optionally grown by a rounded outline of `outline` width."""
    big = S * SS
    mask = Image.new("L", (big, big), 0)
    draw = ImageDraw.Draw(mask)
    pts = [(px * SS, py * SS) for px, py in points]
    draw.polygon(pts, fill=255)
    if outline:
        draw.line(pts + [pts[0]], fill=255, width=round(outline * SS), joint="curve")
    return mask.resize((S, S), Image.LANCZOS)


def stroke(points: list[Point], weight: float, colour: tuple[int, int, int]) -> Image.Image:
    """An open polyline with round caps and joints — the prompt's chevron."""
    big = S * SS
    mask = Image.new("L", (big, big), 0)
    draw = ImageDraw.Draw(mask)
    pts = [(px * SS, py * SS) for px, py in points]
    w = weight * SS
    draw.line(pts, fill=255, width=round(w), joint="curve")
    for px, py in pts:
        draw.ellipse([px - w / 2, py - w / 2, px + w / 2, py + w / 2], fill=255)
    return painted(S, mask.resize((S, S), Image.LANCZOS), colour)


# ------------------------------------------------------------------- the icon

# Three plates, each smaller than the one in front of it. Equal-sized plates were
# tried first and the rear two came out as thin bands hugging the front one —
# perspective is what makes them read as plates rather than as motion lines.
PLATES = (
    (place(scute(300, 200, 536, 428, 80)), PLATE_BACK),
    (place(scute(212, 280, 580, 464, 86)), PLATE_MID),
    (place(scute(116, 360, 620, 496, 92)), PLATE_FRONT),
)

# The seam. Each plate is drawn twice — once grown by this much in ink, once at
# its own size in its own colour — so a dark gap separates it from whatever it
# overlaps. Without it the three fills touch and the stack flattens into one
# shape with two stripes on it.
SEAM = 84 * FIT_SCALE

CHEVRON_PATH = place([(280, 532), (392, 608), (280, 684)])
CHEVRON_WEIGHT = 64 * FIT_SCALE

# The cursor, on the front plate's baseline. A box rather than a point list
# because it is the one piece Pillow can draw directly.
_caret = place([(436, 652), (572, 688)])
CARET = [_caret[0][0], _caret[0][1], _caret[1][0], _caret[1][1]]


def render() -> Image.Image:
    tile = squircle(S)
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    img.alpha_composite(painted(S, tile, INK))

    for points, fill in PLATES:
        img.alpha_composite(clipped(painted(S, polygon_mask(points, SEAM), INK), tile))
        img.alpha_composite(clipped(painted(S, polygon_mask(points), fill), tile))

    img.alpha_composite(stroke(CHEVRON_PATH, CHEVRON_WEIGHT, CHEVRON))
    img.alpha_composite(
        painted(S, rounded(S, CARET, (CARET[3] - CARET[1]) / 2), WHITE)
    )
    return img


def padded_for_macos(master: Image.Image) -> Image.Image:
    """The same icon inside Apple's grid, so the dock sizes it like a native app."""
    side = round(S * MACOS_TILE)
    canvas = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    canvas.alpha_composite(master.resize((side, side), Image.LANCZOS), ((S - side) // 2,) * 2)
    return canvas


# ------------------------------------------------------------------ output

LINUX_LADDER = (16, 32, 48, 64, 128, 256, 512, 1024)
ICO_LADDER = (16, 24, 32, 48, 64, 128, 256)
ICNS_LADDER = ((16, 1), (16, 2), (32, 1), (32, 2), (128, 1), (128, 2), (256, 1), (256, 2), (512, 1), (512, 2))


def write_icns(source: Image.Image, target: Path) -> bool:
    if not shutil.which("iconutil"):
        print("! iconutil not found (macOS only) — skipping icon.icns")
        return False
    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / "icon.iconset"
        iconset.mkdir()
        for base, scale in ICNS_LADDER:
            px = base * scale
            suffix = "@2x" if scale == 2 else ""
            source.resize((px, px), Image.LANCZOS).save(
                iconset / f"icon_{base}x{base}{suffix}.png"
            )
        subprocess.run(
            ["iconutil", "-c", "icns", str(iconset), "-o", str(target)], check=True
        )
    return True


def main() -> None:
    master = render()
    macos = padded_for_macos(master)
    (RESOURCES / "icons").mkdir(parents=True, exist_ok=True)

    master.save(RESOURCES / "icon.png")
    # The same art on Apple's grid, for anything that sets a macOS icon from a
    # PNG rather than from the bundle — the dev dock, today.
    macos.save(RESOURCES / "icon-macos.png")
    for size in LINUX_LADDER:
        master.resize((size, size), Image.LANCZOS).save(
            RESOURCES / "icons" / f"{size}x{size}.png"
        )

    master.save(
        RESOURCES / "icon.ico",
        format="ICO",
        sizes=[(s, s) for s in ICO_LADDER],
    )

    write_icns(macos, RESOURCES / "icon.icns")

    # The browser target's tab icon, so web and desktop agree.
    master.resize((32, 32), Image.LANCZOS).save(PUBLIC / "favicon.png")
    master.resize((180, 180), Image.LANCZOS).save(PUBLIC / "apple-touch-icon.png")

    print(f"wrote {RESOURCES.relative_to(ROOT)}/ and {PUBLIC.relative_to(ROOT)}/ icons")


if __name__ == "__main__":
    main()
