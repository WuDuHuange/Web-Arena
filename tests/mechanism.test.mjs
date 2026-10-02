/**
 * Phase 3 mechanism assertions.
 *
 * The acceptance bar is three things that are only visible over time or over a hostile
 * layout, so none of them can be checked by reading the code:
 *
 *   1. Group knockback and trap chains never run away. A ring of barrels is legal, and a
 *      naive chain walks it forever.
 *   2. A missing resource degrades visibly rather than silently. Nothing may throw when an
 *      appearance key resolves to nothing.
 *   3. Swapping art must not change collision or damage. This is asserted by running the
 *      same mechanism twice with two different appearance strings and requiring the two
 *      runs to be identical.
 *
 * Run with: npm run test:mechanism
 */
import assert from "node:assert/strict";
import test from "node:test";

import { Simulation } from "../src/simulation/simulation.ts";
import { chainTargets, mechanismAffects, segmentHitsCircle } from "../src/simulation/mechanisms.ts";
import { createWorldFromSetup } from "../src/simulation/spawn.ts";
import { validateContent } from "../src/content/validate.ts";
import { CONTENT_LIBRARY, PROP_LIBRARY, findProp } from "../src/content/library.ts";
import { mechanismMatchup } from "../src/content/deployment.ts";

const FIXED_STEP_MS = 1000 / 60;

/** Minimal bounds for a mechanism fixture: big enough that nothing touches a wall early. */
const BOUNDS = { width: 900, height: 600 };

function runTicks(sim, ticks) {
  for (let i = 0; i < ticks; i += 1) {
    sim.step();
  }
}

/**
 * A one-unit fixture standing on a single mechanism, so only that mechanism is in play.
 *
 * The prop's *collider* is deliberately tiny while its behaviour radius is full size. A
 * floor plate is not a wall: if the prop were a solid body of its own radius, the solver
 * would eject the unit standing on it before the mechanism ever got to react, and every
 * assertion would be measuring separation instead of the mechanism. `radius` in the
 * behaviour is the effect radius; the collider here is a marker.
 */
function mechanismSetup(behavior, options = {}) {
  const {
    propX = 400,
    propY = 300,
    unitX = 400,
    unitY = 300,
    unitHp = 200,
    facing = 0,
    propColliderRadius = 1,
    extraSpawns = []
  } = options;

  return {
    seed: 4242,
    fixedStepMs: FIXED_STEP_MS,
    bounds: BOUNDS,
    abilities: [],
    spawns: [
      {
        kind: "unit",
        faction: "red",
        x: unitX,
        y: unitY,
        radius: 12,
        mass: 1,
        hp: unitHp,
        facing
      },
      {
        kind: "prop",
        faction: "neutral",
        x: propX,
        y: propY,
        radius: propColliderRadius,
        mass: 3,
        hp: 1,
        facing,
        behavior
      },
      ...extraSpawns
    ]
  };
}

/** A mechanism prop that does not block: used when a unit has to stand on the tile. */
function flatProp(behavior, x, y, facing = 0) {
  return { kind: "prop", faction: "neutral", x, y, radius: 1, mass: 3, hp: 1, facing, behavior };
}

test("every shipped mechanism declares the parameters its family needs", () => {
  const result = validateContent(CONTENT_LIBRARY);
  assert.equal(
    result.ok,
    true,
    `content library must be valid, got: ${JSON.stringify(result.issues, null, 2)}`
  );

  // All seven families are present, so a scene can exercise each one.
  const kinds = new Set(PROP_LIBRARY.map((p) => p.behavior.kind));
  assert.deepEqual(
    [...kinds].sort(),
    ["aura", "conveyor", "explosive", "shrine", "spike", "spring", "turret"],
    "all seven mechanism families must be authored"
  );
});

test("a damaging aura applies on its interval, not on every tick", () => {
  // 6 damage every 30 ticks. Over 300 ticks that is 10 applications = 60 damage. Without
  // the interval guard it would be 300 applications, which is the whole reason the guard
  // exists.
  const lava = findProp("prop.lava");
  assert.ok(lava, "the library must contain lava");
  const sim = new Simulation(mechanismSetup(lava.behavior));
  const start = sim.snapshot().entities.find((e) => e.faction === "red").health.current;

  runTicks(sim, 300);

  const after = sim.snapshot().entities.find((e) => e.faction === "red")?.health.current ?? 0;
  const dealt = start - after;

  // The first application lands at the end of the first interval, so 300 ticks yields
  // either 10 or 11 hits depending on the phase offset the spawn position produced.
  assert.ok(dealt >= 60, `lava must deal at least 10 applications over 300 ticks, dealt ${dealt}`);
  assert.ok(dealt <= 66, `lava must not deal more than 11 applications over 300 ticks, dealt ${dealt}`);
});

test("an aura still pulses while nothing is standing in it", () => {
  // The interval advances unconditionally, so a unit walking in late does not get hit
  // instantly. This is the difference between a hazard and a landmine.
  const lava = findProp("prop.lava");
  const sim = new Simulation(
    mechanismSetup(lava.behavior, { unitX: 100, unitY: 100, propX: 700, propY: 500 })
  );

  runTicks(sim, 300);
  const untouched = sim.snapshot().entities.find((e) => e.faction === "red").health.current;
  assert.equal(untouched, 200, "a unit outside the aura must be unharmed");
});

test("a conveyor pushes a unit against its own intent", () => {
  const belt = findProp("prop.conveyor");
  assert.ok(belt, "the library must contain a conveyor");
  // Unit starts on the belt, trying to hold position (no combat component, no AI).
  const sim = new Simulation(mechanismSetup(belt.behavior));

  const before = sim.snapshot().entities.find((e) => e.faction === "red").transform.position.x;
  runTicks(sim, 60);
  const after = sim.snapshot().entities.find((e) => e.faction === "red").transform.position.x;

  // The belt's facing is 0, so the drift is along +x.
  assert.ok(after > before + 20, `a conveyor must carry a unit along its facing, moved ${after - before}`);
});

test("a conveyor overlay adds to intent rather than replacing it", () => {
  // The lateral axis must be untouched: an overlay that overwrote the velocity vector
  // instead of adding to it would clamp y to zero regardless of where the unit was going.
  const belt = findProp("prop.conveyor");
  // Belt pushes along +x; the unit is given its own +y drift and must keep both.
  const setup = mechanismSetup(belt.behavior, { unitY: 280 });
  setup.spawns[0].vy = 120;

  const sim = new Simulation(setup);
  const before = sim.snapshot().entities.find((e) => e.faction === "red").transform.position.y;
  runTicks(sim, 30);
  const after = sim.snapshot().entities.find((e) => e.faction === "red").transform.position.y;

  assert.ok(after > before, "the unit's own lateral motion must survive the overlay");
});

test("a spike fires once on entry and then goes quiet for its cooldown", () => {
  const spike = findProp("prop.spike");
  const sim = new Simulation(mechanismSetup(spike.behavior));

  const start = sim.snapshot().entities.find((e) => e.faction === "red").health.current;

  // 90-tick cooldown over 300 ticks: at most 4 firings, and the first lands immediately.
  runTicks(sim, 300);
  const after = sim.snapshot().entities.find((e) => e.faction === "red")?.health.current ?? 0;
  const hits = (start - after) / spike.behavior.damage;

  assert.ok(hits >= 3, `a spike must fire repeatedly over time, fired ${hits} times`);
  assert.ok(hits <= 4, `a spike must respect its cooldown, fired ${hits} times in 300 ticks`);
});

test("a spike damages only one overlapping unit, chosen by lowest id", () => {
  const spike = findProp("prop.spike");
  // Two units on the same tile. Both are legitimate targets, so a deterministic pick is
  // needed or the same seed replays differently.
  const setup = {
    seed: 4242,
    fixedStepMs: FIXED_STEP_MS,
    bounds: BOUNDS,
    abilities: [],
    spawns: [
      { kind: "unit", faction: "red", x: 400, y: 300, radius: 12, mass: 1, hp: 200, facing: 0 },
      { kind: "unit", faction: "blue", x: 400, y: 300, radius: 12, mass: 1, hp: 200, facing: Math.PI },
      flatProp(spike.behavior, 400, 300)
    ]
  };
  const sim = new Simulation(setup);

  sim.step();
  const entities = sim.snapshot().entities;
  const red = entities.find((e) => e.faction === "red");
  const blue = entities.find((e) => e.faction === "blue");

  const damaged = [red, blue].filter((e) => e.health.current < 200);
  assert.equal(damaged.length, 1, "a spike hits one target, not everything on the tile");
  // World assigns ids in insertion order, so red is id 1 and blue is id 2.
  assert.equal(red.health.current, 200 - spike.behavior.damage, "the lowest-id unit must be the one hit");
  assert.equal(blue.health.current, 200, "the higher-id unit must be spared");
});

test("a spring launches a unit along its facing", () => {
  const spring = findProp("prop.spring");
  const sim = new Simulation(mechanismSetup(spring.behavior, { unitX: 400, unitY: 300, facing: 0 }));

  const before = sim.snapshot().entities.find((e) => e.faction === "red").transform.position.x;
  // The spring's own cooldown is 45 ticks, so 40 is inside one launch. The assertion is
  // that the launch is substantial, not that it matches a hand-computed integral.
  runTicks(sim, 40);
  const after = sim.snapshot().entities.find((e) => e.faction === "red").transform.position.x;

  assert.ok(after > before + 25, `a spring must throw a unit along its facing, moved ${after - before}`);
});

test("a spring latches so a unit resting on it is not relaunched every tick", () => {
  const spring = findProp("prop.spring");
  const sim = new Simulation(mechanismSetup(spring.behavior));

  // After the launch the unit is thrown clear; the point of the assertion is that the pad
  // did not apply 320 u/s every single tick, which would be a velocity of 19200 after a
  // second.
  runTicks(sim, 60);
  const speed = Math.hypot(
    sim.snapshot().entities.find((e) => e.faction === "red").motion.velocity.x,
    sim.snapshot().entities.find((e) => e.faction === "red").motion.velocity.y
  );
  assert.ok(speed < 1000, `a latched spring must not stack velocity every tick, got ${speed}`);
});

test("a barrel blast damages and shoves everything in range", () => {
  const barrel = findProp("prop.barrel");
  const setup = mechanismSetup(barrel.behavior, { unitX: 400, unitY: 300 });
  // Two extra units at different distances from the barrel, both inside the blast.
  setup.spawns.push(
    { kind: "unit", faction: "blue", x: 460, y: 300, radius: 12, mass: 1, hp: 200, facing: Math.PI },
    { kind: "unit", faction: "blue", x: 400, y: 360, radius: 12, mass: 1, hp: 200, facing: Math.PI }
  );

  const sim = new Simulation(setup);
  const before = new Map(sim.snapshot().entities.map((e) => [e.id, e.transform.position.x]));
  sim.step();

  for (const entity of sim.snapshot().entities) {
    if (entity.kind !== "unit") {
      continue;
    }
    assert.equal(entity.health.current, 200 - barrel.behavior.damage, `unit ${entity.id} must take blast damage`);
  }

  // The barrel itself is consumed, so it leaves the field.
  const barrels = sim.snapshot().entities.filter((e) => e.behavior?.kind === "explosive");
  assert.equal(barrels.length, 0, "a detonated barrel must be removed from the world");

  // Everything was shoved away from the blast centre. The unit sitting exactly on the
  // centre has an undefined away-vector, which is why the fallback matters.
  const moved = sim.snapshot().entities.filter((e) => e.kind === "unit");
  assert.ok(
    moved.some((e) => Math.abs(e.transform.position.x - (before.get(e.id) ?? 0)) > 0.1),
    "the blast must actually move something"
  );
});

test("a ring of barrels terminates instead of chaining forever", () => {
  // Eight barrels on a circle, each within chain radius of its neighbours. This is a cycle,
  // not a tree, so a chain walk that only guards on "already spent" is not enough on its
  // own — the depth cap is what has to catch this.
  const barrel = findProp("prop.barrel");
  const spawns = [];
  const count = 8;
  const radius = 60;
  for (let i = 0; i < count; i += 1) {
    const angle = (i / count) * Math.PI * 2;
    spawns.push({
      kind: "prop",
      faction: "neutral",
      x: 450 + Math.cos(angle) * radius,
      y: 300 + Math.sin(angle) * radius,
      radius: barrel.behavior.radius,
      mass: 3,
      hp: 1,
      behavior: barrel.behavior
    });
  }
  // One unit inside the ring to trigger the whole thing.
  spawns.push({ kind: "unit", faction: "red", x: 450, y: 300, radius: 12, mass: 1, hp: 999, facing: 0 });

  const sim = new Simulation({
    seed: 7,
    fixedStepMs: FIXED_STEP_MS,
    bounds: BOUNDS,
    abilities: [],
    spawns
  });

  // The assertion is simply that this returns. A chain that loops forever hangs the runner.
  runTicks(sim, 120);

  const remaining = sim.snapshot().entities.filter((e) => e.behavior?.kind === "explosive");
  assert.equal(remaining.length, 0, "the whole ring must have gone off and been consumed");
  assert.ok(sim.chainLinks <= 32, `chain links must stay within the cap, used ${sim.chainLinks}`);
});

test("chain membership is decided by distance and spent state only", () => {
  const barrel = findProp("prop.barrel");
  const world = createWorldFromSetup({
    seed: 1,
    fixedStepMs: FIXED_STEP_MS,
    bounds: BOUNDS,
    abilities: [],
    spawns: [
      { kind: "prop", faction: "neutral", x: 100, y: 100, radius: 20, mass: 1, hp: 1, behavior: barrel.behavior },
      { kind: "prop", faction: "neutral", x: 160, y: 100, radius: 20, mass: 1, hp: 1, behavior: barrel.behavior },
      { kind: "prop", faction: "neutral", x: 500, y: 500, radius: 20, mass: 1, hp: 1, behavior: barrel.behavior },
      { kind: "prop", faction: "neutral", x: 100, y: 400, radius: 20, mass: 1, hp: 1, behavior: findProp("prop.lava").behavior }
    ]
  });

  const entities = world.all();
  const root = entities[0];
  const candidates = chainTargets(root, barrel.behavior, entities);
  const ids = candidates.map((e) => e.id);

  assert.ok(ids.includes(2), "a barrel within chain radius must be a candidate");
  assert.ok(!ids.includes(3), "a barrel far away must not be a candidate");
  assert.ok(!ids.includes(4), "a non-explosive mechanism must never chain");
});

test("mechanism allegiance is a pure predicate", () => {
  const aura = findProp("prop.lava").behavior;
  // `tags` is not decoration on this stub. A mechanism now also asks whether its target
  // passes over the floor, so a candidate without a tag list would fail on the read rather
  // than on the answer. An entity always has one; see `createWorldFromSetup`.
  const red = { faction: "red", tags: [] };
  const blue = { faction: "blue", tags: [] };

  assert.equal(mechanismAffects(aura, "neutral", red), true, "a neutral hazard hurts everyone");
  assert.equal(mechanismAffects(aura, "neutral", blue), true);

  const turret = findProp("prop.turret").behavior;
  assert.equal(mechanismAffects(turret, "red", red), false, "a red turret does not shoot red");
  assert.equal(mechanismAffects(turret, "red", blue), true, "a red turret shoots blue");
});

test("a turret fires projectiles at hostiles and they expire", () => {
  const turret = findProp("prop.turret");
  const sim = new Simulation(
    mechanismSetup(turret.behavior, {
      propX: 200,
      propY: 300,
      unitX: 400,
      unitY: 300,
      unitHp: 500
    })
  );

  // The turret is neutral, so the red unit is a valid target. Over 300 ticks at a 70-tick
  // cadence it should fire several times.
  runTicks(sim, 300);
  const after = sim.snapshot().entities.find((e) => e.faction === "red")?.health.current ?? 0;
  assert.ok(after < 500, "a turret must land shots on a unit in its reach");
});

test("projectiles do not accumulate without bound", () => {
  // A shot that never expires is a leak. Over a long run the live count must stay near the
  // number actually in flight, not grow with the number ever fired.
  const turret = findProp("prop.turret");
  const sim = new Simulation(
    mechanismSetup(turret.behavior, {
      propX: 150,
      propY: 300,
      // Unit far outside the turret's reach, so nothing is ever hit and every shot has to
      // expire on its own.
      unitX: 880,
      unitY: 40,
      unitHp: 500
    })
  );

  runTicks(sim, 600);
  assert.ok(
    sim.projectileCount <= 4,
    `expired shots must be removed, ${sim.projectileCount} still in flight`
  );
});

test("a swept projectile test catches what a point test would miss", () => {
  // A shot moving 5 units per tick past a 6-unit target: a discrete check at the end of the
  // step can straddle it. The segment test cannot.
  const from = { x: 0, y: 0 };
  const to = { x: 20, y: 0 };
  assert.equal(segmentHitsCircle(from, to, { x: 10, y: 0 }, 3), true, "a target on the path must be hit");
  assert.equal(segmentHitsCircle(from, to, { x: 10, y: 8 }, 3), false, "a target off the path must be missed");
  assert.equal(segmentHitsCircle(from, to, { x: -10, y: 0 }, 3), false, "a target behind the start must be missed");
  assert.equal(segmentHitsCircle(from, to, { x: 30, y: 0 }, 3), false, "a target past the end must be missed");
  assert.equal(segmentHitsCircle(from, from, { x: 0, y: 2 }, 3), true, "a zero-length step degenerates to a point test");
});

test("swapping appearance changes nothing about collision or damage", () => {
  // The acceptance criterion, asserted rather than assumed: the same behaviour with two
  // different appearance strings must produce bit-identical simulation.
  const base = findProp("prop.spike").behavior;

  const build = (appearance) => {
    const setup = mechanismSetup(base, {
      extraSpawns: [
        { kind: "unit", faction: "blue", x: 440, y: 300, radius: 12, mass: 1, hp: 300, facing: Math.PI }
      ]
    });
    setup.spawns[0].appearance = appearance;
    setup.spawns[1].appearance = appearance;
    setup.spawns[2].appearance = appearance;
    return new Simulation(setup);
  };

  const plain = build("prop-spike");
  const fancy = build("some-future-sprite-sheet");

  runTicks(plain, 400);
  runTicks(fancy, 400);

  const a = plain.snapshot().entities;
  const b = fancy.snapshot().entities;

  assert.equal(a.length, b.length, "the same behaviour must keep the same bodies alive");
  for (let i = 0; i < a.length; i += 1) {
    assert.equal(a[i].health.current, b[i].health.current, `entity ${a[i].id} health differed by appearance`);
    assert.ok(
      Math.abs(a[i].transform.position.x - b[i].transform.position.x) < 1e-9,
      `entity ${a[i].id} position differed by appearance`
    );
    assert.ok(
      Math.abs(a[i].transform.position.y - b[i].transform.position.y) < 1e-9,
      `entity ${a[i].id} position differed by appearance`
    );
  }
});

test("a scene with every mechanism is reproducible from its seed", () => {
  const build = () => {
    const spawns = [];
    let x = 120;
    for (const prop of PROP_LIBRARY) {
      spawns.push({
        kind: "prop",
        faction: prop.behavior.affects === "hostile" ? "red" : "neutral",
        x,
        y: 300,
        radius: prop.behavior.radius,
        mass: 3,
        hp: 1,
        facing: 0,
        behavior: prop.behavior,
        appearance: prop.appearance
      });
      x += 110;
    }
    spawns.push({ kind: "unit", faction: "red", x: 60, y: 200, radius: 12, mass: 1, hp: 400, vx: 90 });
    spawns.push({ kind: "unit", faction: "blue", x: 840, y: 400, radius: 12, mass: 1, hp: 400, vx: -90 });
    return { seed: 20261003, fixedStepMs: FIXED_STEP_MS, bounds: BOUNDS, abilities: [], spawns };
  };

  const a = new Simulation(build());
  const b = new Simulation(build());

  runTicks(a, 500);
  runTicks(b, 500);

  const ea = a.snapshot().entities;
  const eb = b.snapshot().entities;
  assert.equal(ea.length, eb.length, "both runs must end with the same entity count");
  for (let i = 0; i < ea.length; i += 1) {
    assert.equal(ea[i].id, eb[i].id, "survivor ids must match in order");
    assert.equal(ea[i].health.current, eb[i].health.current, `entity ${ea[i].id} health diverged`);
  }
});

test("the shipped mechanism scene fields all seven families and resolves", () => {
  const sim = new Simulation(mechanismMatchup(FIXED_STEP_MS));

  const onField = new Set(sim.snapshot().entities.filter((e) => e.behavior).map((e) => e.behavior.kind));
  assert.deepEqual(
    [...onField].sort(),
    ["aura", "conveyor", "explosive", "shrine", "spike", "spring", "turret"],
    "the acceptance scene must exercise every mechanism family"
  );

  let decidedAt = -1;
  let peakShots = 0;
  let peakChain = 0;
  for (let i = 0; i < 2400; i += 1) {
    sim.step();
    peakShots = Math.max(peakShots, sim.projectileCount);
    peakChain = Math.max(peakChain, sim.chainLinks);
    if (sim.decided) {
      decidedAt = sim.tick;
      break;
    }
  }

  assert.ok(decidedAt > 0, "the mechanism scene must reach a decision rather than stalling");
  assert.ok(sim.mechanismDamage > 0, "the traps must actually hurt somebody");
  assert.ok(peakShots > 0, "the emitters must actually fire");
  assert.ok(peakChain <= 32, `blast chains must stay bounded, peaked at ${peakChain}`);

  // Nothing may be left holding a non-finite value after a scene this busy.
  for (const entity of sim.snapshot().entities) {
    assert.ok(Number.isFinite(entity.transform.position.x), `entity ${entity.id} x went non-finite`);
    assert.ok(Number.isFinite(entity.transform.position.y), `entity ${entity.id} y went non-finite`);
  }
});

test("units do not target field objects", () => {
  // A scene where the only "enemy" is a neutral mechanism. If a unit treats it as a target
  // it will walk at it, stop at its edge and swing forever — a unit that has silently
  // stopped fighting.
  const spike = findProp("prop.spike");
  const sim = new Simulation({
    seed: 11,
    fixedStepMs: FIXED_STEP_MS,
    bounds: BOUNDS,
    abilities: [],
    spawns: [
      { kind: "unit", faction: "red", x: 200, y: 300, radius: 12, mass: 1, hp: 200, facing: 0 },
      flatProp(spike.behavior, 600, 300)
    ]
  });

  runTicks(sim, 400);

  const unit = sim.snapshot().entities.find((e) => e.kind === "unit");
  assert.ok(unit, "the unit must survive a field with nothing to fight");
  // It has no AI target, so it must not have walked toward the spike.
  assert.ok(
    unit.transform.position.x < 400,
    `a unit with no hostile must not march at scenery, ended at x=${unit.transform.position.x}`
  );
});

test("a unit cannot destroy the mechanism it is standing in", () => {
  const lava = findProp("prop.lava");
  const sim = new Simulation(
    mechanismSetup(lava.behavior, { unitHp: 400, propColliderRadius: 1 })
  );

  runTicks(sim, 600);

  const props = sim.snapshot().entities.filter((e) => e.behavior);
  assert.equal(props.length, 1, "terrain must not be killable, however long a unit stands in it");
});

test("no shipped mechanism produces non-finite values over a long run", () => {
  // Every prop in the shipped library, shoulder to shoulder in one scene, with a brawl on
  // top of them. The point is the long run: a single NaN anywhere in a trap's arithmetic
  // will spread through the solver and poison the whole world within a few hundred ticks.
  const spawns = [];
  let x = 110;
  for (const prop of PROP_LIBRARY) {
    spawns.push({
      kind: "prop",
      faction: "neutral",
      x,
      y: 300,
      radius: prop.behavior.radius,
      mass: 3,
      hp: 1,
      facing: 0,
      behavior: prop.behavior
    });
    x += 115;
  }
  for (let i = 0; i < 6; i += 1) {
    spawns.push({
      kind: "unit",
      faction: i % 2 === 0 ? "red" : "blue",
      x: 120 + i * 110,
      y: 300,
      radius: 12,
      mass: 1,
      hp: 400,
      vx: i % 2 === 0 ? 40 : -40
    });
  }

  const sim = new Simulation({ seed: 5, fixedStepMs: FIXED_STEP_MS, bounds: BOUNDS, abilities: [], spawns });
  runTicks(sim, 900);

  for (const entity of sim.snapshot().entities) {
    const { x: px, y: py } = entity.transform.position;
    assert.ok(Number.isFinite(px) && Number.isFinite(py), `entity ${entity.id} position went non-finite`);
    assert.ok(Number.isFinite(entity.health.current), `entity ${entity.id} health went non-finite`);
  }
});
