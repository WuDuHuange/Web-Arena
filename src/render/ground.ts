/**
 * The arena floor.
 *
 * Pure: no Pixi, no DOM, no imports at all. `battlefield.ts` does the drawing; this module
 * owns the two decisions that are worth being able to test without a renderer — what shape
 * of material the floor wants, and how the cells tile it.
 *
 * ## Why the material is a square and not an isometric tile
 *
 * The ground layer carries the projection matrix, and that matrix *is* the isometric
 * transform. A world-space square of side S maps to
 *
 *     (0,0) → (0, 0)      (S,0) → (0.5S, 0.25S)
 *     (S,S) → (0, 0.5S)   (0,S) → (-0.5S, 0.25S)
 *
 * — a rhombus with a horizontal diagonal of S and a vertical diagonal of 0.5S, which is the
 * 2:1 diamond every isometric game uses. The diamond is *computed*, not drawn.
 *
 * So the floor wants a **square, top-down, seamless** texture. A pre-drawn isometric diamond
 * — which is what Kenney's isometric packs contain, and what this project first reached for —
 * would be sheared a second time by the same matrix and come out the wrong shape. That is
 * also why the square is the right answer in both views at once: under `flat` the matrix is
 * the identity, and a square floor in a top-down view is simply correct.
 */

/**
 * World units per floor cell.
 *
 * 120 divides both 960 and 600 exactly, so the floor has no ragged edge — 8 x 5 cells, and
 * the last row and column end on the arena boundary rather than overhanging it. An
 * overhanging cell is not a cosmetic detail: the arena outline is drawn on top of the floor,
 * so an overhang reads as the floor escaping its own border.
 *
 * This number is a texel-density choice, not a grid choice — the material is seamless, so
 * there is no visible cell boundary either way. 120 units is about 152 screen pixels at the
 * fit scale the arena actually gets, which puts the 512px texture at roughly three texels
 * per pixel: enough for the stones in the material to stay legible, and not so little that
 * the whole floor averages out into a flat colour. Going finer than this is what a first
 * pass at 60 units did, and the ground came out as a smooth brown wash with no structure.
 */
export const GROUND_CELL_UNITS = 120;

/**
 * Multiplied into the material.
 *
 * The source is mid-brown earth with pale stones. At full strength it competes with the
 * units, which are flat saturated discs and have to stay the brightest thing on screen. This
 * tint darkens it and cools it toward the app's blue-grey, so the floor reads as packed
 * ground under a night sky rather than as daylight dirt.
 */
export const GROUND_TINT = 0xb4bac2;

export interface GroundCell {
  readonly column: number;
  readonly row: number;
  /** Top-left corner in world coordinates. Always the corner, whichever way the cell flips. */
  readonly x: number;
  readonly y: number;
  /**
   * Whether the material is mirrored on this cell, per axis.
   *
   * A seamless texture tiled straight still repeats on an exact lattice, and this material
   * has landmarks in it — clusters of pale stones — so the lattice is visible: the same
   * cluster turns up every 120 units and the eye finds the grid immediately.
   *
   * Two ways to break that, and only one of them works. Mirroring on a *checkerboard* is the
   * obvious move and it is the wrong one: it puts a mirror line on every cell boundary, the
   * eye reads those as axes of symmetry, and the floor comes out looking like a kaleidoscope
   * — a worse artefact than the lattice it was meant to hide. Mirrored *irregularly* has no
   * symmetry to find, and the repeat period goes back to the whole floor.
   *
   * It stays seamless either way: a mirrored seamless texture still meets its neighbour on
   * the same edge values. Only the derivative flips, and for a noisy material that is
   * invisible.
   */
  readonly flipX: boolean;
  readonly flipY: boolean;
}

/**
 * Picks one of four orientations for a cell, from its coordinates.
 *
 * Deterministic rather than random: a battlefield is rebuilt every time the draft changes,
 * and a floor that reshuffled itself on each rebuild would flicker while the player drags a
 * unit. Same cell, same orientation, always.
 *
 * The hash is the usual xor-shift mix. It does not need to be a good hash — it needs to
 * decorrelate neighbours, which is exactly what a lattice is not.
 */
function orientationOf(column: number, row: number): { flipX: boolean; flipY: boolean } {
  let h = (column * 374761393 + row * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  const bits = Math.abs(h) % 4;
  return { flipX: (bits & 1) === 1, flipY: (bits & 2) === 2 };
}

/**
 * The cells that tile a `width` x `height` arena.
 *
 * Pure and exported because the arithmetic fails quietly: an off-by-one here leaves a stripe
 * of app background down one edge of the arena, and a stripe reads as a lighting artefact
 * rather than as a bug. `tests/ground.test.mjs` pins it instead.
 */
export function groundCells(
  width: number,
  height: number,
  cell: number = GROUND_CELL_UNITS
): readonly GroundCell[] {
  if (!(cell > 0)) {
    throw new Error(`地面格尺寸必须为正，收到 ${cell}`);
  }
  const cells: GroundCell[] = [];
  const columns = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const { flipX, flipY } = orientationOf(column, row);
      cells.push({ column, row, x: column * cell, y: row * cell, flipX, flipY });
    }
  }
  return cells;
}
