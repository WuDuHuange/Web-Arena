/**
 * Combat and AI assertions.
 *
 * These pin the parts that are easy to get subtly wrong and impossible to eyeball:
 * targeting determinism, the phase machine's tick accounting, the single-application
 * guard on a multi-tick active frame, and whether death actually removes a body.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { Simulation } from "../src/simulation/simulation.ts";
import { findNearestTarget, isHostile } from "../src/simulation/ai.ts";
import { cadenceTicks, stopDistanceFor } from "../src/simulation/combat.ts";

const FIXED_STEP_MS = 1000 / 60;

/** A one-ability, two-unit fixture with no physics interference. */
function duelSetup(overrides = {}, hp = 100) {
  const ability = {
    id: "test.strike",
    name: "test",
    geometry: { kind: "melee", range: 20 },
    windupTicks: 2,
    activeTicks: 1,
    cooldownTicks: 2,
    damage: 10,
    maxTargets: 1,
    turnToTarget: 1,
    ...overrides
  };

  return {
    seed: 99,
    fixedStepMs: FIXED_STEP_MS,
    bounds: { width: 800, height: 600 },
    abilities: [ability],
    characters: [{ id: "test.fighter", abilityIds: [ability.id], speed: 0, aggroRange: 500 }],
    spawns: [
      { kind: "unit", faction: "red", x: 100, y: 300, radius: 10, mass: 1, hp, facing: 0, characterId: "test.fighter" },
      { kind: "unit", faction: "blue", x: 130, y: 300, radius: 10, mass: 1, hp, facing: Math.PI, characterId: "test.fighter" }
    ]
  };
}

function runTicks(sim, ticks) {
  for (let i = 0; i < ticks; i += 1) {
    sim.step();
  }
}

test("hostility is symmetric and excludes allies", () => {
  assert.equal(isHostile("red", "blue"), true);
  assert.equal(isHostile("blue", "red"), true);
  assert.equal(isHostile("red", "red"), false);
});

test("cadence is the sum of all three phases", () => {
  const ability = {
    id: "a",
    name: "a",
    geometry: { kind: "melee", range: 10 },
    windupTicks: 5,
    activeTicks: 2,
    cooldownTicks: 7,
    damage: 1,
    maxTargets: 1,
    turnToTarget: 1
  };
  assert.equal(cadenceTicks(ability), 14);
});

test("stop distance scales with geometry kind and never exceeds reach", () => {
  const melee = {
    id: "m", name: "m", geometry: { kind: "melee", range: 30 },
    windupTicks: 1, activeTicks: 1, cooldownTicks: 1, damage: 1, maxTargets: 1, turnToTarget: 1
  };
  const line = {
    id: "l", name: "l", geometry: { kind: "line", range: 200, width: 10 },
    windupTicks: 1, activeTicks: 1, cooldownTicks: 1, damage: 1, maxTargets: 1, turnToTarget: 1
  };
  const cone = {
    id: "c", name: "c", geometry: { kind: "cone", range: 100, halfAngle: 1 },
    windupTicks: 1, activeTicks: 1, cooldownTicks: 1, damage: 1, maxTargets: 1, turnToTarget: 1
  };
  const area = {
    id: "a", name: "a", geometry: { kind: "circle", range: 80, centredOnCaster: true },
    windupTicks: 1, activeTicks: 1, cooldownTicks: 1, damage: 1, maxTargets: 1, turnToTarget: 1
  };

  // A melee unit walks all the way in; anything with reach stops short of its own maximum.
  assert.equal(stopDistanceFor(melee), 30);
  assert.ok(stopDistanceFor(line) < line.geometry.range);
  assert.ok(stopDistanceFor(cone) < cone.geometry.range);
  assert.ok(stopDistanceFor(area) < area.geometry.range);
});

test("targeting picks the nearest hostile and breaks ties by lowest id", () => {
  const make = (id, faction, x) => ({
    id,
    kind: "unit",
    faction,
    tags: [],
    transform: { position: { x, y: 0 }, facing: 0 },
    motion: { velocity: { x: 0, y: 0 } },
    collider: { radius: 5, mass: 1, fixed: false },
    health: { current: 10, max: 10 },
    render: { appearance: "x" }
  });

  const self = make(1, "red", 0);
  const far = make(2, "blue", 100);
  const near = make(3, "blue", 20);
  const ally = make(4, "red", 5);

  assert.equal(findNearestTarget(self, [self, far, near, ally]).id, 3);

  // Two equidistant hostiles: the lower id must win, every time. Without this the battle
  // can diverge from the same seed purely from iteration order.
  const twinA = make(5, "blue", 30);
  const twinB = make(6, "blue", -30);
  const champion = findNearestTarget(self, [self, twinA, twinB]);
  assert.equal(champion.id, 5);
});

test("a dead entity is never targeted again", () => {
  const self = {
    id: 1, kind: "unit", faction: "red", tags: [],
    transform: { position: { x: 0, y: 0 }, facing: 0 },
    motion: { velocity: { x: 0, y: 0 } },
    collider: { radius: 5, mass: 1, fixed: false },
    health: { current: 10, max: 10 },
    render: { appearance: "x" }
  };
  const corpse = {
    id: 2, kind: "unit", faction: "blue", tags: [],
    transform: { position: { x: 10, y: 0 }, facing: 0 },
    motion: { velocity: { x: 0, y: 0 } },
    collider: { radius: 5, mass: 1, fixed: false },
    health: { current: 0, max: 10, dead: true },
    render: { appearance: "x" }
  };

  assert.equal(findNearestTarget(self, [self, corpse]), undefined);
});

test("damage lands once per active frame, not once per active tick", () => {
  // 3-tick active window, 10 damage, 100 hp. If the guard is missing the target takes 30
  // on the first cycle and every balance number becomes a lie.
  const sim = new Simulation(duelSetup({ activeTicks: 3, damage: 10 }));
  const initial = sim.snapshot().entities[1].health.current;

  runTicks(sim, 40);
  const after = sim.snapshot().entities.find((e) => e.id === 2)?.health.current ?? 0;

  // Over 40 ticks with cadence 2+3+2=7, roughly 5 cycles land. The exact count is not the
  // point; the point is that it is nowhere near 3x that from per-tick application.
  assert.ok(after < initial, "the target must have taken damage at all");
  assert.ok(
    initial - after <= 60,
    `damage must be one application per cycle, took ${initial - after} over 40 ticks`
  );
});

test("a lethal hit marks the target dead and the body leaves the world", () => {
  const sim = new Simulation(duelSetup({ damage: 100 }, 60));
  runTicks(sim, 60);

  const remaining = sim.snapshot().entities.filter((e) => e.faction === "blue");
  assert.equal(remaining.length, 0, "the defeated unit must be removed from the world");
  assert.equal(sim.decided, true, "with one side wiped out the battle is decided");
});

test("an ability with no reach deals nothing", () => {
  // Range 1 with the units 30 apart and 10 radius each: nothing is ever in range.
  const sim = new Simulation(duelSetup({ geometry: { kind: "melee", range: 1 }, damage: 50 }, 100));
  const before = sim.snapshot().entities.length;

  runTicks(sim, 200);

  assert.equal(sim.snapshot().entities.length, before, "no unit should have died");
  for (const entity of sim.snapshot().entities) {
    assert.equal(entity.health.current, 100, "health must be untouched when nothing is in reach");
  }
});

test("combat timing is tick-based, so frame chunking cannot change the outcome", () => {
  const smooth = new Simulation(duelSetup());
  for (let i = 0; i < 200; i += 1) {
    smooth.advance(FIXED_STEP_MS);
  }

  const chunky = new Simulation(duelSetup());
  for (let i = 0; i < 50; i += 1) {
    chunky.advance(FIXED_STEP_MS * 4);
  }

  assert.equal(smooth.tick, 200);
  assert.equal(chunky.tick, 200);

  const a = smooth.snapshot().entities;
  const b = chunky.snapshot().entities;
  assert.equal(a.length, b.length, "both runs must have the same survivors");
  for (let i = 0; i < a.length; i += 1) {
    assert.equal(a[i].health.current, b[i].health.current, `entity ${a[i].id} health diverged`);
  }
});
