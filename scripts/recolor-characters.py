#!/usr/bin/env python3
"""Derives one sprite pair per unit from the Kenney Toon Characters pack.

Run once when the roster's look changes; the output is committed, so this is not part of the
build. Same reason `recolor-ui.py` exists: the derivation has to be repeatable by someone who
was not here when the first PNG was produced.

    python scripts/recolor-characters.py .workbuddy-ai/tmp-kenney/toon src/assets/characters

Source: https://kenney.nl/assets/toon-characters (CC0 1.0). The pack ships six character
types -- two adventurers, two people, a robot and a zombie -- each in 45 poses, as
`<Type>/PNG/Poses/character_<type>_<pose>.png` at 96x128.

Why this exists at all: the roster has eight units and the pack has two types that fit the
theme (zombie against machine). Four units a side drawing the same file is the single
clearest "this is a prototype" tell on screen -- you cannot tell 腐爪 from 胀尸 without
reading the list. Two levers are available without commissioning art, and this script uses
both:

  1. **Pose.** The pack's poses are not only animation frames; a lunging arm, a spread
     stance and raised arms all hold still without looking broken. Each unit gets one, so
     the silhouettes differ.
  2. **Identity colour.** One hue band per faction carries the unit's identity -- the indigo
     tunic on a zombie, the amber eye on a robot. Everything else is left alone, so a
     recoloured unit still reads as *its side* at a glance. Recolouring the whole sprite
     would trade "four identical zombies" for "four zombies in four armies".

Anchor is untouched: every pose in the pack has an opaque bounding box that ends on the last
row (verified, `bottom_gap == 0`), so `anchor.y = 1` puts the feet on the projected position
for any of them. Figure heights do differ -- a robot is 91 px tall where a zombie is 102 --
so the top rows are trimmed here (`trim_top`) and every sprite ships at its own body height.
`content/appearance.ts` can then give all eight the same `height` and get eight figures of the
same size.
"""

from __future__ import annotations

import colorsys
import sys
from pathlib import Path

from PIL import Image

# Hue windows, in degrees, of the band that carries unit identity inside each faction.
# Everything outside the window keeps its colour, which is what preserves faction identity.
IDENTITY_BAND = {
    "Zombie": (205, 268),  # the indigo tunic; green skin and orange trousers stay put
    "Robot": (20, 80)      # the amber eye and core; the steel body stays put
}

# (unit id, pack type, idle pose, attack pose, target hue, saturation x, value x)
#
# The idle pose is a stance that holds: `attack0` is a forward lunge, `interact` a straight
# arm, `show` both arms raised, `wide` arms spread. The attack pose must differ from the idle
# one or the wind-up telegraph would draw the same frame as the stance it interrupts.
UNITS = [
    ("red-blade", "Zombie", "attack0", "attack1", 355, 1.00, 1.00),
    ("red-lancer", "Zombie", "interact", "attack0", 40, 0.22, 1.50),
    ("red-caster", "Zombie", "show", "attack1", 75, 1.15, 1.10),
    ("red-bomber", "Zombie", "wide", "attack0", 285, 1.00, 0.95),
    ("blue-skirmisher", "Robot", "attack0", "attack1", 48, 1.00, 1.00),
    ("blue-hexer", "Robot", "interact", "attack0", 185, 1.15, 1.05),
    ("blue-shrieker", "Robot", "show", "attack1", 275, 1.10, 1.05),
    ("blue-rune", "Robot", "wide", "attack0", 18, 1.10, 1.05)
]


def in_band(hue_deg: float, band: tuple[float, float]) -> bool:
    lo, hi = band
    return lo <= hue_deg <= hi


def recolor(img: Image.Image, band: tuple[float, float], hue: float, sat_x: float, val_x: float) -> Image.Image:
    """Moves the identity band to `hue`, leaving every other pixel alone."""
    out = img.convert("RGBA")
    px = out.load()
    w, h = out.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            hh, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
            if not in_band(hh * 360, band):
                continue
            s = min(1.0, s * sat_x)
            v = min(1.0, v * val_x)
            r2, g2, b2 = colorsys.hsv_to_rgb(hue / 360, s, v)
            px[x, y] = (round(r2 * 255), round(g2 * 255), round(b2 * 255), a)
    return out


def pose_path(source: Path, kind: str, pose: str) -> Path:
    return source / kind / "PNG" / "Poses" / f"character_{kind.lower()}_{pose}.png"


def trim_top(img: Image.Image) -> Image.Image:
    """Drops the empty rows above the head, and nothing else.

    The pack's frames are a uniform 96x128 while the figures inside them are between 87 and
    101 pixels tall, so a fifth of every frame is empty sky. That dead space is not harmless:
    a spec's `height` is the height of the *frame*, so drawing eight figures at one frame
    height would have drawn them at eight different body sizes, and the health bar -- placed
    above the frame -- would have floated a variable distance over each head.

    Only the top is cut. Cropping the sides as well would centre each figure's bounding box,
    and a lunging pose's box extends past the arm: the body would slide away from its own
    footprint. The horizontal centre of the frame is the character's centre, and that is worth
    keeping.
    """
    box = img.getbbox()
    if box is None:
        return img
    return img.crop((0, box[1], img.width, img.height))


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__.split("    python ")[1].split("\n")[0])
        return 2
    source = Path(sys.argv[1])
    dest = Path(sys.argv[2])
    if not source.is_dir():
        print(f"no such pack: {source}")
        return 1
    dest.mkdir(parents=True, exist_ok=True)

    for unit, kind, idle, attack, hue, sat_x, val_x in UNITS:
        band = IDENTITY_BAND[kind]
        for slot, pose in (("idle", idle), ("attack", attack)):
            src = pose_path(source, kind, pose)
            if not src.exists():
                print(f"missing pose: {src}")
                return 1
            img = trim_top(recolor(Image.open(src), band, hue, sat_x, val_x))
            target = dest / f"{unit}-{slot}.png"
            img.save(target, optimize=True)
            print(f"  {target.name:26s} pose={pose:9s} {img.width}x{img.height}  {target.stat().st_size // 1024} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
