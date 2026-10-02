import type { CharacterDef, ContentLibrary, PropDef } from "./schema.ts";
import type { AbilityDef } from "./schema.ts";
import type { BuffSpec } from "../simulation/types.ts";

/**
 * The Phase 2 content library.
 *
 * Eight characters, four archetypes per side. The archetypes exist to exercise each hit
 * geometry exactly once, so "does a cone actually hit a cone" is answerable by starting a
 * battle rather than by reading code:
 *
 *   blade   melee   - short forward reach, single target
 *   lancer  line    - reaches through a column of enemies
 *   caster  cone    - wide arc, hits everything in front
 *   bomber  circle  - area burst centred on the caster
 *
 * Blue mirrors red with the same four geometries and slightly different numbers, which is
 * what makes a mirror match read as asymmetric rather than random.
 *
 * Everything here is balance scaffolding, not tuned design: the numbers are chosen so a
 * battle resolves in tens of seconds and so each archetype's strengths are visible.
 *
 * Tags and buffs follow the same rule — the point is that each one is *observable* in a
 * battle. Three tags ship (`armored`, `frenzied`, `flying`) and two buffs (`slow`,
 * `wither`), each attached to content a player will actually meet. A capability table full
 * of entries nothing uses is a table nobody can tell is broken.
 */

/**
 * Display names for the tags in `TAG_RULES`.
 *
 * Tags are declared in the simulation core, where an English identifier is the right thing
 * — `flying` is read by code. This table is the presentation half, and it lives here
 * because the content layer already owns every other human-readable string in the game.
 *
 * The two are kept in step by a test, not by discipline: `the tag label table covers the
 * capability table exactly` fails if a rule is added without a label or vice versa. A
 * missing label would otherwise ship as a legend row reading `flying`.
 */
export const TAG_LABELS: Readonly<Record<string, string>> = {
  flying: "飞行",
  armored: "装甲",
  frenzied: "狂暴"
};

const bladeAbility: AbilityDef = {
  id: "ability.blade.strike",
  name: "斩击",
  spec: {
    id: "ability.blade.strike",
    name: "斩击",
    geometry: { kind: "melee", range: 18 },
    windupTicks: 18,
    activeTicks: 2,
    cooldownTicks: 26,
    damage: 14,
    maxTargets: 1,
    turnToTarget: 1
  }
};

const lancerAbility: AbilityDef = {
  id: "ability.lancer.thrust",
  name: "突刺",
  spec: {
    id: "ability.lancer.thrust",
    name: "突刺",
    // A long thin line: punishing in a corridor, easy to sidestep in the open.
    geometry: { kind: "line", range: 150, width: 16 },
    windupTicks: 26,
    activeTicks: 2,
    cooldownTicks: 44,
    damage: 20,
    // Hits a whole column, which is the whole point of a piercing attack.
    maxTargets: 8,
    turnToTarget: 1
  }
};

const casterAbility: AbilityDef = {
  id: "ability.caster.sweep",
  name: "横扫",
  spec: {
    id: "ability.caster.sweep",
    name: "横扫",
    // 60 degrees either side: forgiving, but each individual hit is weaker.
    geometry: { kind: "cone", range: 94, halfAngle: Math.PI / 3 },
    windupTicks: 24,
    activeTicks: 3,
    cooldownTicks: 40,
    damage: 11,
    maxTargets: 8,
    turnToTarget: 1
  }
};

const bomberAbility: AbilityDef = {
  id: "ability.bomber.burst",
  name: "爆裂",
  spec: {
    id: "ability.bomber.burst",
    name: "爆裂",
    // Centred on the caster, so a bomber must walk into the crowd to be effective.
    geometry: { kind: "circle", range: 76, centredOnCaster: true },
    windupTicks: 40,
    activeTicks: 2,
    cooldownTicks: 52,
    damage: 17,
    maxTargets: 12,
    // The slowest turn of the four: a committed AoE should not track a moving target.
    turnToTarget: 0.5
  }
};

const skirmisherAbility: AbilityDef = {
  id: "ability.skirmisher.flurry",
  name: "乱击",
  spec: {
    id: "ability.skirmisher.flurry",
    name: "乱击",
    // Fast cycle, low damage: wins by attacking often rather than by hitting hard.
    geometry: { kind: "melee", range: 16 },
    windupTicks: 10,
    activeTicks: 1,
    cooldownTicks: 14,
    damage: 7,
    maxTargets: 1,
    turnToTarget: 1
  }
};

const hexerAbility: AbilityDef = {
  id: "ability.hexer.lance",
  name: "咒枪",
  spec: {
    id: "ability.hexer.lance",
    name: "咒枪",
    geometry: { kind: "line", range: 180, width: 12 },
    windupTicks: 34,
    activeTicks: 2,
    cooldownTicks: 58,
    damage: 26,
    maxTargets: 6,
    turnToTarget: 1,
    // The hex is the point of the hexer: highest damage in the library *and* a slow. It
    // pays for that with a 34-tick windup on a 12-unit-wide line, so the slow only lands
    // when the shot was already aimed well.
    appliesBuff: { buffId: "buff.slow" }
  }
};

const shriekerAbility: AbilityDef = {
  id: "ability.shrieker.wail",
  name: "尖啸",
  spec: {
    id: "ability.shrieker.wail",
    name: "尖啸",
    geometry: { kind: "cone", range: 120, halfAngle: Math.PI / 2.6 },
    windupTicks: 30,
    activeTicks: 3,
    cooldownTicks: 50,
    damage: 13,
    maxTargets: 10,
    turnToTarget: 1,
    // A cone hits up to ten entities, so this is the widest debuff application in the
    // library. Its damage is low precisely because the wither is the payload.
    appliesBuff: { buffId: "buff.wither" }
  }
};

const runeAbility: AbilityDef = {
  id: "ability.rune.sigil",
  name: "符文",
  spec: {
    id: "ability.rune.sigil",
    name: "符文",
    // Aimed rather than self-centred: reaches the enemy line without walking into it.
    geometry: { kind: "circle", range: 64, centredOnCaster: false },
    windupTicks: 44,
    activeTicks: 2,
    cooldownTicks: 60,
    damage: 19,
    maxTargets: 12,
    turnToTarget: 1
  }
};

export const ABILITY_LIBRARY: readonly AbilityDef[] = [
  bladeAbility,
  lancerAbility,
  casterAbility,
  bomberAbility,
  skirmisherAbility,
  hexerAbility,
  shriekerAbility,
  runeAbility
];

export const CHARACTER_LIBRARY: readonly CharacterDef[] = [
  // --- Red ---------------------------------------------------------------
  {
    id: "red.blade",
    name: "赤刃",
    abilityIds: ["ability.blade.strike"],
    cost: 2,
    appearance: "red-blade",
    radius: 13,
    mass: 1.1,
    hp: 90,
    speed: 96,
    aggroRange: 420
  },
  {
    id: "red.lancer",
    name: "赤枪",
    abilityIds: ["ability.lancer.thrust"],
    cost: 3,
    appearance: "red-lancer",
    radius: 13,
    mass: 1.2,
    hp: 80,
    speed: 82,
    aggroRange: 460
  },
  {
    id: "red.caster",
    name: "赤术",
    abilityIds: ["ability.caster.sweep"],
    cost: 3,
    appearance: "red-caster",
    radius: 12,
    mass: 0.9,
    hp: 70,
    speed: 88,
    aggroRange: 430
  },
  {
    id: "red.bomber",
    name: "赤爆",
    abilityIds: ["ability.bomber.burst"],
    cost: 4,
    appearance: "red-bomber",
    radius: 15,
    mass: 1.8,
    hp: 120,
    speed: 72,
    aggroRange: 400,
    // The heaviest body on the field, and the only one that shrugs off damage. `armored`
    // costs it 15% of its speed, so it is genuinely a trade rather than a free upgrade:
    // 72 u/s becomes 61.2, which is slow enough that it can be kited by everything.
    tags: ["armored"]
  },

  // --- Blue --------------------------------------------------------------
  {
    id: "blue.skirmisher",
    name: "苍锋",
    abilityIds: ["ability.skirmisher.flurry"],
    cost: 2,
    appearance: "blue-skirmisher",
    radius: 12,
    mass: 0.9,
    hp: 76,
    speed: 108,
    aggroRange: 420,
    // Glass cannon: +40% damage dealt, +15% damage taken, on the lowest hp in the library.
    // It has to win the exchange quickly or not at all.
    tags: ["frenzied"]
  },
  {
    id: "blue.hexer",
    name: "苍咒",
    abilityIds: ["ability.hexer.lance"],
    cost: 3,
    appearance: "blue-hexer",
    radius: 12,
    mass: 0.95,
    hp: 68,
    speed: 84,
    aggroRange: 500
  },
  {
    id: "blue.shrieker",
    name: "苍啸",
    abilityIds: ["ability.shrieker.wail"],
    cost: 3,
    appearance: "blue-shrieker",
    radius: 13,
    mass: 1,
    hp: 78,
    speed: 86,
    aggroRange: 450
  },
  {
    id: "blue.rune",
    name: "苍印",
    abilityIds: ["ability.rune.sigil"],
    cost: 4,
    appearance: "blue-rune",
    radius: 13,
    mass: 1.05,
    hp: 84,
    speed: 78,
    aggroRange: 470,
    // A sigil hovers, so lava, belts, spikes and springs pass underneath it. Deliberately
    // narrow: it still collides with walls, still eats barrel blasts and is still shot at.
    // The compensation is that it is the slowest unit blue fields.
    tags: ["flying"]
  }
];

/**
 * Field objects.
 *
 * Balance scaffolding, same as the characters: the numbers are chosen so each mechanism's
 * behaviour is *visible* in a few seconds of watching, not so they are fair. A test that
 * has to run 3000 ticks to see a spike go off is a test nobody will trust.
 *
 * `appearance` carries no behaviour. It exists so the renderer — and a future asset
 * pipeline — can change what a mechanism looks like without touching what it does.
 */
export const PROP_LIBRARY: readonly PropDef[] = [
  {
    id: "prop.lava",
    name: "熔岩",
    appearance: "prop-lava",
    behavior: {
      kind: "aura",
      radius: 54,
      // 6 damage every 30 ticks: one second of standing in it costs 6, and the interval
      // is what keeps a 60 Hz tick from turning that into 360.
      damage: 6,
      intervalTicks: 30,
      cooldownTicks: 0,
      force: 0,
      reach: 0,
      affects: "all"
    }
  },
  {
    id: "prop.conveyor",
    name: "传送带",
    appearance: "prop-conveyor",
    behavior: {
      kind: "conveyor",
      radius: 70,
      damage: 0,
      intervalTicks: 0,
      cooldownTicks: 0,
      // Applied as a velocity overlay every tick, so it moves a unit regardless of what
      // the unit is trying to do — that is what makes it a terrain feature rather than a
      // suggestion the AI can outvote.
      force: 84,
      reach: 0,
      affects: "all"
    }
  },
  {
    id: "prop.spring",
    name: "弹簧板",
    appearance: "prop-spring",
    behavior: {
      kind: "spring",
      radius: 26,
      damage: 0,
      intervalTicks: 0,
      // Short cooldown: a spring that fires once per second reads as a trap, not a launcher.
      cooldownTicks: 45,
      force: 320,
      reach: 26,
      affects: "all"
    }
  },
  {
    id: "prop.barrel",
    name: "炸药桶",
    appearance: "prop-barrel",
    behavior: {
      kind: "explosive",
      radius: 22,
      damage: 34,
      intervalTicks: 0,
      cooldownTicks: 0,
      force: 260,
      reach: 96,
      // Chain radius is smaller than the blast radius on purpose: two barrels at the edge
      // of the same blast should not reliably set each other off, or a dense cluster
      // becomes a single unavoidable wipe.
      chainRadius: 78,
      affects: "all"
    }
  },
  {
    id: "prop.spike",
    name: "地刺",
    appearance: "prop-spike",
    behavior: {
      kind: "spike",
      radius: 30,
      damage: 16,
      intervalTicks: 0,
      // Fires on entry, then stays down for about a second and a half. Long enough that a
      // unit standing on it is not shredded, short enough that it still matters.
      cooldownTicks: 90,
      force: 0,
      reach: 30,
      affects: "all"
    }
  },
  {
    id: "prop.turret",
    name: "炮台",
    appearance: "prop-turret",
    behavior: {
      kind: "turret",
      radius: 24,
      damage: 9,
      intervalTicks: 70,
      cooldownTicks: 0,
      force: 0,
      reach: 240,
      projectileSpeed: 300,
      affects: "hostile"
    }
  },
  {
    id: "prop.shrine",
    name: "祭坛",
    appearance: "prop-shrine",
    behavior: {
      kind: "shrine",
      radius: 34,
      damage: 13,
      intervalTicks: 110,
      cooldownTicks: 0,
      force: 0,
      reach: 200,
      projectileSpeed: 190,
      affects: "hostile"
    }
  }
];

/**
 * Timed effects.
 *
 * Two buffs, both attached to an ability, so both are reachable by starting a battle. The
 * numbers are multipliers relative to 1 and they stack *additively* — see `modifiersOf`
 * for why: three stacks of a −50% slow multiplied together would be 0.125, which is not a
 * slow, it is a root.
 *
 * `excludes` is deliberately unexercised here. Mutual exclusion matters for a buff system
 * (slow versus haste is the obvious pair) but neither of these two has an opposite yet,
 * and inventing an opposite just to fill the field in would be content written to satisfy
 * a type rather than a player. The field is covered by tests instead.
 */
export const BUFF_LIBRARY: readonly BuffSpec[] = [
  {
    id: "buff.slow",
    name: "迟滞",
    // 2.5 seconds at 60 Hz. Long enough to matter in a fight that resolves in tens of
    // seconds, short enough that it reads as a tempo swing rather than a disable.
    durationTicks: 150,
    // A single stack: this is a −45% slow, and letting it reach −90% would make the hexer
    // the only unit worth fielding. Re-application refreshes the timer instead.
    maxStacks: 1,
    moveSpeed: 0.55
  },
  {
    id: "buff.wither",
    name: "蚀弱",
    durationTicks: 180,
    // Two stacks, and this is where the additive rule earns its keep: 0.8 alone is −20%
    // damage, two stacks is −40%. Multiplicative would give −36%, close enough to be
    // confusing; additive makes the second stack exactly as strong as the first.
    maxStacks: 2,
    damageOut: 0.8
  }
];

export const CONTENT_LIBRARY: ContentLibrary = {
  characters: CHARACTER_LIBRARY,
  abilities: ABILITY_LIBRARY,
  props: PROP_LIBRARY,
  buffs: BUFF_LIBRARY
};

/** Looks up a character definition by id. */
export function findCharacter(id: string): CharacterDef | undefined {
  return CHARACTER_LIBRARY.find((c) => c.id === id);
}

/** Looks up a prop definition by id. */
export function findProp(id: string): PropDef | undefined {
  return PROP_LIBRARY.find((p) => p.id === id);
}
