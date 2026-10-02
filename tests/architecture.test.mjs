/**
 * Architecture invariant tests.
 *
 * These do not test gameplay (there is none yet). They pin down the boundaries the
 * architecture document promises, so a later refactor cannot quietly break them:
 *
 *   1. the clock turns irregular frame deltas into fixed steps,
 *   2. catch-up is bounded instead of replaying a backlog,
 *   3. the seeded RNG is reproducible and seed-sensitive,
 *   4. the simulation core never depends on the DOM, React, PixiJS or the UI layers,
 *   5. content validation rejects dangling references,
 *   6. an identical deployment steps to identical positions regardless of frame chunking.
 *
 * Run with: npm test  (Node type stripping, no build step required)
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateContent } from "../src/content/validate.ts";
import { FixedStepClock } from "../src/simulation/clock.ts";
import { Simulation } from "../src/simulation/index.ts";
import { createRng } from "../src/simulation/rng.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

test("fixed-step clock is independent of frame chunking", () => {
  const smooth = new FixedStepClock({ fixedStepMs: 10, maxCatchUpSteps: 1000 });
  let smoothSteps = 0;
  for (let i = 0; i < 100; i += 1) {
    smoothSteps += smooth.advance(10);
  }

  const choppy = new FixedStepClock({ fixedStepMs: 10, maxCatchUpSteps: 1000 });
  let choppySteps = 0;
  for (let i = 0; i < 20; i += 1) {
    choppySteps += choppy.advance(50);
  }

  // Same 1000 ms of wall time must produce the same amount of simulated time.
  assert.equal(smoothSteps, 100);
  assert.equal(choppySteps, 100);
  assert.equal(smooth.steps, choppy.steps);
  assert.equal(smooth.droppedMsTotal, 0);
});

test("catch-up is clamped instead of replaying an unbounded backlog", () => {
  const clock = new FixedStepClock({ fixedStepMs: 10, maxCatchUpSteps: 8 });
  const steps = clock.advance(10_000);

  assert.equal(steps, 8, "a single frame may not run more than maxCatchUpSteps");
  // `advance` only reports how many steps are due; the owner commits each one as it
  // actually runs, so the counter must not move until `commitStep` is called.
  assert.equal(clock.steps, 0, "advance must not count steps it has not run");
  for (let i = 0; i < steps; i += 1) {
    clock.commitStep();
  }
  assert.equal(clock.steps, 8);
  // 1000 steps worth of time arrived, 8 ran, the remaining 992 steps were dropped.
  assert.equal(clock.droppedMsTotal, 9920);
});

test("clock rejects invalid configuration", () => {
  assert.throws(() => new FixedStepClock({ fixedStepMs: 0, maxCatchUpSteps: 4 }));
  assert.throws(() => new FixedStepClock({ fixedStepMs: 10, maxCatchUpSteps: 0 }));
});

test("seeded rng is reproducible and seed-sensitive", () => {
  const draw = (seed, count) => {
    const rng = createRng(seed);
    return Array.from({ length: count }, () => rng.next());
  };

  assert.deepEqual(draw(1234, 6), draw(1234, 6), "same seed must give the same sequence");
  assert.notDeepEqual(draw(1234, 6), draw(1235, 6), "different seeds must diverge");

  const rng = createRng(9);
  for (let i = 0; i < 200; i += 1) {
    const value = rng.next();
    assert.ok(value >= 0 && value < 1, "next() must stay in [0, 1)");
  }
});

/**
 * Strips comments before scanning for banned identifiers, so prose in a doc comment
 * (e.g. the word "window") cannot produce a false positive. The invariant is about code.
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

test("simulation core never depends on the DOM, React, PixiJS or UI layers", () => {
  const dir = join(root, "src", "simulation");
  const files = readdirSync(dir).filter((name) => name.endsWith(".ts"));
  assert.ok(files.length > 0, "expected simulation sources to exist");

  const forbidden = [
    { pattern: /from\s+["']react["']/, why: "React" },
    { pattern: /from\s+["']react-dom/, why: "React DOM" },
    { pattern: /from\s+["']pixi\.js["']/, why: "PixiJS" },
    { pattern: /from\s+["'][^"']*\/render\//, why: "the render layer" },
    { pattern: /from\s+["'][^"']*\/app\//, why: "the application shell" },
    { pattern: /from\s+["'][^"']*\/persistence\//, why: "the persistence layer" },
    { pattern: /\bdocument\b/, why: "the DOM" },
    { pattern: /\bwindow\b/, why: "the browser globals" }
  ];

  for (const file of files) {
    const code = stripComments(readFileSync(join(dir, file), "utf8"));
    for (const rule of forbidden) {
      assert.ok(!rule.pattern.test(code), `${file} must not reference ${rule.why}`);
    }
  }
});

/** A minimal well-formed library, matching the current ability schema. */
function makeAbility(id) {
  return {
    id,
    name: id,
    spec: {
      id,
      name: id,
      geometry: { kind: "line", range: 100, width: 10 },
      windupTicks: 4,
      activeTicks: 2,
      cooldownTicks: 8,
      damage: 5,
      maxTargets: 1,
      turnToTarget: 1
    }
  };
}

/** A minimal valid mechanism, so the prop branch of the validator has parameters to check. */
function makePropBehavior(overrides = {}) {
  return {
    kind: "explosive",
    radius: 20,
    damage: 10,
    intervalTicks: 0,
    cooldownTicks: 0,
    force: 100,
    reach: 80,
    chainRadius: 60,
    affects: "all",
    ...overrides
  };
}

function makeValidLibrary() {
  return {
    abilities: [makeAbility("shot")],
    characters: [
      {
        id: "ranger",
        name: "Ranger",
        abilityIds: ["shot"],
        cost: 3,
        appearance: "ranger",
        radius: 12,
        mass: 1,
        hp: 60,
        speed: 90,
        aggroRange: 400
      }
    ],
    props: [{ id: "barrel", name: "Barrel", behavior: makePropBehavior(), appearance: "barrel" }]
  };
}

test("content validation rejects dangling references and duplicate ids", () => {
  const valid = makeValidLibrary();
  assert.equal(validateContent(valid).ok, true, "a well-formed library must pass");

  const dangling = {
    ...valid,
    characters: [{ ...valid.characters[0], abilityIds: ["missing-ability"] }]
  };
  const danglingResult = validateContent(dangling);
  assert.equal(danglingResult.ok, false);
  assert.match(danglingResult.issues[0].message, /dangling/);

  const duplicate = {
    ...valid,
    abilities: [valid.abilities[0], valid.abilities[0]]
  };
  const duplicateResult = validateContent(duplicate);
  assert.equal(duplicateResult.ok, false);
  assert.match(duplicateResult.issues[0].message, /duplicate/);
});

test("content validation catches a combatant that would never attack", () => {
  // An empty rotation loads fine and then produces a unit that walks around and never
  // swings. In a battle that reads as "something is broken" with nothing to point at, so
  // the validator has to reject it up front.
  const valid = makeValidLibrary();
  const mute = {
    ...valid,
    characters: [{ ...valid.characters[0], abilityIds: [] }]
  };
  const result = validateContent(mute);
  assert.equal(result.ok, false);
  assert.match(result.issues[0].message, /at least one ability/);
});

test("content validation catches an ability whose spec id drifted from its key", () => {
  const valid = makeValidLibrary();
  const drifted = {
    ...valid,
    abilities: [{ ...valid.abilities[0], spec: { ...valid.abilities[0].spec, id: "something-else" } }]
  };
  const result = validateContent(drifted);
  assert.equal(result.ok, false);
  assert.match(result.issues[0].message, /does not match library id/);
});

test("content validation catches a cone with no angle", () => {
  const valid = makeValidLibrary();
  const brokenCone = {
    ...valid,
    abilities: [
      {
        ...valid.abilities[0],
        spec: { ...valid.abilities[0].spec, geometry: { kind: "cone", range: 80 } }
      }
    ]
  };
  const result = validateContent(brokenCone);
  assert.equal(result.ok, false);
  assert.match(result.issues[0].message, /positive halfAngle/);
});

/**
 * Velocities are world units per SECOND. The red unit travels 200 units in the one
 * simulated second, which is far enough to reach the neutral prop at x = 400 — so this
 * case exercises a real contact against a static body, not just free motion.
 */
const deterministicSetup = {
  seed: 7,
  fixedStepMs: 10,
  bounds: { width: 800, height: 600 },
  // No abilities and no characters: this fixture exists to pin the physics seam, so every
  // spawn is a plain body. Silence here is intentional, not an oversight.
  abilities: [],
  spawns: [
    { kind: "unit", faction: "red", x: 200, y: 300, radius: 12, mass: 1, hp: 10, vx: 200 },
    { kind: "unit", faction: "blue", x: 600, y: 300, radius: 12, mass: 1, hp: 10, vx: -200 },
    { kind: "prop", faction: "neutral", x: 400, y: 300, radius: 20, mass: 5, hp: 0 }
  ]
};

test("world is built from the deployment with stable ids and fixed props", () => {
  const simulation = new Simulation(deterministicSetup, { maxCatchUpSteps: 1000 });
  const entities = simulation.snapshot().entities;

  assert.equal(entities.length, 3);
  assert.deepEqual(
    entities.map((entity) => entity.id),
    [1, 2, 3]
  );
  assert.equal(entities[2].collider.fixed, true, "props must be static bodies");
  assert.equal(entities[0].collider.fixed, false, "units must be dynamic bodies");
});

test("identical deployments step identically regardless of frame chunking", () => {
  const smooth = new Simulation(deterministicSetup, { maxCatchUpSteps: 1000 });
  for (let i = 0; i < 100; i += 1) {
    smooth.advance(10);
  }

  const choppy = new Simulation(deterministicSetup, { maxCatchUpSteps: 1000 });
  for (let i = 0; i < 20; i += 1) {
    choppy.advance(50);
  }

  assert.equal(smooth.tick, 100);
  assert.equal(choppy.tick, 100);

  const a = smooth.snapshot().entities;
  const b = choppy.snapshot().entities;
  assert.equal(a.length, b.length);

  for (let i = 0; i < a.length; i += 1) {
    assert.equal(a[i].id, b[i].id, `entity id mismatch at index ${i}`);
    assert.ok(
      Math.abs(a[i].transform.position.x - b[i].transform.position.x) < 1e-9,
      `x mismatch for entity ${a[i].id}`
    );
    assert.ok(
      Math.abs(a[i].transform.position.y - b[i].transform.position.y) < 1e-9,
      `y mismatch for entity ${a[i].id}`
    );
  }

  // Guard against a vacuous pass: the units must actually have travelled and hit the
  // static prop. A sign flip in velocity is the strongest available evidence of a real
  // contact, and it is exactly the path that produced NaN before the adapter was fixed.
  assert.ok(Math.abs(a[0].transform.position.x - 200) > 1, "the unit should have moved");
  assert.ok(a[0].motion.velocity.x < 0, "the red unit should have bounced off the prop");
  assert.ok(a[1].motion.velocity.x > 0, "the blue unit should have bounced off the prop");
  assert.ok(a[2].transform.position.x === 400, "the prop must stay put");

  for (const entity of a) {
    assert.ok(Number.isFinite(entity.transform.position.x), `entity ${entity.id} x must be finite`);
    assert.ok(Number.isFinite(entity.transform.position.y), `entity ${entity.id} y must be finite`);
    assert.ok(Number.isFinite(entity.motion.velocity.x), `entity ${entity.id} vx must be finite`);
  }
});
