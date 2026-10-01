/**
 * Hit-geometry assertions.
 *
 * The whole point of keeping geometry as pure functions is that it can be pinned down
 * exactly here, with no engine and no browser. Every test states a geometric situation
 * and asserts the boundary behaviour, including the cases that read as bugs when they
 * are wrong (whiffing at point-blank, hitting behind the caster).
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  angleDelta,
  headingTo,
  hitsCone,
  hitsLine,
  hitsMelee,
  hitsTarget,
  normalizeAngle,
  turnToward
} from "../src/simulation/geometry.ts";

const ORIGIN = { x: 0, y: 0 };
const FACING_EAST = 0;

/** Facing east: +angle is downward on screen, which matches atan2(y, x). */
test("melee hits ahead of the caster but not behind", () => {
  const geometry = { kind: "melee", range: 20 };
  const front = { x: 30, y: 0, radius: 10 };
  const back = { x: -30, y: 0, radius: 10 };

  assert.equal(hitsMelee(ORIGIN, 10, FACING_EAST, geometry, front), true, "ahead must be hit");
  assert.equal(hitsMelee(ORIGIN, 10, FACING_EAST, geometry, back), false, "behind must be missed");
});

test("melee range is measured from the caster edge, not the centre", () => {
  const geometry = { kind: "melee", range: 20 };
  // Caster radius 10 plus reach 20 puts the strike centre at x=20 with radius 10, so it
  // reaches x=30. A target at x=45 (edge at 35) is out of reach; at x=40 (edge at 30) it
  // is exactly on the boundary.
  assert.equal(hitsMelee(ORIGIN, 10, FACING_EAST, geometry, { x: 45, y: 0, radius: 10 }), false);
  assert.equal(hitsMelee(ORIGIN, 10, FACING_EAST, geometry, { x: 40, y: 0, radius: 10 }), true);
});

test("cone respects its half-angle but forgives near targets", () => {
  const geometry = { kind: "cone", range: 200, halfAngle: Math.PI / 6 }; // 30 degrees

  // On-axis at distance 100 is inside.
  assert.equal(hitsCone(ORIGIN, 10, FACING_EAST, geometry, { x: 100, y: 0, radius: 10 }), true);

  // 45 degrees off at distance 100 is a 13.5 degree miss once slack is accounted for,
  // which is outside a 30 degree half-angle.
  const off45 = { x: 100 * Math.cos(Math.PI / 4), y: 100 * Math.sin(Math.PI / 4), radius: 10 };
  assert.equal(hitsCone(ORIGIN, 10, FACING_EAST, geometry, off45), false);

  // At 20 degrees it is inside the 30 degree half-angle.
  const off20 = { x: 100 * Math.cos(Math.PI / 9), y: 100 * Math.sin(Math.PI / 9), radius: 10 };
  assert.equal(hitsCone(ORIGIN, 10, FACING_EAST, geometry, off20), true);

  // Point-blank behind the caster: the closing circle catches it, because standing inside
  // the caster's own footprint is a hit regardless of angle.
  assert.equal(hitsCone(ORIGIN, 10, FACING_EAST, geometry, { x: -5, y: 0, radius: 10 }), true);
});

test("cone ignores targets beyond its range", () => {
  const geometry = { kind: "cone", range: 100, halfAngle: Math.PI / 3 };
  assert.equal(hitsCone(ORIGIN, 10, FACING_EAST, geometry, { x: 90, y: 0, radius: 10 }), true);
  assert.equal(hitsCone(ORIGIN, 10, FACING_EAST, geometry, { x: 200, y: 0, radius: 10 }), false);
});

test("line hits along its axis and misses to the side", () => {
  const geometry = { kind: "line", range: 300, width: 20 };

  assert.equal(hitsLine(ORIGIN, 10, FACING_EAST, geometry, { x: 150, y: 0, radius: 10 }), true);
  // Perpendicular offset of 40 from the axis, with half-width 10 and target radius 10,
  // is a 20 unit miss.
  assert.equal(hitsLine(ORIGIN, 10, FACING_EAST, geometry, { x: 150, y: 40, radius: 10 }), false);
  // Offset of 15 is within half-width 10 plus radius 10.
  assert.equal(hitsLine(ORIGIN, 10, FACING_EAST, geometry, { x: 150, y: 15, radius: 10 }), true);
});

test("line does not extend behind the caster", () => {
  const geometry = { kind: "line", range: 300, width: 20 };
  assert.equal(hitsLine(ORIGIN, 10, FACING_EAST, geometry, { x: -150, y: 0, radius: 10 }), false);
});

test("line stops at its stated range", () => {
  const geometry = { kind: "line", range: 100, width: 20 };
  assert.equal(hitsLine(ORIGIN, 10, FACING_EAST, geometry, { x: 105, y: 0, radius: 10 }), true);
  assert.equal(hitsLine(ORIGIN, 10, FACING_EAST, geometry, { x: 130, y: 0, radius: 10 }), false);
});

test("area is centred on the caster by default and on the aim point when asked", () => {
  const onCaster = { kind: "circle", range: 50, centredOnCaster: true };
  assert.equal(hitsTarget(onCaster, ORIGIN, 10, FACING_EAST, { x: 40, y: 0, radius: 5 }), true);
  assert.equal(hitsTarget(onCaster, ORIGIN, 10, FACING_EAST, { x: 100, y: 0, radius: 5 }), false);

  const aimed = { kind: "circle", range: 50, centredOnCaster: false };
  const aim = { x: 300, y: 300 };
  assert.equal(hitsTarget(aimed, ORIGIN, 10, FACING_EAST, { x: 310, y: 300, radius: 5 }, aim), true);
  assert.equal(hitsTarget(aimed, ORIGIN, 10, FACING_EAST, { x: 0, y: 0, radius: 5 }, aim), false);
});

test("angle helpers normalise into a single turn and pick the short way round", () => {
  assert.equal(normalizeAngle(0), 0);
  assert.ok(Math.abs(normalizeAngle(Math.PI * 3) - Math.PI) < 1e-9);
  assert.ok(Math.abs(normalizeAngle(-Math.PI * 3) - Math.PI) < 1e-9);

  // Crossing the +/-PI seam must read as a small turn, not a nearly-full one.
  const delta = angleDelta(Math.PI - 0.1, -Math.PI + 0.1);
  assert.ok(Math.abs(delta) < 0.25, `expected a small turn across the seam, got ${delta}`);
});

test("turnToward moves gradually and never overshoots", () => {
  const step = 0.1;
  let facing = 0;
  for (let i = 0; i < 100; i += 1) {
    facing = turnToward(facing, Math.PI / 2, step);
  }
  assert.ok(Math.abs(facing - Math.PI / 2) < 1e-9, `expected to settle on the target, got ${facing}`);

  // A small requested turn lands exactly, without wrapping past the goal.
  const small = turnToward(0, 0.05, step);
  assert.ok(Math.abs(small - 0.05) < 1e-9);
});

test("headingTo points from one body to another", () => {
  assert.ok(Math.abs(headingTo(ORIGIN, { x: 10, y: 0 })) < 1e-9);
  assert.ok(Math.abs(headingTo(ORIGIN, { x: 0, y: 10 }) - Math.PI / 2) < 1e-9);
  assert.ok(Math.abs(Math.abs(headingTo(ORIGIN, { x: -10, y: 0 })) - Math.PI) < 1e-9);
});

test("an unknown geometry kind is rejected rather than silently missing", () => {
  // Guards the switch in hitsTarget: adding a kind to the type without handling it here
  // must fail loudly instead of turning every attack into a no-op.
  const bogus = { kind: "hexagon", range: 10 };
  assert.throws(() => hitsTarget(bogus, ORIGIN, 10, 0, { x: 5, y: 0, radius: 1 }));
});
