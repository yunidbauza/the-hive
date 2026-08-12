#!/usr/bin/env python3
"""Cut the desktop app icon from the header mark.

The icon is the app in miniature: a terminal window in the app's own chrome,
with the prompt line as the screen's only content — a pale-blue chevron and the
hive mark standing on a cursor underscore, the mark playing the character the
caret is holding.

Every colour comes from `src/styles/tokens.css`; nothing is invented here:

    ink          #10152A   --cc-bg / the window chrome
    Serenity     #334FA9   --cc-brand-fill-strong / the screen
    pale blue    #8FA7F2   --cc-brand / the chevron and one title-bar dot
    green        #74B79C   --cc-ok / the live title-bar dot

The mark itself is `public/hive-mark.png`, used as an alpha mask so it can be
painted white on the screen.

Outputs, all under `resources/`:

    icon.png          1024 master, full-bleed  (Linux, electron-builder source)
    icon.icns         macOS, from a padded master via `iconutil`
    icon.ico          Windows, 16-256
    icons/<n>x<n>.png the Linux ladder
    ../public/favicon.png, apple-touch-icon.png   the browser target

Requires Pillow (`pip install pillow`) and, for the `.icns`, macOS `iconutil`.
It is a one-off asset step, not part of `pnpm build` — run it only when the
mark or the icon design changes, and commit what it writes.

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
MARK = ROOT / "public" / "hive-mark.png"
RESOURCES = ROOT / "resources"
PUBLIC = ROOT / "public"

S = 1024  # master canvas
SS = 4  # supersample factor for every mask we rasterise

INK = (0x10, 0x15, 0x2A)
SERENITY = (0x33, 0x4F, 0xA9)
SERENITY_LIT = (0x45, 0x61, 0xBB)  # the top of the screen's gradient
PALE = (0x8F, 0xA7, 0xF2)
CHEVRON = (0xC7, 0xD3, 0xFA)  # pale blue lifted, so it reads on Serenity
GREEN = (0x74, 0xB7, 0x9C)
WHITE = (0xFF, 0xFF, 0xFF)

# macOS draws its own grid: a full-bleed icon sits visibly larger than its
# neighbours in the dock. Apple's rounded rect occupies ~82% of the canvas.
MACOS_TILE = 0.824


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


# ---------------------------------------------------------------- the mark


def load_mark() -> Image.Image:
    """The mark's alpha, cropped, with the source file's artefact removed.

    `public/hive-mark.png` carries a transparency-preview checkerboard baked in
    at alpha 17. Left alone it prints a faint grid over whatever sits behind the
    mark, so everything at or below 24 is floored to fully transparent.
    """
    alpha = Image.open(MARK).convert("RGBA").split()[3]
    alpha = alpha.point(lambda v: 0 if v <= 24 else v)
    return alpha.crop(alpha.getbbox())


MARK_ALPHA = load_mark()


def mark(size: int, colour: tuple[int, int, int]) -> Image.Image:
    w, h = MARK_ALPHA.size
    scale = size / max(w, h)
    a = MARK_ALPHA.resize((round(w * scale), round(h * scale)), Image.LANCZOS)
    layer = Image.new("RGBA", a.size, colour + (0,))
    layer.putalpha(a)
    return layer


def centre(base: Image.Image, layer: Image.Image, cx: float, cy: float) -> None:
    base.alpha_composite(layer, (round(cx - layer.width / 2), round(cy - layer.height / 2)))


# ------------------------------------------------------------------ pieces


def gradient(size: int, top: tuple[int, int, int], bottom: tuple[int, int, int]) -> Image.Image:
    g = Image.new("RGB", (2, 2))
    mid = tuple(round((top[i] + bottom[i]) / 2) for i in range(3))
    g.putpixel((0, 0), top)
    g.putpixel((1, 0), mid)
    g.putpixel((0, 1), mid)
    g.putpixel((1, 1), bottom)
    return g.resize((size, size), Image.BICUBIC).convert("RGBA")


def chevron(cx: float, cy: float, arm: float, weight: float) -> Image.Image:
    """The prompt's `>`, drawn as two capsule strokes rather than set in type."""
    big = S * SS
    mask = Image.new("L", (big, big), 0)
    draw = ImageDraw.Draw(mask)
    w = weight * SS
    a = ((cx - arm * 0.5) * SS, (cy - arm * 0.62) * SS)
    b = ((cx + arm * 0.5) * SS, cy * SS)
    c = ((cx - arm * 0.5) * SS, (cy + arm * 0.62) * SS)
    draw.line([a, b], fill=255, width=round(w))
    draw.line([b, c], fill=255, width=round(w))
    for p in (a, b, c):
        draw.ellipse([p[0] - w / 2, p[1] - w / 2, p[0] + w / 2, p[1] + w / 2], fill=255)
    return painted(S, mask.resize((S, S), Image.LANCZOS), CHEVRON)


def dot(cx: float, cy: float, r: float, colour: tuple[int, int, int]) -> Image.Image:
    mask = Image.new("L", (S * SS, S * SS), 0)
    ImageDraw.Draw(mask).ellipse(
        [(cx - r) * SS, (cy - r) * SS, (cx + r) * SS, (cy + r) * SS], fill=255
    )
    return painted(S, mask.resize((S, S), Image.LANCZOS), colour)


# ------------------------------------------------------------------- icon

CHROME_H = 210  # the title bar
MARK_SIZE = 340
MARK_CX, MARK_CY = 618, 530
CARET_GAP = 78  # air between the character and its cursor — deliberate, not tight
CARET_H, CARET_W = 46, 350


def render() -> Image.Image:
    tile = squircle(S)
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))

    screen = gradient(S, SERENITY_LIT, SERENITY)
    screen.putalpha(tile)
    img.alpha_composite(screen)

    img.alpha_composite(clipped(painted(S, rounded(S, [0, 0, S, CHROME_H], 0), INK), tile))
    for i, colour in enumerate((PALE, PALE, GREEN)):
        img.alpha_composite(dot(150 + i * 96, 105, 26, colour))

    img.alpha_composite(chevron(258, MARK_CY + 8, 132, 50))
    centre(img, mark(MARK_SIZE, WHITE), MARK_CX, MARK_CY)

    top = MARK_CY + MARK_SIZE / 2 + CARET_GAP
    img.alpha_composite(
        painted(
            S,
            rounded(
                S,
                [MARK_CX - CARET_W / 2, top, MARK_CX + CARET_W / 2, top + CARET_H],
                CARET_H / 2,
            ),
            WHITE,
        )
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
    (RESOURCES / "icons").mkdir(parents=True, exist_ok=True)

    master.save(RESOURCES / "icon.png")
    for size in LINUX_LADDER:
        master.resize((size, size), Image.LANCZOS).save(
            RESOURCES / "icons" / f"{size}x{size}.png"
        )

    master.save(
        RESOURCES / "icon.ico",
        format="ICO",
        sizes=[(s, s) for s in ICO_LADDER],
    )

    write_icns(padded_for_macos(master), RESOURCES / "icon.icns")

    # The browser target's tab icon, so web and desktop agree.
    master.resize((32, 32), Image.LANCZOS).save(PUBLIC / "favicon.png")
    master.resize((180, 180), Image.LANCZOS).save(PUBLIC / "apple-touch-icon.png")

    # The header mark, with the baked-in checkerboard taken out at source.
    cleaned = Image.open(MARK).convert("RGBA")
    r, g, b, a = cleaned.split()
    cleaned = Image.merge("RGBA", (r, g, b, a.point(lambda v: 0 if v <= 24 else v)))
    cleaned.save(MARK)

    print(f"wrote {RESOURCES.relative_to(ROOT)}/ and {PUBLIC.relative_to(ROOT)}/ icons")


if __name__ == "__main__":
    main()
