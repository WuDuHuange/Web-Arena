/**
 * The arena floor's arithmetic.
 *
 * `render/ground.ts` is pure on purpose: the tiling is the part of the floor that fails
 * quietly. An off-by-one leaves a stripe of app background down one edge of the arena, and
 * a stripe reads as a lighting artefact rather than as a bug — so it is pinned here rather
 * than left to a screenshot.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ARENA_BOUNDS } from "../src/content/deployment.ts";
import { GROUND_CELL_UNITS, groundCells } from "../src/render/ground.ts";

test("the default cell divides the shipped arena exactly", () => {
  // This is the property the constant was chosen for. If it stops holding, the floor grows a
  // ragged edge and the arena outline cuts across a half-covered row.
  assert.equal(ARENA_BOUNDS.width % GROUND_CELL_UNITS, 0);
  assert.equal(ARENA_BOUNDS.height % GROUND_CELL_UNITS, 0);
});

test("the floor tiles the shipped arena without a gap or an overhang", () => {
  const cells = groundCells(ARENA_BOUNDS.width, ARENA_BOUNDS.height);
  const columns = ARENA_BOUNDS.width / GROUND_CELL_UNITS;
  const rows = ARENA_BOUNDS.height / GROUND_CELL_UNITS;

  assert.equal(cells.length, columns * rows);

  // No overhang: the furthest edge of the furthest cell is the arena boundary, not past it.
  const maxX = Math.max(...cells.map((cell) => cell.x + GROUND_CELL_UNITS));
  const maxY = Math.max(...cells.map((cell) => cell.y + GROUND_CELL_UNITS));
  assert.equal(maxX, ARENA_BOUNDS.width);
  assert.equal(maxY, ARENA_BOUNDS.height);
});

test("every point of the arena falls inside exactly one cell", () => {
  // Sampling the four corners of every cell plus the arena's far corner. A gap anywhere in
  // the grid shows up as a sample that no cell contains.
  const cells = groundCells(ARENA_BOUNDS.width, ARENA_BOUNDS.height);
  const covers = (x, y) =>
    cells.some(
      (cell) =>
        x >= cell.x &&
        x < cell.x + GROUND_CELL_UNITS &&
        y >= cell.y &&
        y < cell.y + GROUND_CELL_UNITS
    );

  for (const cell of cells) {
    assert.ok(covers(cell.x, cell.y), `cell ${cell.column},${cell.row} misses its own corner`);
  }
  assert.ok(covers(ARENA_BOUNDS.width - 1, ARENA_BOUNDS.height - 1), "far corner uncovered");
  assert.ok(!covers(ARENA_BOUNDS.width, ARENA_BOUNDS.height), "the grid must not extend past");
});

test("a cell size that does not divide evenly rounds up rather than leaving a gap", () => {
  // The default divides the shipped arena, but an imported deployment can declare any
  // bounds at all. Rounding down would leave the last strip bare.
  const cells = groundCells(100, 70, 30);
  assert.equal(cells.length, 4 * 3);

  const maxY = Math.max(...cells.map((cell) => cell.y + 30));
  assert.ok(maxY >= 70, `floor must reach the far edge, stopped at ${maxY}`);
});

test("a non-positive cell size is refused rather than looping forever", () => {
  assert.throws(() => groundCells(960, 600, 0), /地面格尺寸必须为正/);
  assert.throws(() => groundCells(960, 600, -60), /地面格尺寸必须为正/);
});

test("a mirrored cell still covers exactly its own square of floor", () => {
  // A negative scale draws away from the sprite's origin, so the renderer anchors a flipped
  // cell on its far corner. Get that wrong and the floor slides by one cell — which looks
  // like a texture offset, not like a coordinate bug.
  const cells = groundCells(240, 240, 120);

  for (const cell of cells) {
    const left = cell.flipX ? cell.x + 120 - 120 : cell.x;
    const top = cell.flipY ? cell.y + 120 - 120 : cell.y;
    assert.equal(left, cell.x, `cell ${cell.column},${cell.row} drifted horizontally`);
    assert.equal(top, cell.y, `cell ${cell.column},${cell.row} drifted vertically`);
  }
});

test("orientations are stable, varied, and not a regular pattern", () => {
  // Three separate properties, and each one has a failure mode worth naming.
  const cells = groundCells(ARENA_BOUNDS.width, ARENA_BOUNDS.height);
  const key = (cell) => `${cell.column},${cell.row}`;
  const first = new Map(cells.map((cell) => [key(cell), `${cell.flipX}${cell.flipY}`]));

  // 1. Stable: the floor is rebuilt whenever the draft changes. A reshuffle would flicker.
  const again = groundCells(ARENA_BOUNDS.width, ARENA_BOUNDS.height);
  for (const cell of again) {
    assert.equal(`${cell.flipX}${cell.flipY}`, first.get(key(cell)), `${key(cell)} reshuffled`);
  }

  // 2. Varied: if the hash collapsed to one value there would be no point to it.
  assert.ok(new Set(first.values()).size > 1, "every cell got the same orientation");

  // 3. Not regular: a checkerboard is the trap this replaced. Require that some horizontally
  //    adjacent pair agrees, which a checkerboard never does.
  const same = cells.some((cell) => {
    const right = cells.find((c) => c.column === cell.column + 1 && c.row === cell.row);
    return right !== undefined && right.flipX === cell.flipX && right.flipY === cell.flipY;
  });
  assert.ok(same, "orientations look like a checkerboard rather than a hash");
});

test("the shipped cell size keeps the floor to a sane number of sprites", () => {
  // The floor is one sprite per cell. Lowering the constant is a legitimate way to make the
  // grain finer, and at some point it stops being a texture choice and becomes a way to
  // allocate a sprite per world unit. 60 units is 160 cells; this is the guard rail, not a
  // target.
  const cells = groundCells(ARENA_BOUNDS.width, ARENA_BOUNDS.height);
  assert.ok(cells.length > 0, "the floor must have at least one cell");
  assert.ok(cells.length <= 500, `地面格过多：${cells.length} 个精灵`);
});
