/**
 * Deployment editor rules.
 *
 * The editor is the one place where a player can produce a layout the simulation cannot
 * survive — a unit inside a wall, two bodies in the same place, a field with one side on it.
 * None of those fail loudly once the battle starts: the solver ejects the first, separates
 * the second, and `isDecided` calls the third over before anything happens. So they are
 * refused before the battle, and this file is what proves they are.
 *
 * Run with: npm run test:editor
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  ARENA_BOUNDS,
  DRAFT_CATALOG,
  PROP_ID_OF_BEHAVIOR,
  defaultMatchup,
  draftToSetup,
  mechanismMatchup,
  squadMatchup,
  stressMatchup
} from "../src/content/deployment.ts";
import {
  EMPTY_DRAFT,
  addProp,
  addUnit,
  defaultFacing,
  draftFactions,
  draftFromSetup,
  draftReadiness,
  findPlacement,
  hitTestDraft,
  isDraftEmpty,
  issuesByKey,
  movePlacement,
  removePlacement,
  rotatePlacement,
  summariseDraft,
  validateDraft
} from "../src/editor/draft.ts";
import { Simulation } from "../src/simulation/index.ts";

const STEP = 1000 / 60;
const BOUNDS = ARENA_BOUNDS;

function unit(key, characterId, faction, x, y, facing = 0, tags) {
  return { key, characterId, faction, x, y, facing, ...(tags ? { tags } : {}) };
}

function prop(key, propId, x, y, facing = 0) {
  return { key, propId, x, y, facing };
}

function messages(issues) {
  return issues.map((issue) => issue.message);
}

// --- Validation --------------------------------------------------------------

test("a legal draft has no issues at all", () => {
  const draft = {
    units: [unit("u1", "red.blade", "red", 100, 300), unit("u2", "blue.skirmisher", "blue", 860, 300)],
    props: [prop("p1", "prop.lava", 480, 300)]
  };

  assert.deepEqual(validateDraft(draft, BOUNDS, DRAFT_CATALOG), []);
});

test("an unknown character or prop id is reported, not ignored", () => {
  const draft = {
    units: [unit("u1", "red.nobody", "red", 100, 300)],
    props: [prop("p1", "prop.nothing", 480, 300)]
  };

  const issues = validateDraft(draft, BOUNDS, DRAFT_CATALOG);
  assert.equal(issues.length, 2);
  assert.ok(messages(issues).some((m) => m.includes("red.nobody")));
  assert.ok(messages(issues).some((m) => m.includes("prop.nothing")));
  // Both are attached to the placement they are about, which is what drives the red ring.
  assert.deepEqual(issues.map((i) => i.key).sort(), ["p1", "u1"]);
});

test("a unit half outside the wall is rejected", () => {
  // The solver would push it back in and it would look like a late spawn.
  const draft = { units: [unit("u1", "red.blade", "red", 5, 300)], props: [] };
  const issues = validateDraft(draft, BOUNDS, DRAFT_CATALOG);

  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /边界/);
});

test("a prop half outside the wall is rejected", () => {
  // Clamped on its 10-unit collider, so 950 is still legal and 955 is not.
  assert.equal(validateDraft({ units: [], props: [prop("p1", "prop.lava", 950, 300)] }, BOUNDS, DRAFT_CATALOG).length, 0);

  const issues = validateDraft({ units: [], props: [prop("p1", "prop.lava", 955, 300)] }, BOUNDS, DRAFT_CATALOG);
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /边界/);
});

test("two units in the same place are rejected", () => {
  // The solver separates them and the result reads as one unit that spawned twice.
  const draft = {
    units: [unit("u1", "red.blade", "red", 200, 300), unit("u2", "red.lancer", "red", 205, 300)],
    props: []
  };

  const issues = validateDraft(draft, BOUNDS, DRAFT_CATALOG);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].key, "u2");
  assert.match(issues[0].message, /重叠/);
});

test("exactly touching counts as overlapping", () => {
  // Legal-looking, but tick 0 then resolves a deep penetration and the opening of the
  // battle depends on the solver rather than on the deployment.
  const radius = DRAFT_CATALOG.unitRadius("red.blade");
  const draft = {
    units: [
      unit("u1", "red.blade", "red", 200, 300),
      unit("u2", "red.blade", "red", 200 + radius * 2, 300)
    ],
    props: []
  };

  assert.equal(validateDraft(draft, BOUNDS, DRAFT_CATALOG).length, 1);
});

test("a unit standing inside a prop's effect is legal", () => {
  // The distinction the whole validator turns on. Lava is 54 units of effect around a
  // 10-unit body; a unit in the pool is the point of the pool.
  const draft = {
    units: [unit("u1", "red.blade", "red", 480, 340)],
    props: [prop("p1", "prop.lava", 480, 300)]
  };

  assert.equal(DRAFT_CATALOG.propEffectRadius("prop.lava"), 54);
  assert.equal(DRAFT_CATALOG.propBodyRadius("prop.lava"), 10);
  assert.deepEqual(validateDraft(draft, BOUNDS, DRAFT_CATALOG), []);
});

test("a unit inside a prop's body is rejected", () => {
  const draft = {
    units: [unit("u1", "red.blade", "red", 480, 308)],
    props: [prop("p1", "prop.lava", 480, 300)]
  };

  const issues = validateDraft(draft, BOUNDS, DRAFT_CATALOG);
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /机关/);
});

test("two props in the same place are rejected", () => {
  // Their colliders are fixed bodies, so the solver cannot push them apart — they just
  // jitter whatever walks past.
  const draft = {
    units: [],
    props: [prop("p1", "prop.spring", 300, 300), prop("p2", "prop.spring", 310, 300)]
  };

  const issues = validateDraft(draft, BOUNDS, DRAFT_CATALOG);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].key, "p2");
});

test("two props whose effects overlap but whose bodies do not are legal", () => {
  // Two lava pools 100 apart: 54-unit effects overlap, 10-unit bodies do not.
  const draft = {
    units: [],
    props: [prop("p1", "prop.lava", 400, 300), prop("p2", "prop.lava", 500, 300)]
  };

  assert.deepEqual(validateDraft(draft, BOUNDS, DRAFT_CATALOG), []);
});

// --- Readiness ---------------------------------------------------------------

test("an empty field cannot be fought", () => {
  assert.equal(isDraftEmpty(EMPTY_DRAFT), true);
  assert.equal(draftReadiness(EMPTY_DRAFT).ready, false);
  assert.match(draftReadiness(EMPTY_DRAFT).reason, /没有放置/);
});

test("a field with one side on it cannot be fought", () => {
  // `isDecided` sees a single surviving faction and calls it over on tick 0, so the app
  // would jump to 已分胜负 on an arena where nothing happened.
  const draft = { units: [unit("u1", "red.blade", "red", 100, 300)], props: [] };
  const readiness = draftReadiness(draft);

  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /红方/);
  assert.deepEqual(draftFactions(draft), ["red"]);
});

test("both sides present means ready, whatever the counts", () => {
  const draft = {
    units: [unit("u1", "red.blade", "red", 100, 300), unit("u2", "blue.skirmisher", "blue", 860, 300)],
    props: [prop("p1", "prop.lava", 480, 300)]
  };

  assert.deepEqual(draftReadiness(draft), { ready: true, reason: "" });
  assert.equal(summariseDraft(draft), "红 1 · 蓝 1 · 机关 1");
});

test("default facing points each side at the other", () => {
  assert.equal(defaultFacing("red"), 0);
  assert.equal(defaultFacing("blue"), Math.PI);
});

// --- Adding ------------------------------------------------------------------

test("adding a unit from the palette always lands somewhere legal", () => {
  // The alternative is that the first thing a new player sees is a red ring, which reads as
  // "this is broken" rather than "move it".
  let draft = EMPTY_DRAFT;
  for (let i = 0; i < 6; i += 1) {
    draft = addUnit(draft, "red.blade", "red", BOUNDS, DRAFT_CATALOG).draft;
    draft = addUnit(draft, "blue.skirmisher", "blue", BOUNDS, DRAFT_CATALOG).draft;
  }

  assert.equal(draft.units.length, 12);
  assert.deepEqual(validateDraft(draft, BOUNDS, DRAFT_CATALOG), []);
});

test("adding every prop in the library never overlaps them", () => {
  let draft = EMPTY_DRAFT;
  for (const id of [
    "prop.lava",
    "prop.conveyor",
    "prop.spring",
    "prop.barrel",
    "prop.spike",
    "prop.turret",
    "prop.shrine"
  ]) {
    const result = addProp(draft, id, BOUNDS, DRAFT_CATALOG);
    assert.equal(result.draft.props.length, draft.props.length + 1);
    draft = result.draft;
  }

  assert.deepEqual(validateDraft(draft, BOUNDS, DRAFT_CATALOG), []);
});

test("keys are unique and adding returns the new one for selection", () => {
  const first = addUnit(EMPTY_DRAFT, "red.blade", "red", BOUNDS, DRAFT_CATALOG);
  const second = addUnit(first.draft, "red.lancer", "red", BOUNDS, DRAFT_CATALOG);

  assert.notEqual(first.key, second.key);
  assert.equal(first.key, "u1");
  assert.equal(second.key, "u2");
  assert.equal(findPlacement(second.draft, second.key)?.x, second.draft.units[1].x);
});

test("an unknown id adds nothing rather than a broken placement", () => {
  const result = addUnit(EMPTY_DRAFT, "red.nobody", "red", BOUNDS, DRAFT_CATALOG);
  assert.equal(result.draft.units.length, 0);
  assert.equal(result.key, "");
});

// --- Moving, turning, removing ----------------------------------------------

test("moving clamps to the wall instead of letting a body leave the arena", () => {
  const draft = { units: [unit("u1", "red.blade", "red", 200, 300)], props: [] };
  const radius = DRAFT_CATALOG.unitRadius("red.blade");

  const moved = movePlacement(draft, "u1", -500, 9999, BOUNDS, DRAFT_CATALOG);
  assert.equal(moved.units[0].x, radius);
  assert.equal(moved.units[0].y, BOUNDS.height - radius);
});

test("moving a prop clamps on its collider, not its effect", () => {
  // Clamping on the effect radius would keep a lava pool 54 units from every wall, which
  // puts a visible gap between the pool and the wall it looks like it is touching.
  const draft = { units: [], props: [prop("p1", "prop.lava", 480, 300)] };
  const moved = movePlacement(draft, "p1", -100, -100, BOUNDS, DRAFT_CATALOG);

  assert.equal(moved.props[0].x, DRAFT_CATALOG.propBodyRadius("prop.lava"));
  assert.equal(moved.props[0].y, DRAFT_CATALOG.propBodyRadius("prop.lava"));
});

test("moving a key that is not there changes nothing", () => {
  const draft = { units: [unit("u1", "red.blade", "red", 200, 300)], props: [] };
  assert.equal(movePlacement(draft, "nope", 0, 0, BOUNDS, DRAFT_CATALOG), draft);
});

test("turning normalises into [0, 2π)", () => {
  const draft = { units: [unit("u1", "red.blade", "red", 200, 300, 0)], props: [] };

  const back = rotatePlacement(draft, "u1", -Math.PI / 12);
  assert.ok(back.units[0].facing > 0 && back.units[0].facing < Math.PI * 2);
  assert.ok(Math.abs(back.units[0].facing - (Math.PI * 2 - Math.PI / 12)) < 1e-9);

  const round = rotatePlacement(draft, "u1", Math.PI * 2);
  assert.ok(round.units[0].facing < 1e-9);
});

test("removing takes the placement out and leaves the rest alone", () => {
  const draft = {
    units: [unit("u1", "red.blade", "red", 200, 300), unit("u2", "blue.skirmisher", "blue", 700, 300)],
    props: [prop("p1", "prop.lava", 480, 300)]
  };

  const after = removePlacement(draft, "u1");
  assert.deepEqual(
    after.units.map((u) => u.key),
    ["u2"]
  );
  assert.equal(after.props.length, 1);
  assert.equal(removePlacement(after, "gone").units.length, 1);
});

test("every edit returns a new draft and never mutates the old one", () => {
  // The draft is React state; an in-place edit changes the data without changing what is on
  // screen, which is the bug that makes an editor feel broken while its maths still passes.
  const draft = {
    units: [unit("u1", "red.blade", "red", 200, 300, 0)],
    props: [prop("p1", "prop.lava", 480, 300)]
  };
  const snapshot = JSON.stringify(draft);

  movePlacement(draft, "u1", 400, 400, BOUNDS, DRAFT_CATALOG);
  rotatePlacement(draft, "u1", 1);
  removePlacement(draft, "u1");
  addUnit(draft, "blue.skirmisher", "blue", BOUNDS, DRAFT_CATALOG);
  addProp(draft, "prop.spike", BOUNDS, DRAFT_CATALOG);

  assert.equal(JSON.stringify(draft), snapshot);
});

// --- Hit testing -------------------------------------------------------------

test("a unit is picked before the prop it is standing in", () => {
  const draft = {
    units: [unit("u1", "red.blade", "red", 100, 100)],
    props: [prop("p1", "prop.lava", 100, 100)]
  };

  assert.equal(hitTestDraft(draft, DRAFT_CATALOG, 100, 100), "u1");
});

test("a prop is grabbable anywhere in its effect footprint", () => {
  const draft = { units: [], props: [prop("p1", "prop.lava", 100, 100)] };

  // 40 units out is well outside the 10-unit collider and well inside the 54-unit effect.
  assert.equal(hitTestDraft(draft, DRAFT_CATALOG, 100, 140), "p1");
  assert.equal(hitTestDraft(draft, DRAFT_CATALOG, 100, 200), undefined);
});

test("the later of two stacked placements is the one picked", () => {
  // Which is the one drawn on top, so the thing under the cursor is the thing you get.
  const draft = {
    units: [
      unit("u1", "red.blade", "red", 100, 100),
      unit("u2", "red.lancer", "red", 110, 100)
    ],
    props: []
  };

  assert.equal(hitTestDraft(draft, DRAFT_CATALOG, 106, 100), "u2");
});

test("clicking empty floor selects nothing", () => {
  const draft = { units: [unit("u1", "red.blade", "red", 100, 100)], props: [] };
  assert.equal(hitTestDraft(draft, DRAFT_CATALOG, 700, 500), undefined);
});

test("issues are grouped by placement for the red rings", () => {
  const draft = {
    units: [unit("u1", "red.nobody", "red", 100, 300), unit("u2", "red.blade", "red", 300, 300)],
    props: []
  };
  const grouped = issuesByKey(validateDraft(draft, BOUNDS, DRAFT_CATALOG));

  assert.equal(grouped.size, 1);
  assert.equal(grouped.get("u1")?.length, 1);
  assert.equal(grouped.has("u2"), false);
});

// --- Import round trip -------------------------------------------------------

test("a scene round-trips through the draft without moving anything", () => {
  const setup = defaultMatchup(STEP);
  const draft = draftFromSetup(setup, PROP_ID_OF_BEHAVIOR);
  const rebuilt = draftToSetup(draft, { fixedStepMs: STEP, template: setup });

  assert.equal(rebuilt.spawns.length, setup.spawns.length);
  for (let i = 0; i < setup.spawns.length; i += 1) {
    assert.equal(rebuilt.spawns[i].characterId, setup.spawns[i].characterId);
    assert.equal(rebuilt.spawns[i].faction, setup.spawns[i].faction);
    assert.equal(rebuilt.spawns[i].x, setup.spawns[i].x);
    assert.equal(rebuilt.spawns[i].y, setup.spawns[i].y);
    assert.equal(rebuilt.spawns[i].facing, setup.spawns[i].facing);
  }
});

test("prop identity is recovered field by field, not by mechanism family", () => {
  // Matching on `kind` alone works only because the shipped library happens to have one prop
  // per family. The barrel appears twice, and both have to come back as `prop.barrel`.
  const setup = mechanismMatchup(STEP);
  const draft = draftFromSetup(setup, PROP_ID_OF_BEHAVIOR);

  assert.equal(draft.props.length, 8);
  assert.equal(draft.props.filter((p) => p.propId === "prop.barrel").length, 2);

  const rebuilt = draftToSetup(draft, { fixedStepMs: STEP, template: setup });
  assert.equal(rebuilt.spawns.length, setup.spawns.length);
  assert.equal(rebuilt.spawns.filter((s) => s.kind === "prop").length, 8);
  assert.equal(rebuilt.spawns.filter((s) => s.kind === "unit").length, 8);
});

test("a mechanism scene round-trips to the same battle", () => {
  // The strongest form of "the preview is the fight": the round-tripped setup is not merely
  // similar, it produces the same resolution on the same tick.
  const setup = mechanismMatchup(STEP);
  const rebuilt = draftToSetup(draftFromSetup(setup, PROP_ID_OF_BEHAVIOR), {
    fixedStepMs: STEP,
    template: setup
  });

  const a = new Simulation(setup);
  const b = new Simulation(rebuilt);
  for (let i = 0; i < 600 && !a.decided && !b.decided; i += 1) {
    a.step();
    b.step();
  }

  assert.equal(b.tick, a.tick);
  assert.equal(b.decided, a.decided);
  assert.equal(b.mechanismDamage, a.mechanismDamage);
});

test("spawn-level tags survive an import and an edit", () => {
  // The editor has no UI for them, so without carrying them the first drag would silently
  // strip every scenario override in the file.
  const setup = {
    seed: 1,
    fixedStepMs: STEP,
    bounds: BOUNDS,
    abilities: [],
    spawns: [
      {
        kind: "unit",
        faction: "red",
        x: 100,
        y: 300,
        radius: 13,
        mass: 1,
        hp: 100,
        characterId: "red.blade",
        tags: ["armored"]
      }
    ]
  };

  const draft = draftFromSetup(setup, PROP_ID_OF_BEHAVIOR);
  assert.deepEqual(draft.units[0].tags, ["armored"]);

  const moved = movePlacement(draft, draft.units[0].key, 200, 300, BOUNDS, DRAFT_CATALOG);
  const rebuilt = draftToSetup(moved, { fixedStepMs: STEP, template: setup });

  assert.deepEqual(rebuilt.spawns[0].tags, ["armored"]);
  assert.equal(rebuilt.spawns[0].x, 200);
});

test("the template keeps everything the editor does not model", () => {
  // A file with a hand-written ability must not come back from one nudge having lost it.
  const homebrew = {
    id: "ability.homebrew",
    name: "自制",
    geometry: { kind: "circle", radius: 20 },
    damage: 7,
    windupTicks: 3,
    activeTicks: 1,
    cooldownTicks: 30,
    range: 20
  };
  const setup = {
    seed: 4242,
    fixedStepMs: STEP,
    bounds: { width: 1200, height: 500 },
    spawns: [
      { kind: "unit", faction: "red", x: 100, y: 250, radius: 13, mass: 1, hp: 100, characterId: "red.blade" },
      { kind: "unit", faction: "blue", x: 1100, y: 250, radius: 13, mass: 1, hp: 100, characterId: "blue.skirmisher" }
    ],
    abilities: [homebrew],
    buffs: [],
    characters: [{ id: "red.blade", abilityIds: ["ability.homebrew"], speed: 100, aggroRange: 200, tags: [] }]
  };

  const draft = draftFromSetup(setup, PROP_ID_OF_BEHAVIOR);
  const rebuilt = draftToSetup(draft, { fixedStepMs: STEP, template: setup });

  assert.equal(rebuilt.seed, 4242);
  assert.deepEqual(rebuilt.bounds, { width: 1200, height: 500 });
  assert.deepEqual(rebuilt.abilities, [homebrew]);
  assert.deepEqual(rebuilt.characters, setup.characters);

  // The control: without the template the library's own list is used instead, which is what
  // the template exists to prevent.
  const bare = draftToSetup(draft, { fixedStepMs: STEP });
  assert.notDeepEqual(bare.abilities, [homebrew]);
  assert.deepEqual(bare.bounds, BOUNDS);
});

// --- The Phase 2 acceptance clause ------------------------------------------

test("every shipped scene is placeable and fightable", () => {
  // A scene that the editor refuses is a scene nobody can start, and the failure is silent
  // everywhere else: the units render, the readout is right, and only the 开战 button is
  // dead. Both the squad column and the stress grid were outside the separation rule when
  // this was written, and both had been spawning overlapping units for three phases.
  const scenes = [
    ["battle", defaultMatchup(STEP)],
    ["squad", squadMatchup(STEP, 3)],
    ["mechanism", mechanismMatchup(STEP)],
    ["stress", stressMatchup(STEP)]
  ];

  for (const [name, setup] of scenes) {
    const draft = draftFromSetup(setup, PROP_ID_OF_BEHAVIOR);
    assert.deepEqual(validateDraft(draft, setup.bounds, DRAFT_CATALOG), [], `${name} must be placeable`);
    assert.equal(draftReadiness(draft).ready, true, `${name} must have both sides`);
  }
});

test("a player can build a fightable field from nothing and reset it", () => {
  // The architecture's Phase 2 gate: 「玩家能从空场完成一局并重置」.
  let draft = EMPTY_DRAFT;
  assert.equal(draftReadiness(draft).ready, false);

  draft = addUnit(draft, "red.blade", "red", BOUNDS, DRAFT_CATALOG).draft;
  assert.equal(draftReadiness(draft).ready, false, "one side is not a battle");

  draft = addUnit(draft, "blue.skirmisher", "blue", BOUNDS, DRAFT_CATALOG).draft;
  assert.equal(draftReadiness(draft).ready, true);
  assert.deepEqual(validateDraft(draft, BOUNDS, DRAFT_CATALOG), []);

  const setup = draftToSetup(draft, { fixedStepMs: STEP, bounds: BOUNDS });
  const simulation = new Simulation(setup);
  const opening = simulateSnapshot(simulation);

  assert.equal(simulation.tick, 0);
  assert.equal(opening.length, 2);

  let ticks = 0;
  while (!simulation.decided && ticks < 6000) {
    simulation.step();
    ticks += 1;
  }
  assert.equal(
    simulation.decided,
    true,
    `a 1v1 on an empty field must resolve; still fighting at ${ticks} ticks`
  );

  // Reset: a fresh simulation from the same immutable setup starts exactly where the first
  // one did. The setup is never mutated, which is why "reset" and "keep editing" are
  // different operations rather than the same one.
  const reset = new Simulation(setup);
  assert.equal(reset.tick, 0);
  assert.deepEqual(simulateSnapshot(reset), opening);
});

test("resetting after an edit restores the edited layout, not the scene default", () => {
  const draft = draftFromSetup(defaultMatchup(STEP), PROP_ID_OF_BEHAVIOR);
  const edited = movePlacement(draft, draft.units[0].key, 300, 300, BOUNDS, DRAFT_CATALOG);
  const setup = draftToSetup(edited, { fixedStepMs: STEP, bounds: BOUNDS });

  const first = new Simulation(setup);
  const opening = simulateSnapshot(first);
  for (let i = 0; i < 120; i += 1) {
    first.step();
  }

  const reset = new Simulation(setup);
  assert.deepEqual(simulateSnapshot(reset), opening);
  assert.equal(reset.snapshot().entities.find((e) => e.combat)?.transform.position.x, 300);
});

/** Tick-zero state, flattened so it can be compared across two simulations. */
function simulateSnapshot(simulation) {
  return simulation
    .snapshot()
    .entities.map((entity) => [
      entity.id,
      entity.faction,
      entity.transform.position.x,
      entity.transform.position.y,
      entity.transform.facing,
      entity.health.current
    ]);
}
