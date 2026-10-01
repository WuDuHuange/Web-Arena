/**
 * Phase 1 pressure assertions.
 *
 * These are head-less: no DOM, no renderer, no browser. They pin the three failure
 * modes the architecture document promised to rule out, plus a few numeric sanity
 * bounds that catch a solver silently going unstable.
 *
 * Run with: npm run test:pressure
 */
import assert from "node:assert/strict";
import test from "node:test";

import { Simulation } from "../src/simulation/simulation.ts";
import {
  PRESSURE_BOUNDS,
  compressionSetup,
  cornerSetup,
  pressureSetup,
  tunnellingSetup
} from "../src/simulation/pressure.ts";

const FIXED_STEP_MS = 1000 / 60;

/** Steps the whole scene forward by an exact number of authoritative ticks. */
function runTicks(sim, ticks) {
  for (let i = 0; i < ticks; i += 1) {
    sim.step();
  }
}

function assertAllFinite(sim, label) {
  for (const entity of sim.snapshot().entities) {
    const { x, y } = entity.transform.position;
    const { x: vx, y: vy } = entity.motion.velocity;
    assert.ok(Number.isFinite(x) && Number.isFinite(y), `${label}: entity ${entity.id} position went non-finite`);
    assert.ok(
      Number.isFinite(vx) && Number.isFinite(vy),
      `${label}: entity ${entity.id} velocity went non-finite`
    );
  }
}

/** Every dynamic body must stay inside the walls, within its own radius. */
function assertInsideBounds(sim, label, slack = 4) {
  for (const entity of sim.snapshot().entities) {
    if (entity.collider.fixed) {
      continue;
    }
    const { x, y } = entity.transform.position;
    const r = entity.collider.radius + slack;
    assert.ok(x >= -r && x <= PRESSURE_BOUNDS.width + r, `${label}: entity ${entity.id} escaped on x (x=${x})`);
    assert.ok(y >= -r && y <= PRESSURE_BOUNDS.height + r, `${label}: entity ${entity.id} escaped on y (y=${y})`);
  }
}

test("baseline load builds 100 units and 20 props", () => {
  const setup = pressureSetup({ fixedStepMs: FIXED_STEP_MS, units: 100, props: 20 });
  assert.equal(setup.spawns.filter((s) => s.kind === "unit").length, 100);
  assert.equal(setup.spawns.filter((s) => s.kind === "prop").length, 20);

  const sim = new Simulation(setup);
  assert.equal(sim.snapshot().entities.length, 120);
});

test("baseline load stays numerically stable over a long run", () => {
  const sim = new Simulation(pressureSetup({ fixedStepMs: FIXED_STEP_MS, units: 100, props: 20 }));
  runTicks(sim, 1800); // 30 seconds of battle time

  assertAllFinite(sim, "baseline");
  assertInsideBounds(sim, "baseline");
  assert.equal(sim.tick, 1800);
});

test("dense crowding does not tunnel bodies past each other", () => {
  const sim = new Simulation(compressionSetup({ fixedStepMs: FIXED_STEP_MS, units: 100, props: 20 }));
  runTicks(sim, 900);

  assertAllFinite(sim, "compression");

  // Both side piles should still be on their own half. A solver that lets overlapping
  // bodies slip through would let one faction cross the midline en masse.
  const entities = sim.snapshot().entities.filter((e) => e.kind === "unit");
  const midline = PRESSURE_BOUNDS.width / 2;
  const crossed = entities.filter((e) =>
    e.faction === "red" ? e.transform.position.x > midline + 60 : e.transform.position.x < midline - 60
  );
  assert.ok(entities.length === 100, "expected 100 units");
  // A few stragglers squeezing past is plausible; wholesale interpenetration is not.
  assert.ok(crossed.length <= 5, `too many units crossed the midline: ${crossed.length}`);
});

test("corner pile-up does not wedge or escape the walls", () => {
  const sim = new Simulation(cornerSetup({ fixedStepMs: FIXED_STEP_MS, units: 100, props: 20 }));
  runTicks(sim, 1200);

  assertAllFinite(sim, "corner");
  assertInsideBounds(sim, "corner");

  // Nothing may end up permanently buried in the corner at rest outside the arena.
  const r = 12 + 8;
  for (const entity of sim.snapshot().entities) {
    if (entity.collider.fixed) {
      continue;
    }
    const { x, y } = entity.transform.position;
    assert.ok(x > -r && y > -r, `entity ${entity.id} wedged through the top-left wall (${x}, ${y})`);
  }
});

test("fast projectiles do not pass through static props", () => {
  const setup = tunnellingSetup({ fixedStepMs: FIXED_STEP_MS });
  const sim = new Simulation(setup);
  const projectileIds = new Set(
    setup.spawns
      .map((spawn, index) => ({ spawn, index }))
      .filter(({ spawn }) => spawn.kind === "projectile")
      // World assigns ids in insertion order, 1-based.
      .map(({ index }) => index + 1)
  );
  assert.equal(projectileIds.size, 8, "expected 8 projectiles");

  runTicks(sim, 120);
  assertAllFinite(sim, "tunnelling");

  const wallX = PRESSURE_BOUNDS.width - 120;
  for (const entity of sim.snapshot().entities) {
    if (!projectileIds.has(entity.id)) {
      continue;
    }
    // A projectile launched at 1500 u/s must not be found on the far side of the prop row
    // without ever registering contact. Stopping short of the wall column is the signal.
    assert.ok(
      entity.transform.position.x < wallX + 40,
      `projectile ${entity.id} tunnelled past the prop row (x=${entity.transform.position.x})`
    );
    assert.ok(
      entity.motion.velocity.x < 1500,
      `projectile ${entity.id} never lost speed, suggesting it never collided`
    );
  }
});

test("pressure scenes advance at the authoritative rate regardless of frame chunking", () => {
  const setup = pressureSetup({ fixedStepMs: FIXED_STEP_MS, units: 100, props: 20 });

  const smooth = new Simulation(setup);
  for (let i = 0; i < 600; i += 1) {
    smooth.advance(FIXED_STEP_MS);
  }

  const chunky = new Simulation(setup);
  for (let i = 0; i < 100; i += 1) {
    chunky.advance(FIXED_STEP_MS * 6);
  }

  assert.equal(smooth.tick, 600);
  assert.equal(chunky.tick, 600);

  const a = smooth.snapshot().entities;
  const b = chunky.snapshot().entities;
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i += 1) {
    assert.ok(
      Math.abs(a[i].transform.position.x - b[i].transform.position.x) < 1e-9,
      `entity ${a[i].id} diverged between frame chunkings`
    );
    assert.ok(
      Math.abs(a[i].transform.position.y - b[i].transform.position.y) < 1e-9,
      `entity ${a[i].id} diverged between frame chunkings`
    );
  }
});
