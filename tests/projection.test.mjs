/**
 * Projection tests.
 *
 * The 2.5D view rests on one claim: an isometric projection of the ground plane is a linear
 * map, so flat things project for free and only upright things need per-entity work. These
 * tests pin the map itself, because every failure mode it has is silent on screen:
 *
 *   - an inverse that is not quite the inverse — the cursor and the unit it drags drift
 *     apart, further the further you are from the origin, and nothing throws
 *   - a depth key that is *almost* right — units swap in front of each other only on two
 *     sides of the diamond, which reads as a rendering glitch rather than a wrong formula
 *   - a matrix that disagrees with `project` — the ground and the sprites land in two
 *     different arenas, and the gap grows towards the corners
 *
 * All three are pure arithmetic, so they are all assertable here. The pixel half — that the
 * screen actually shows a diamond, and that clicking still selects the unit under the
 * cursor — is `scripts/verify-iso.mjs`, because it needs a canvas.
 *
 * Run with: npm run test:projection
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createProjector, projectionKindFrom } from "../src/render/projection.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

/** A non-square arena, because a square one hides a transposed axis. */
const ARENA = { width: 960, height: 600 };
const OTHER_ARENA = { width: 640, height: 480 };

const flat = createProjector("flat", ARENA);
const iso = createProjector("iso", ARENA);

/** Corners plus interior points, so a round-trip failure cannot hide at the origin. */
const SAMPLES = [
  { x: 0, y: 0 },
  { x: ARENA.width, y: 0 },
  { x: 0, y: ARENA.height },
  { x: ARENA.width, y: ARENA.height },
  { x: ARENA.width / 2, y: ARENA.height / 2 },
  { x: 137, y: 41 },
  { x: 480, y: 12.5 },
  { x: 3, y: 599 }
];

const near = (a, b, epsilon = 1e-9) => Math.abs(a - b) <= epsilon;

// --- flat is the shipped default, and must stay inert ------------------------

test("flat projection is the identity", () => {
  for (const point of SAMPLES) {
    const projected = flat.project(point.x, point.y);
    assert.equal(projected.x, point.x);
    assert.equal(projected.y, point.y);
  }
});

test("flat matrix is the identity matrix", () => {
  assert.deepEqual(flat.matrix(), { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 });
});

test("flat does not opt into depth sorting", () => {
  // The flat renderer draws in creation order and is verified against that. Sorting here
  // would be a behaviour change smuggled in under a projection flag.
  assert.equal(flat.sortable, false);
});

test("flat reports the arena's own size, so the fit step is unchanged", () => {
  assert.deepEqual(flat.projectedExtent(), { width: ARENA.width, height: ARENA.height });
});

// --- the inverse has to be an inverse ---------------------------------------

test("iso round-trips every sample back to where it started", () => {
  for (const point of SAMPLES) {
    const projected = iso.project(point.x, point.y);
    const back = iso.unproject(projected.x, projected.y);
    assert.ok(
      near(back.x, point.x, 1e-9) && near(back.y, point.y, 1e-9),
      `round trip drifted for (${point.x}, ${point.y}) -> (${projected.x}, ${projected.y}) -> (${back.x}, ${back.y})`
    );
  }
});

test("iso round-trips an arbitrary grid, not just the corners", () => {
  for (let x = 0; x <= ARENA.width; x += 37) {
    for (let y = 0; y <= ARENA.height; y += 29) {
      const projected = iso.project(x, y);
      const back = iso.unproject(projected.x, projected.y);
      assert.ok(near(back.x, x, 1e-8) && near(back.y, y, 1e-8), `drifted at (${x}, ${y})`);
    }
  }
});

test("iso round-trips in a different arena size", () => {
  // The offset term is derived from the arena height. A hard-coded one passes for the
  // shipped arena and fails the moment an imported deployment declares different bounds.
  const other = createProjector("iso", OTHER_ARENA);
  for (const point of SAMPLES) {
    const clamped = { x: Math.min(point.x, OTHER_ARENA.width), y: Math.min(point.y, OTHER_ARENA.height) };
    const projected = other.project(clamped.x, clamped.y);
    const back = other.unproject(projected.x, projected.y);
    assert.ok(near(back.x, clamped.x, 1e-9) && near(back.y, clamped.y, 1e-9));
  }
});

test("iso unproject is not the identity, so the round trip is actually exercised", () => {
  // Guards the test itself: if `unproject` were accidentally `(x, y) => ({x, y})`, every
  // round-trip assertion above would still pass while the editor dragged units to nonsense.
  const projected = iso.project(137, 41);
  assert.ok(!near(projected.x, 137) || !near(projected.y, 41));
});

// --- matrix and project must be the same map --------------------------------

test("iso matrix agrees with iso project", () => {
  const { a, b, c, d, tx, ty } = iso.matrix();
  for (const point of SAMPLES) {
    const viaMatrix = { x: a * point.x + c * point.y + tx, y: b * point.x + d * point.y + ty };
    const viaProject = iso.project(point.x, point.y);
    assert.ok(
      near(viaMatrix.x, viaProject.x, 1e-9) && near(viaMatrix.y, viaProject.y, 1e-9),
      `matrix and project disagree at (${point.x}, ${point.y})`
    );
  }
});

test("iso matrix has no translation in y and a positive x offset", () => {
  // The offset exists to bring the arena's left corner back to x = 0. If it were dropped,
  // half the arena would sit at negative x and the fit step would clip it.
  const { tx, ty } = iso.matrix();
  assert.ok(tx > 0);
  assert.equal(ty, 0);
});

// --- the projected arena is a diamond ---------------------------------------

test("iso puts the four arena corners at four distinct extreme points", () => {
  const top = iso.project(0, 0);
  const right = iso.project(ARENA.width, 0);
  const bottom = iso.project(ARENA.width, ARENA.height);
  const left = iso.project(0, ARENA.height);

  // Origin is the top of the diamond; the opposite corner is the bottom. That is the
  // defining property of an isometric view and the one a wrong sign flips.
  assert.ok(top.y < right.y && top.y < left.y && top.y < bottom.y);
  assert.ok(bottom.y > right.y && bottom.y > left.y);
  assert.ok(left.x < top.x && left.x < bottom.x);
  assert.ok(right.x > top.x && right.x > bottom.x);
});

test("iso projects a ground circle into a 2:1 ellipse", () => {
  // The whole reason `props.ts` needs no changes: a circle drawn in world units through the
  // matrix comes out as the correctly-shaped ellipse.
  //
  // The ellipse's axes are the matrix's *singular values*, not its columns. The columns are
  // the images of the basis vectors, which is a different pair of vectors — asserting on
  // those was the first version of this test and it was wrong, even though the conclusion it
  // was checking is right. For a 2x2 the singular values come out of the characteristic
  // polynomial of MᵀM.
  const { a, b, c, d } = iso.matrix();
  const trace = a * a + b * b + c * c + d * d;
  const determinant = a * d - b * c;
  const spread = Math.sqrt(Math.max((trace * trace) / 4 - determinant * determinant, 0));
  const major = Math.sqrt(Math.max(trace / 2 + spread, 0));
  const minor = Math.sqrt(Math.max(trace / 2 - spread, 0));

  assert.ok(minor > 0, "a ground circle must not collapse to a line");
  assert.ok(near(major / minor, 2, 1e-12), `expected a 2:1 ellipse, got ${major / minor}`);
});

test("iso projected extent matches the corners it is derived from", () => {
  const extent = iso.projectedExtent();
  const xs = [iso.project(0, 0).x, iso.project(ARENA.width, 0).x, iso.project(0, ARENA.height).x, iso.project(ARENA.width, ARENA.height).x];
  const ys = [iso.project(0, 0).y, iso.project(ARENA.width, 0).y, iso.project(0, ARENA.height).y, iso.project(ARENA.width, ARENA.height).y];

  assert.ok(near(extent.width, Math.max(...xs) - Math.min(...xs), 1e-9));
  assert.ok(near(extent.height, Math.max(...ys) - Math.min(...ys), 1e-9));
  assert.ok(near(Math.min(...xs), 0, 1e-9), "the projected arena must start at x = 0");
  assert.ok(near(Math.min(...ys), 0, 1e-9), "the projected arena must start at y = 0");
});

test("iso projected extent is twice as wide as it is tall", () => {
  const extent = iso.projectedExtent();
  assert.ok(near(extent.width / extent.height, 2, 1e-9));
});

// --- depth -------------------------------------------------------------------

test("iso depth increases as a point comes towards the viewer", () => {
  assert.ok(iso.depth(0, 0) < iso.depth(100, 0));
  assert.ok(iso.depth(0, 0) < iso.depth(0, 100));
  assert.ok(iso.depth(150, 150) > iso.depth(200, 0));
});

test("iso depth and screen height order points identically", () => {
  // Worth pinning because the obvious guess — that y-sorting is an approximation that breaks
  // on the diamond's side faces — is wrong. Screen y is `(x + y) * k` for a constant k, so
  // the two orderings are the same ordering. If a perspective camera ever replaces this
  // parallel one, this test is the thing that will fail and tell us.
  const points = [];
  for (let x = 0; x <= ARENA.width; x += 97) {
    for (let y = 0; y <= ARENA.height; y += 61) {
      points.push({ x, y });
    }
  }

  const sign = (value) => (value > 0 ? 1 : value < 0 ? -1 : 0);
  for (const p of points) {
    for (const q of points) {
      const byDepth = sign(iso.depth(p.x, p.y) - iso.depth(q.x, q.y));
      const byHeight = sign(iso.project(p.x, p.y).y - iso.project(q.x, q.y).y);
      assert.equal(byDepth, byHeight, `depth and screen height disagree between (${p.x},${p.y}) and (${q.x},${q.y})`);
    }
  }
});

test("iso opts into depth sorting", () => {
  assert.equal(iso.sortable, true);
});

test("flat depth falls back to screen height", () => {
  assert.equal(flat.depth(500, 120), 120);
});

// --- determinism and purity --------------------------------------------------

test("the same input always produces the same output", () => {
  const first = iso.project(321, 123);
  for (let i = 0; i < 100; i += 1) {
    assert.deepEqual(iso.project(321, 123), first);
  }
});

test("projection.ts imports nothing", () => {
  // Same discipline as `content/appearance.ts`. A projection that could reach the content
  // library or the renderer is a projection that could start depending on them, and this
  // module is meant to stay a decision rather than an execution.
  const source = readFileSync(join(ROOT, "src", "render", "projection.ts"), "utf8");
  assert.equal(/^\s*import\s/m.test(source), false, "projection.ts must not import anything");
});

// --- query parameter ---------------------------------------------------------

test("only the literal iso selects the isometric view", () => {
  assert.equal(projectionKindFrom("iso"), "iso");
  for (const value of [null, undefined, "", "flat", "ISO", "iso ", "isometric"]) {
    assert.equal(projectionKindFrom(value), "flat", `${String(value)} should fall back to flat`);
  }
});
