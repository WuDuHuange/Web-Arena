#!/usr/bin/env python3
"""Tints the Kenney UI Pack slices into the arena's palette.

Run once when the UI slices change; the output is committed, so this is not part of the
build. It exists so the derivation is repeatable rather than a folder of PNGs nobody can
explain.

    python scripts/recolor-ui.py .workbuddy-ai/tmp-ui/pack/PNG src/assets/ui

Why tint at all: the pack ships light-grey chrome, and the arena is a dark scene. Dropping
light-grey panels on it makes the HUD the brightest thing on screen and reads as a web page
bolted onto a game. The pack's *shapes* are the valuable part -- the bevel, the inner
outline, the depth band -- so the transform keeps the luminance structure and moves the
whole ramp into a dark range.

Luminance is stretched rather than scaled. Multiplying by 0.2 maps a white 255 and a
mid-grey 140 to 51 and 28, which is a 23-step difference on a dark background: the bevel
survives in the numbers and disappears on screen. The stretch below maps that same pair to
a ~50-step difference, so the depth band is still visible after the palette is dark.

Alpha is carried through untouched -- the pack's edges are antialiased and the 9-slice
border widths are chosen against the alpha silhouette.
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image

# (source, destination, darkest, lightest)
#
# The luminance window is (120, 255): below 120 the pack has nothing but the outline of the
# depth band, and clipping there keeps the darkest pixels from being crushed to black.
SLICES = [
    ("Grey/Default/button_rectangle_depth_line.png", "panel.png", (18, 23, 33), (72, 86, 112)),
    ("Grey/Default/button_rectangle_depth_gloss.png", "button.png", (36, 45, 64), (112, 130, 164)),
    ("Grey/Default/button_rectangle_flat.png", "button-flat.png", (16, 21, 30), (62, 75, 99)),
    ("Extra/Default/input_rectangle.png", "input.png", (10, 13, 20), (44, 54, 70)),
    ("Extra/Default/divider.png", "divider.png", (52, 64, 84), (124, 144, 178)),
    ("Red/Default/button_rectangle_depth_line.png", "chip-red.png", (52, 18, 18), (162, 70, 62)),
    ("Blue/Default/button_rectangle_depth_line.png", "chip-blue.png", (18, 32, 56), (64, 116, 186)),
]

LUM_LO, LUM_HI = 120.0, 255.0


def tint(source: Path, destination: Path, dark: tuple[int, int, int], light: tuple[int, int, int]) -> None:
    image = Image.open(source).convert("RGBA")
    width, height = image.size
    src = image.load()
    out = Image.new("RGBA", (width, height))
    dst = out.load()

    span = LUM_HI - LUM_LO
    for y in range(height):
        for x in range(width):
            r, g, b, a = src[x, y]
            if a == 0:
                dst[x, y] = (0, 0, 0, 0)
                continue
            luminance = 0.299 * r + 0.587 * g + 0.114 * b
            t = (luminance - LUM_LO) / span
            t = 0.0 if t < 0.0 else (1.0 if t > 1.0 else t)
            dst[x, y] = (
                round(dark[0] + (light[0] - dark[0]) * t),
                round(dark[1] + (light[1] - dark[1]) * t),
                round(dark[2] + (light[2] - dark[2]) * t),
                a,
            )

    out.save(destination, optimize=True)
    print(f"{source.name:44s} -> {destination.name:16s} {width}x{height}")


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    pack, target = Path(sys.argv[1]), Path(sys.argv[2])
    target.mkdir(parents=True, exist_ok=True)
    for relative, name, dark, light in SLICES:
        source = pack / relative
        if not source.exists():
            print(f"missing: {source}", file=sys.stderr)
            return 1
        tint(source, target / name, dark, light)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
