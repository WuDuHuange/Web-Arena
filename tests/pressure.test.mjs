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
import { stressMatchup } from "../src/content/deployment.ts";

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

test("the browser stress scene really fields 100 units and 20 traps", () => {
  // `pressureSetup` proves the solver survives 120 bodies. This proves the *shipped scene*
  // does: a hand-built stress scene that quietly spawns 40 units measures nothing.
  const setup = stressMatchup(FIXED_STEP_MS);
  const units = setup.spawns.filter((s) => s.kind === "unit");
  const props = setup.spawns.filter((s) => s.kind === "prop");

  assert.equal(units.length, 100);
  assert.equal(props.length, 20);
  assert.equal(new Simulation(setup).snapshot().entities.length, 120);

  // No spawn may start outside the arena. A unit spawned inside a wall is ejected by the
  // solver on tick one, which shows up much later as "an entity escaped the bounds" and
  // points at the physics rather than at the layout that caused it.
  for (const spawn of setup.spawns) {
    const r = spawn.radius;
    assert.ok(
      spawn.x - r >= 0 && spawn.x + r <= setup.bounds.width,
      `spawn at x=${spawn.x} (r=${r}) lies outside the ${setup.bounds.width}-wide arena`
    );
    assert.ok(
      spawn.y - r >= 0 && spawn.y + r <= setup.bounds.height,
      `spawn at y=${spawn.y} (r=${r}) lies outside the ${setup.bounds.height}-tall arena`
    );
  }

  // No spawn may start on top of another, or the opening seconds measure the solver's
  // deep-penetration handling rather than the scene.
  for (let i = 0; i < setup.spawns.length; i += 1) {
    for (let j = i + 1; j < setup.spawns.length; j += 1) {
      const a = setup.spawns[i];
      const b = setup.spawns[j];
      const gap = Math.hypot(a.x - b.x, a.y - b.y);
      assert.ok(gap > 1, `spawns ${i} and ${j} start at the same point`);
    }
  }
});

test("the browser stress scene stays stable over a long run", () => {
  const sim = new Simulation(stressMatchup(FIXED_STEP_MS));
  runTicks(sim, 1800);

  assertAllFinite(sim, "stress");

  // Bounds come from the scene itself: it is built on the arena size, not the pressure one.
  const bounds = sim.snapshot().entities.length > 0 ? { width: 960, height: 600 } : null;
  assert.ok(bounds, "the scene must contain entities");
  for (const entity of sim.snapshot().entities) {
    if (entity.collider.fixed) {
      continue;
    }
    const { x, y } = entity.transform.position;
    const r = entity.collider.radius + 4;
    assert.ok(x >= -r && x <= bounds.width + r, `entity ${entity.id} escaped on x (x=${x})`);
    assert.ok(y >= -r && y <= bounds.height + r, `entity ${entity.id} escaped on y (y=${y})`);
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
