/**
 * Tag and buff assertions.
 *
 * The acceptance bar for this system is not "the numbers are right" — that is a balance
 * question and the numbers here are scaffolding. It is four properties that are invisible
 * to a code read and invisible in a screenshot:
 *
 *   1. A tag that no rule interprets is *inert*, not broken. That is the design, and it is
 *      also the failure mode: an inert tag looks exactly like a working one until you
 *      measure. So the shipped library is asserted to have no inert tags.
 *   2. Stacks combine additively and are clamped. A multiplicative pile-up of slows would
 *      freeze a unit; a negative multiplier would make it walk backwards. Neither throws.
 *   3. An expired effect is removed the tick it expires, including when several expire
 *      together — the splice-during-forward-iteration bug leaves a buff alive forever on
 *      exactly the entities that have several.
 *   4. Effects do not cost determinism. Per-entity mutable state is the classic way a
 *      replay starts diverging, so a seeded battle with buffs in play is asserted
 *      bit-for-bit.
 *
 * Run with: npm run test:effects
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  NEUTRAL_MODIFIER,
  TAG_RULES,
  applyBuff,
  ignoresGroundHazards,
  modifiersOf,
  stepBuffs
} from "../src/simulation/effects.ts";
import { stepCombat } from "../src/simulation/combat.ts";
import { mechanismAffects } from "../src/simulation/mechanisms.ts";
import { Simulation } from "../src/simulation/simulation.ts";
import { ABILITY_LIBRARY, BUFF_LIBRARY, CHARACTER_LIBRARY, TAG_LABELS } from "../src/content/library.ts";
import { abilitySpecs, buffSpecs, combatProfiles, defaultMatchup } from "../src/content/deployment.ts";

const FIXED_STEP_MS = 1000 / 60;

/** A minimal entity. Only the components the effects system reads are meaningful. */
function entity(id, overrides = {}) {
  return {
    id,
    kind: "unit",
    faction: "red",
    tags: [],
    transform: { position: { x: 0, y: 0 }, facing: 0 },
    motion: { velocity: { x: 0, y: 0 } },
    collider: { radius: 12, mass: 1, fixed: false },
    health: { current: 100, max: 100 },
    render: { appearance: "test" },
    ...overrides
  };
}

/** A catalog over an ad-hoc spec list, so a test never needs the content library. */
function catalogOf(...specs) {
  const byId = new Map(specs.map((s) => [s.id, s]));
  return (id) => byId.get(id);
}

const NO_BUFFS = () => undefined;

/** A complete `PropBehavior`, so `mechanismAffects` can be asked a real question. */
function behavior(kind, overrides = {}) {
  return {
    kind,
    radius: 40,
    damage: 0,
    intervalTicks: 0,
    cooldownTicks: 0,
    force: 0,
    reach: 40,
    affects: "all",
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Tag rules
// ---------------------------------------------------------------------------

test("an entity with no tags and no buffs gets the identity modifier, by reference", () => {
  // The fast path returns the shared constant rather than building a new object. This runs
  // several times per entity per tick, and on the 100-unit scene it is the difference
  // between zero allocations and a few hundred per tick.
  const plain = entity(1);
  assert.equal(modifiersOf(plain, NO_BUFFS), NEUTRAL_MODIFIER);
});

test("an unrecognised tag is inert rather than an error", () => {
  // Content may carry descriptive labels. The simulation is not allowed to guess at them,
  // and it is not allowed to throw either.
  const tagged = entity(1, { tags: ["descriptive-only", "flavour"] });
  const m = modifiersOf(tagged, NO_BUFFS);
  assert.equal(m.moveSpeed, 1);
  assert.equal(m.damageOut, 1);
  assert.equal(m.damageIn, 1);
  assert.equal(m.attackRate, 1);
});

test("armored trades movement for damage reduction, and the trade cuts both ways", () => {
  const m = modifiersOf(entity(1, { tags: ["armored"] }), NO_BUFFS);
  assert.equal(m.moveSpeed, TAG_RULES.armored.moveSpeed);
  assert.equal(m.damageIn, TAG_RULES.armored.damageIn);
  assert.ok(m.moveSpeed < 1, "armour must cost speed, or the tag is a free upgrade");
  assert.ok(m.damageIn < 1, "armour must actually reduce incoming damage");
  assert.equal(m.damageOut, 1, "armour must not change damage dealt");
});

test("frenzied trades survivability for damage", () => {
  const m = modifiersOf(entity(1, { tags: ["frenzied"] }), NO_BUFFS);
  assert.ok(m.damageOut > 1, "frenzy must increase damage dealt");
  assert.ok(m.damageIn > 1, "frenzy must increase damage taken");
});

test("the shipped characters use only tags the capability table can interpret", () => {
  // This is the assertion that catches a silently inert tag. A character carrying
  // "armoured" (British spelling) validates, renders, and does nothing at all.
  const used = new Set(CHARACTER_LIBRARY.flatMap((c) => c.tags ?? []));
  assert.ok(used.size > 0, "the shipped roster must exercise the tag system at all");
  for (const tag of used) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(TAG_RULES, tag),
      `character tag "${tag}" has no rule in TAG_RULES, so it would be inert`
    );
  }
});

test("the tag label table covers the capability table exactly", () => {
  // The help screen is generated from TAG_RULES and labelled from TAG_LABELS. If one gains
  // a key and the other does not, the shipped legend shows a row reading "flying" — or,
  // worse, silently drops a rule a player can actually meet. Two tables, one test.
  assert.deepEqual(
    Object.keys(TAG_LABELS).sort(),
    Object.keys(TAG_RULES).sort(),
    "TAG_LABELS must have exactly one entry per tag rule, and no orphans"
  );
});

test("every tag carried by a shipped character reaches the simulation profile", () => {
  // `combatProfiles` is the seam between content and core. Dropping `tags` there would
  // leave the capability table with nothing to interpret while every part of the system
  // still looked correct on its own.
  const profiles = new Map(combatProfiles().map((p) => [p.id, p]));
  for (const character of CHARACTER_LIBRARY) {
    const profile = profiles.get(character.id);
    assert.ok(profile, `character ${character.id} has no combat profile`);
    assert.deepEqual(
      [...(profile.tags ?? [])],
      [...(character.tags ?? [])],
      `tags for ${character.id} must survive the projection into the core`
    );
  }
});

// ---------------------------------------------------------------------------
// Modifier aggregation
// ---------------------------------------------------------------------------

test("buff stacks combine additively, so the second stack is as strong as the first", () => {
  const spec = { id: "test.slow", name: "slow", durationTicks: 60, maxStacks: 4, moveSpeed: 0.7 };
  const catalog = catalogOf(spec);
  const target = entity(1, { buffs: [{ id: "test.slow", sourceId: 0, ticksLeft: 60, stacks: 1 }] });

  assert.ok(Math.abs(modifiersOf(target, catalog).moveSpeed - 0.7) < 1e-9);

  target.buffs[0].stacks = 2;
  const two = modifiersOf(target, catalog).moveSpeed;
  // Additive: 1 + (0.7 - 1) * 2 = 0.4. Multiplicative would give 0.49.
  assert.ok(Math.abs(two - 0.4) < 1e-9, `two stacks must be -60%, got ${two}`);
});

test("a stack pile-up is clamped, so it can never freeze or reverse a unit", () => {
  // Nothing stops an authored `SpawnDef.buffs` from carrying an arbitrary stack count, and
  // a negative moveSpeed multiplier would make a unit walk backwards — a spectacular
  // failure that raises no error anywhere.
  const spec = { id: "test.drag", name: "drag", durationTicks: 60, maxStacks: 99, moveSpeed: 0.2 };
  const target = entity(1, { buffs: [{ id: "test.drag", sourceId: 0, ticksLeft: 60, stacks: 20 }] });

  const m = modifiersOf(target, catalogOf(spec));
  assert.ok(m.moveSpeed > 0, `moveSpeed must stay positive, got ${m.moveSpeed}`);
  assert.ok(m.moveSpeed < 0.2, "the clamp must still let a heavy pile-up be slower than one stack");
});

test("tags and buffs layer on the same stat instead of overriding each other", () => {
  // An armoured unit under a slow should be slower than either effect alone. If the two
  // wrote the same field rather than summing deltas, the last one applied would win.
  const spec = { id: "test.slow", name: "slow", durationTicks: 60, maxStacks: 1, moveSpeed: 0.7 };
  const armored = entity(1, { tags: ["armored"] });
  const armoredAndSlowed = entity(1, {
    tags: ["armored"],
    buffs: [{ id: "test.slow", sourceId: 0, ticksLeft: 60, stacks: 1 }]
  });

  const alone = modifiersOf(armored, catalogOf(spec)).moveSpeed;
  const both = modifiersOf(armoredAndSlowed, catalogOf(spec)).moveSpeed;
  assert.ok(both < alone, `a slow must compound with armour: ${both} should be below ${alone}`);
});

test("an unknown buff id is skipped rather than treated as neutral-or-fatal", () => {
  // The catalog is a lookup, and a miss is possible whenever content and runtime disagree.
  // Skipping keeps the rest of the entity's modifiers correct.
  const target = entity(1, {
    tags: ["armored"],
    buffs: [{ id: "buff.does-not-exist", sourceId: 0, ticksLeft: 60, stacks: 3 }]
  });
  const m = modifiersOf(target, NO_BUFFS);
  assert.equal(m.moveSpeed, TAG_RULES.armored.moveSpeed);
});

// ---------------------------------------------------------------------------
// Applying and expiring
// ---------------------------------------------------------------------------

test("a fresh buff starts at full duration and one stack", () => {
  const spec = { id: "b", name: "b", durationTicks: 90, maxStacks: 3, damageOut: 0.8 };
  const target = entity(1);
  applyBuff(target, spec, 7);

  assert.equal(target.buffs.length, 1);
  assert.equal(target.buffs[0].id, "b");
  assert.equal(target.buffs[0].ticksLeft, 90);
  assert.equal(target.buffs[0].stacks, 1);
  assert.equal(target.buffs[0].sourceId, 7);
});

test("re-applying refreshes the timer instead of extending it", () => {
  // Extending without bound lets a fast attacker keep a permanent slow on a target it is
  // already beating, which turns a tempo effect into a lock.
  const spec = { id: "b", name: "b", durationTicks: 90, maxStacks: 1, moveSpeed: 0.6 };
  const target = entity(1);
  applyBuff(target, spec, 1);

  target.buffs[0].ticksLeft = 5;
  applyBuff(target, spec, 1);

  assert.equal(target.buffs[0].ticksLeft, 90, "a re-application must reset, not add");
  assert.equal(target.buffs.length, 1, "re-applying must not create a second entry");
});

test("re-applying stacks up to maxStacks and then stops", () => {
  const spec = { id: "b", name: "b", durationTicks: 90, maxStacks: 2, damageOut: 0.8 };
  const target = entity(1);

  applyBuff(target, spec, 1);
  applyBuff(target, spec, 1);
  applyBuff(target, spec, 1);

  assert.equal(target.buffs.length, 1);
  assert.equal(target.buffs[0].stacks, 2, "stacks must cap at maxStacks");
});

test("a buff that declares exclusions removes what it excludes", () => {
  const haste = { id: "haste", name: "haste", durationTicks: 60, maxStacks: 1, moveSpeed: 1.4 };
  const slow = {
    id: "slow",
    name: "slow",
    durationTicks: 60,
    maxStacks: 1,
    moveSpeed: 0.6,
    excludes: ["haste"]
  };
  const target = entity(1);

  applyBuff(target, haste, 1);
  assert.deepEqual(target.buffs.map((b) => b.id), ["haste"]);

  applyBuff(target, slow, 1);
  assert.deepEqual(target.buffs.map((b) => b.id), ["slow"], "haste must be removed by slow");
});

test("an expired effect is dropped on the tick it expires", () => {
  const target = entity(1, { buffs: [{ id: "b", sourceId: 0, ticksLeft: 1, stacks: 1 }] });
  stepBuffs([target]);
  assert.equal(target.buffs.length, 0);
});

test("several effects expiring on the same tick are all removed", () => {
  // The splice-during-forward-iteration guard. With a forward loop, removing index 0 shifts
  // the next entry into that slot, the loop index advances past it, and the second buff
  // survives one tick too long — on exactly the entities that carry more than one.
  const target = entity(1, {
    buffs: [
      { id: "a", sourceId: 0, ticksLeft: 1, stacks: 1 },
      { id: "b", sourceId: 0, ticksLeft: 1, stacks: 1 },
      { id: "c", sourceId: 0, ticksLeft: 1, stacks: 1 }
    ]
  });

  stepBuffs([target]);
  assert.deepEqual(target.buffs, [], "every expired buff must go in one pass");
});

test("a mixed set of effects counts down together and only the expired ones go", () => {
  const target = entity(1, {
    buffs: [
      { id: "a", sourceId: 0, ticksLeft: 1, stacks: 1 },
      { id: "b", sourceId: 0, ticksLeft: 3, stacks: 2 }
    ]
  });

  stepBuffs([target]);
  assert.deepEqual(target.buffs.map((b) => b.id), ["b"]);
  assert.equal(target.buffs[0].ticksLeft, 2);
  assert.equal(target.buffs[0].stacks, 2, "counting down must not disturb stack counts");
});

test("stepping an entity with no effects does not allocate one", () => {
  const plain = entity(1);
  stepBuffs([plain]);
  assert.equal(plain.buffs, undefined);
});

// ---------------------------------------------------------------------------
// Ground hazards and flying
// ---------------------------------------------------------------------------

test("flying passes over floor mechanisms but not over blasts or gunfire", () => {
  // The exemption is keyed on the mechanism, not on the unit. This test is the statement of
  // that boundary: if someone widens `GROUND_BOUND`, this fails.
  const flying = entity(1, { tags: ["flying"] });
  const walker = entity(2);

  for (const kind of ["aura", "conveyor", "spring", "spike"]) {
    assert.equal(mechanismAffects(behavior(kind), "neutral", flying), false, `${kind} must be a floor`);
    assert.equal(mechanismAffects(behavior(kind), "neutral", walker), true, `${kind} must catch a walker`);
  }

  for (const kind of ["explosive", "turret", "shrine"]) {
    assert.equal(mechanismAffects(behavior(kind), "neutral", flying), true, `${kind} is not a floor`);
  }
});

test("flying is not 'immune to everything': faction rules still apply", () => {
  const flyingBlue = entity(1, { faction: "blue", tags: ["flying"] });
  // A red-owned turret still cannot shoot a blue ally... but a neutral one shoots everyone.
  assert.equal(mechanismAffects(behavior("turret", { affects: "hostile" }), "red", flyingBlue), true);
  assert.equal(mechanismAffects(behavior("turret", { affects: "hostile" }), "blue", flyingBlue), false);
});

test("ignoresGroundHazards is false for an entity with no flying tag", () => {
  assert.equal(ignoresGroundHazards(entity(1)), false);
  assert.equal(ignoresGroundHazards(entity(1, { tags: ["armored", "frenzied"] })), false);
  assert.equal(ignoresGroundHazards(entity(1, { tags: ["flying"] })), true);
});

test("a flying unit takes nothing from lava while an identical walker standing in it does", () => {
  // The integration form of the previous test: the pure predicate being right is not the
  // same as the mechanism pipeline honouring it.
  const setup = {
    seed: 99,
    fixedStepMs: FIXED_STEP_MS,
    bounds: { width: 600, height: 600 },
    abilities: [],
    spawns: [
      {
        kind: "unit",
        faction: "red",
        x: 270,
        y: 300,
        radius: 12,
        mass: 1,
        hp: 200,
        tags: ["flying"]
      },
      { kind: "unit", faction: "red", x: 330, y: 300, radius: 12, mass: 1, hp: 200 },
      {
        kind: "prop",
        faction: "neutral",
        x: 300,
        y: 300,
        // A marker collider, not a wall: if it matched the effect radius the solver would
        // eject both units before the aura ever pulsed.
        radius: 1,
        mass: 3,
        hp: 1,
        behavior: behavior("aura", { radius: 60, damage: 6, intervalTicks: 30, affects: "all" })
      }
    ]
  };

  const sim = new Simulation(setup);
  for (let i = 0; i < 95; i += 1) {
    sim.step();
  }

  const [flier, walker] = sim.snapshot().entities;
  assert.equal(flier.tags.includes("flying"), true);
  assert.equal(flier.health.current, 200, "a flying unit must take no lava damage at all");
  assert.ok(walker.health.current < 200, `the walker must be hurt, got ${walker.health.current}`);
});

// ---------------------------------------------------------------------------
// Combat integration
// ---------------------------------------------------------------------------

const MELEE = {
  id: "test.melee",
  name: "test melee",
  geometry: { kind: "melee", range: 40 },
  windupTicks: 20,
  activeTicks: 1,
  cooldownTicks: 20,
  damage: 20,
  maxTargets: 1,
  turnToTarget: 1
};

/**
 * Melee reach is measured from a circle offset `range` ahead of the caster, so a target
 * standing *on* the caster is not hit. The target sits at the reach point instead, which
 * is where a swing actually connects.
 */
const SELF_AT = { position: { x: 0, y: 0 }, facing: 0 };
const TARGET_AT = { position: { x: MELEE.geometry.range, y: 0 }, facing: 0 };

function fighter(id, overrides = {}) {
  return entity(id, {
    transform: SELF_AT,
    collider: { radius: 12, mass: 1, fixed: true },
    combat: {
      characterId: "test",
      abilityIndex: 0,
      phase: "windup",
      phaseTicksLeft: MELEE.windupTicks,
      applied: false,
      aggroRange: 100,
      desiredVelocity: { x: 0, y: 0 }
    },
    ...overrides
  });
}

/**
 * Runs one entity's phase machine until its damaging frame lands.
 *
 * `stepCombat` advances exactly one tick, so a single call is a no-op for the first
 * `windupTicks` calls — the hit is twenty ticks away, not one. Every test below wants the
 * hit rather than the tick, so they share this loop.
 */
function resolveFirstHit(self, ability, target, catalog, maxTicks = 400) {
  const candidates = [self, target];
  for (let tick = 1; tick <= maxTicks; tick += 1) {
    const result = stepCombat(self, ability, target, candidates, tick, catalog);
    if (result.events.length > 0) {
      return { tick, result };
    }
  }
  return { tick: -1, result: { events: [], removed: [] } };
}

test("mitigation applies on the way in, from both sides of the exchange", () => {
  const armored = fighter(2, { faction: "blue", transform: TARGET_AT, tags: ["armored"] });
  const plain = fighter(3, { faction: "blue", transform: TARGET_AT });

  const vsArmored = resolveFirstHit(fighter(1), MELEE, armored, NO_BUFFS);
  const vsPlain = resolveFirstHit(fighter(1), MELEE, plain, NO_BUFFS);

  const armoredDamage = armored.health.max - armored.health.current;
  const plainDamage = plain.health.max - plain.health.current;

  assert.equal(vsArmored.result.events.length, 1, "the armoured target must be hit at all");
  assert.equal(vsPlain.result.events.length, 1, "the control target must be hit at all");
  assert.ok(plainDamage > 0, "the control target must actually take damage");
  assert.ok(
    armoredDamage < plainDamage,
    `armour must reduce damage: ${armoredDamage} should be below ${plainDamage}`
  );
  assert.ok(
    Math.abs(armoredDamage / plainDamage - TAG_RULES.armored.damageIn) < 1e-9,
    "the reduction must be exactly the tag's damageIn multiplier"
  );
});

test("an ability's declared effect lands on everything it hits", () => {
  const slow = { id: "test.slow", name: "slow", durationTicks: 120, maxStacks: 1, moveSpeed: 0.5 };
  const ability = { ...MELEE, appliesBuff: { buffId: "test.slow" } };
  const target = fighter(2, { faction: "blue", transform: TARGET_AT });

  resolveFirstHit(fighter(1), ability, target, catalogOf(slow));

  assert.ok(target.buffs, "the effect must have been applied");
  assert.equal(target.buffs.length, 1);
  assert.equal(target.buffs[0].id, "test.slow");
  assert.equal(target.buffs[0].ticksLeft, 120);
  assert.equal(target.buffs[0].sourceId, 1, "the effect must record who applied it");
});

test("a killing blow does not leave a lasting effect on the corpse", () => {
  // A dead target is removed this tick, so a buff placed on it would be garbage that
  // outlives its owner for exactly one tick — and, worse, would make the removal order
  // observable.
  const slow = { id: "test.slow", name: "slow", durationTicks: 120, maxStacks: 1, moveSpeed: 0.5 };
  const ability = { ...MELEE, damage: 9999, appliesBuff: { buffId: "test.slow" } };
  const target = fighter(2, { faction: "blue", transform: TARGET_AT });

  const { result } = resolveFirstHit(fighter(1), ability, target, catalogOf(slow));

  assert.equal(result.events[0].killed, true);
  assert.equal(target.health.dead, true);
  assert.equal(target.buffs, undefined, "a corpse must not carry an effect");
});

test("an ability naming a buff nobody defines still deals its damage", () => {
  // The partial-failure case. `modifiersOf` skips unknown ids on purpose, so the attack
  // works and only the effect is missing. `validateContent` is what reports it.
  const ability = { ...MELEE, appliesBuff: { buffId: "test.missing" } };
  const target = fighter(2, { faction: "blue", transform: TARGET_AT });

  const { result } = resolveFirstHit(fighter(1), ability, target, NO_BUFFS);

  assert.equal(result.events.length, 1);
  assert.ok(target.health.current < target.health.max, "damage must still be applied");
  assert.equal(target.buffs, undefined);
});

test("an attack-rate effect scales a phase once, not twice", () => {
  // Scaling the countdown as well as the phase length would square the rate: a 2x haste
  // would become 4x. That bug is invisible in a screenshot and invisible in a damage total
  // — it only shows up as a cadence that is twice as fast as the number says.
  const haste = { id: "test.haste", name: "haste", durationTicks: 100000, maxStacks: 1, attackRate: 2 };
  const catalog = catalogOf(haste);

  function measureGap(buffList, cat) {
    const self = fighter(1, { buffs: buffList });
    const target = fighter(2, { faction: "blue", transform: TARGET_AT });
    const candidates = [self, target];
    const hits = [];
    for (let tick = 1; tick <= 200 && hits.length < 2; tick += 1) {
      const result = stepCombat(self, MELEE, target, candidates, tick, cat);
      if (result.events.length > 0) {
        hits.push(tick);
      }
    }
    return hits.length === 2 ? hits[1] - hits[0] : -1;
  }

  // Baseline cadence is windup 20 + active 1 + cooldown 20 = 41 ticks.
  const baseline = measureGap([], NO_BUFFS);
  assert.equal(baseline, 41, `baseline cadence must be the sum of the phases, got ${baseline}`);

  // At 2x: 10 + 0.5 + 10, which resolves as 21 ticks. Squared (4x) would be 11.
  const hasted = measureGap([{ id: "test.haste", sourceId: 1, ticksLeft: 100000, stacks: 1 }], catalog);
  assert.equal(hasted, 21, `a 2x haste must halve the cycle to 21 ticks, got ${hasted}`);
});

// ---------------------------------------------------------------------------
// Shipped content and determinism
// ---------------------------------------------------------------------------

test("the shipped library attaches at least one effect to an ability", () => {
  const applying = ABILITY_LIBRARY.filter((a) => a.spec.appliesBuff !== undefined);
  assert.ok(applying.length > 0, "the buff system must be reachable by starting a battle");

  const known = new Set(BUFF_LIBRARY.map((b) => b.id));
  for (const ability of applying) {
    assert.ok(
      known.has(ability.spec.appliesBuff.buffId),
      `ability ${ability.id} applies "${ability.spec.appliesBuff.buffId}", which the library does not define`
    );
  }
});

test("every shipped buff would have a visible effect", () => {
  for (const buff of BUFF_LIBRARY) {
    const changes =
      buff.moveSpeed !== undefined ||
      buff.damageOut !== undefined ||
      buff.damageIn !== undefined ||
      buff.attackRate !== undefined;
    assert.ok(changes, `buff ${buff.id} modifies no stat, so it would do nothing`);
    assert.ok(buff.durationTicks > 0, `buff ${buff.id} expires before it applies`);
    assert.ok(buff.maxStacks >= 1, `buff ${buff.id} can never reach one stack`);
  }
});

test("a shipped debuff actually lands during a real battle", () => {
  // The end-to-end form. Everything above can pass while the deployment forgets to pass
  // `buffs` into the setup, in which case the catalog is empty and no effect ever resolves.
  const sim = new Simulation(defaultMatchup(FIXED_STEP_MS));
  let sawSlow = false;
  let sawWither = false;

  for (let i = 0; i < 900 && !(sawSlow && sawWither); i += 1) {
    sim.step();
    for (const e of sim.snapshot().entities) {
      for (const buff of e.buffs ?? []) {
        if (buff.id === "buff.slow") sawSlow = true;
        if (buff.id === "buff.wither") sawWither = true;
      }
    }
  }

  assert.ok(sawSlow, "the hexer's slow must reach somebody in a default matchup");
  assert.ok(sawWither, "the shrieker's wither must reach somebody in a default matchup");
});

test("a battle with effects in play replays identically from the same seed", () => {
  // Per-entity mutable state — stack counts and countdowns — is the classic way a replay
  // starts diverging, and the divergence shows up hundreds of ticks after its cause.
  const a = new Simulation(defaultMatchup(FIXED_STEP_MS));
  const b = new Simulation(defaultMatchup(FIXED_STEP_MS));

  // "Ever saw an effect", not "has an effect at the end". A default matchup resolves in
  // under 500 ticks and every effect is gone by the time the dust settles, so sampling the
  // final state would pass this test with the whole system switched off.
  let sawEffects = false;

  for (let i = 0; i < 900; i += 1) {
    a.step();
    b.step();

    const ea = a.snapshot().entities;
    const eb = b.snapshot().entities;
    assert.equal(ea.length, eb.length, `entity count diverged on tick ${i + 1}`);

    for (let j = 0; j < ea.length; j += 1) {
      assert.equal(ea[j].id, eb[j].id, `entity order diverged on tick ${i + 1}`);
      assert.equal(
        ea[j].health.current,
        eb[j].health.current,
        `entity ${ea[j].id} health diverged on tick ${i + 1}`
      );
      const ba = (ea[j].buffs ?? []).map((x) => [x.id, x.stacks, x.ticksLeft]);
      const bb = (eb[j].buffs ?? []).map((x) => [x.id, x.stacks, x.ticksLeft]);
      assert.deepEqual(ba, bb, `entity ${ea[j].id} buff state diverged on tick ${i + 1}`);
      if (ba.length > 0) {
        sawEffects = true;
      }
    }
  }

  assert.ok(sawEffects, "the run must actually have had effects live, or it proves nothing");
});

test("a slow really slows a unit down on the field", () => {
  // The last link in the chain: `modifiersOf` is read by the movement AI, so a slow has to
  // change how far a unit travels, not only what a number says.
  function travelDistance(withSlow) {
    const setup = {
      seed: 5,
      fixedStepMs: FIXED_STEP_MS,
      bounds: { width: 1200, height: 400 },
      abilities: abilitySpecs(),
      buffs: buffSpecs(),
      characters: combatProfiles(),
      spawns: [
        {
          kind: "unit",
          faction: "red",
          x: 100,
          y: 200,
          radius: 13,
          mass: 1.1,
          hp: 500,
          facing: 0,
          characterId: "red.blade",
          ...(withSlow
            ? { buffs: [{ id: "buff.slow", sourceId: 999, ticksLeft: 600, stacks: 1 }] }
            : {})
        },
        {
          kind: "unit",
          faction: "blue",
          x: 1100,
          y: 200,
          radius: 13,
          mass: 1.1,
          hp: 500,
          facing: Math.PI,
          characterId: "blue.shrieker"
        }
      ]
    };

    const sim = new Simulation(setup);
    for (let i = 0; i < 120; i += 1) {
      sim.step();
    }
    const mover = sim.snapshot().entities.find((e) => e.faction === "red");
    return mover.transform.position.x - 100;
  }

  const free = travelDistance(false);
  const slowed = travelDistance(true);

  assert.ok(free > 0, "the control unit must actually advance");
  assert.ok(
    slowed < free,
    `a slow must reduce distance travelled: ${slowed} should be below ${free}`
  );
});
