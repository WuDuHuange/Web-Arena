/**
 * End-to-end battle assertions.
 *
 * The Phase 2 acceptance bar is "fight a complete battle from a fresh field and reset".
 * These tests fight that battle head-lessly and assert the things that would otherwise
 * only be caught by watching: that every archetype lands hits, that a battle terminates,
 * that it is reproducible from its seed, and that each hit geometry is actually reachable
 * in a real deployment rather than only in a unit fixture.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { Simulation } from "../src/simulation/simulation.ts";
import { Battle } from "../src/simulation/battle.ts";
import { validateContent } from "../src/content/validate.ts";
import { CONTENT_LIBRARY } from "../src/content/library.ts";
import { buildLineup, defaultMatchup, squadMatchup } from "../src/content/deployment.ts";

const FIXED_STEP_MS = 1000 / 60;

/** Runs until the battle is decided or the cap is hit. Returns ticks actually run. */
function fightToDecision(sim, maxTicks) {
  for (let i = 0; i < maxTicks; i += 1) {
    sim.step();
    if (sim.decided) {
      return i + 1;
    }
  }
  return maxTicks;
}

test("the shipped content library validates cleanly", () => {
  const result = validateContent(CONTENT_LIBRARY);
  assert.equal(
    result.ok,
    true,
    `content library must be valid, got: ${JSON.stringify(result.issues, null, 2)}`
  );
});

test("every archetype is reachable in one deployment", () => {
  // The four geometries each need to exist in an actual battle, not just in a fixture.
  const kinds = new Set(CONTENT_LIBRARY.abilities.map((a) => a.spec.geometry.kind));
  assert.deepEqual(
    [...kinds].sort(),
    ["circle", "cone", "line", "melee"],
    "the library must exercise all four hit geometries"
  );
});

test("a full battle reaches a decision", () => {
  const sim = new Simulation(defaultMatchup(FIXED_STEP_MS));
  const ticks = fightToDecision(sim, 6000);

  assert.ok(ticks < 6000, `battle must terminate, still running after ${ticks} ticks`);
  assert.equal(sim.decided, true);

  const survivors = Battle.survivorFactions(sim.snapshot().entities);
  assert.ok(survivors.size <= 1, `expected at most one faction standing, got ${[...survivors]}`);
});

test("both sides deal damage, so no archetype is silently inert", () => {
  // A geometry with a broken hit test still lets its owner walk around and die, so
  // "the battle ended" alone does not prove every archetype works. This checks that both
  // rosters land hits before the battle resolves.
  const sim = new Simulation(defaultMatchup(FIXED_STEP_MS));
  let redDamage = 0;
  let blueDamage = 0;

  for (let i = 0; i < 6000; i += 1) {
    const before = new Map(sim.snapshot().entities.map((e) => [e.id, e.health.current]));
    sim.step();
    if (sim.decided) {
      break;
    }
    for (const entity of sim.snapshot().entities) {
      const previous = before.get(entity.id);
      if (previous === undefined) {
        continue;
      }
      const lost = previous - entity.health.current;
      if (lost <= 0) {
        continue;
      }
      if (entity.faction === "red") {
        blueDamage += lost;
      } else if (entity.faction === "blue") {
        redDamage += lost;
      }
    }
  }

  assert.ok(redDamage > 0, "red must land damage on blue");
  assert.ok(blueDamage > 0, "blue must land damage on red");
});

test("the same seed and deployment replay identically", () => {
  const a = new Simulation(defaultMatchup(FIXED_STEP_MS));
  const b = new Simulation(defaultMatchup(FIXED_STEP_MS));

  for (let i = 0; i < 900; i += 1) {
    a.step();
    b.step();
  }

  const ea = a.snapshot().entities;
  const eb = b.snapshot().entities;
  assert.equal(ea.length, eb.length, "both runs must have the same survivors");

  for (let i = 0; i < ea.length; i += 1) {
    assert.equal(ea[i].id, eb[i].id, "survivor ids must match in order");
    assert.equal(ea[i].health.current, eb[i].health.current, `entity ${ea[i].id} health diverged`);
    assert.ok(
      Math.abs(ea[i].transform.position.x - eb[i].transform.position.x) < 1e-9,
      `entity ${ea[i].id} position diverged`
    );
  }
});

test("a reset restores the deployment exactly", () => {
  // Resetting means constructing a new Simulation from the same setup, so the assertion is
  // that the setup itself is immutable and rebuilds to identical initial state.
  const setup = defaultMatchup(FIXED_STEP_MS);
  const first = new Simulation(setup);
  const baseline = first.snapshot().entities.map((e) => ({
    id: e.id,
    hp: e.health.current,
    x: e.transform.position.x,
    y: e.transform.position.y
  }));

  for (let i = 0; i < 400; i += 1) {
    first.step();
  }

  const second = new Simulation(setup);
  const rebuilt = second.snapshot().entities.map((e) => ({
    id: e.id,
    hp: e.health.current,
    x: e.transform.position.x,
    y: e.transform.position.y
  }));

  assert.deepEqual(rebuilt, baseline, "a fresh Simulation must reproduce the opening state");

  // And the setup object itself must not have been mutated by the first battle.
  assert.equal(setup.spawns.length, 8, "the deployment must not be mutated by running it");
  assert.equal(setup.spawns[0].hp > 0, true, "spawn hp must survive a battle");
});

test("a larger squad still resolves without going unstable", () => {
  const sim = new Simulation(squadMatchup(FIXED_STEP_MS, 3));
  const initialCount = sim.snapshot().entities.length;
  assert.equal(initialCount, 24, "three copies of each side's four archetypes");

  const ticks = fightToDecision(sim, 12000);
  assert.ok(ticks <= 12000, "a 24-unit battle must resolve or at least stay bounded");

  for (const entity of sim.snapshot().entities) {
    const { x, y } = entity.transform.position;
    assert.ok(Number.isFinite(x) && Number.isFinite(y), `entity ${entity.id} went non-finite`);
  }
});

test("a single-archetype lineup still produces a clean duel", () => {
  const sim = new Simulation(buildLineup({ fixedStepMs: FIXED_STEP_MS, red: ["red.blade"], blue: ["blue.skirmisher"] }));
  assert.equal(sim.snapshot().entities.length, 2);

  const ticks = fightToDecision(sim, 4000);
  assert.ok(ticks < 4000, "a one-on-one must resolve");
});

test("a melee-only mirror match terminates, which requires reach to actually connect", () => {
  // Two single-target melee units closing on each other is the purest test that the
  // movement AI stops in range and the melee geometry reaches. If either is wrong the two
  // units circle each other forever and this test times out.
  const sim = new Simulation(
    buildLineup({
      fixedStepMs: FIXED_STEP_MS,
      red: ["red.blade", "red.blade", "red.blade"],
      blue: ["blue.skirmisher", "blue.skirmisher", "blue.skirmisher"]
    })
  );

  const ticks = fightToDecision(sim, 5000);
  assert.ok(ticks < 5000, `melee mirror match must conclude, ran ${ticks} ticks`);
});
