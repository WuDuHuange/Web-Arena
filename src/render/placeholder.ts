import type { Graphics } from "pixi.js";
import { PLACEHOLDER_COLOR, PLACEHOLDER_DASHES_PER_SIDE } from "../content/appearance.ts";

/**
 * The "this unit's art is broken" marker.
 *
 * Kept apart from the decision that produces it, because the two have different lifetimes:
 * `content/appearance.ts` is a pure table that a head-less test can drive, and this is the
 * only part of the appearance layer that needs a canvas.
 *
 * No text. A `Graphics` cannot draw any, and pulling in a font to label a failure would cost
 * more than the failure. The key and the reason are reported in the panel instead, which is
 * where a person looks after seeing this. The shape exists for one purpose only: to be
 * impossible to mistake for the procedural grey box, so "the file did not load" is visible
 * from across the room without opening the console.
 */
export function drawAppearancePlaceholder(
  gfx: Graphics,
  x: number,
  y: number,
  radius: number
): void {
  gfx.clear();

  const half = Math.max(radius, 6);
  const inset = half * 0.34;
  // Each side is split into `PLACEHOLDER_DASHES_PER_SIDE` dashes of equal length with equal
  // gaps. Pixi has no dashed stroke, and consecutive arc segments of one path join into a
  // solid line — so the dashes are separate `moveTo`/`lineTo` pairs that share one stroke.
  const segment = (half * 2) / (PLACEHOLDER_DASHES_PER_SIDE * 2);

  for (let side = 0; side < 4; side += 1) {
    for (let i = 0; i < PLACEHOLDER_DASHES_PER_SIDE; i += 1) {
      const from = -half + i * 2 * segment;
      const to = from + segment;
      switch (side) {
        case 0:
          gfx.moveTo(x + from, y - half);
          gfx.lineTo(x + to, y - half);
          break;
        case 1:
          gfx.moveTo(x + half, y + from);
          gfx.lineTo(x + half, y + to);
          break;
        case 2:
          gfx.moveTo(x - from, y + half);
          gfx.lineTo(x - to, y + half);
          break;
        default:
          gfx.moveTo(x - half, y - from);
          gfx.lineTo(x - half, y - to);
          break;
      }
    }
  }
  gfx.stroke({ width: 2, color: PLACEHOLDER_COLOR, alpha: 0.95 });

  // A diagonal cross, so the marker survives being scaled down or viewed at a glance.
  gfx.moveTo(x - inset, y - inset);
  gfx.lineTo(x + inset, y + inset);
  gfx.moveTo(x + inset, y - inset);
  gfx.lineTo(x - inset, y + inset);
  gfx.stroke({ width: 2, color: PLACEHOLDER_COLOR, alpha: 0.8 });
}
