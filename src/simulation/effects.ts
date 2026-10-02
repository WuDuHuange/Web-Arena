import type { BuffInstance, BuffSpec, Entity, EntityId } from "./types.ts";

export type { BuffInstance, BuffSpec };

/**
 * Tags and timed effects.
 *
 * The architecture baseline splits these deliberately, and the split is the whole design:
 *
 *  - A **tag** is a declaration. `flying` does not mean anything by itself; the table below
 *    is the capability system that decides what it means. That is what stops a tag from
 *    quietly becoming "ignores everything" — its effects are enumerated in one place.
 *  - A **buff** is an effect with a lifetime. Source, duration, stacking, refresh and
 *    exclusivity are handled here, once, rather than in each character's own logic. A
 *    character that has to remember to clean up its own slow effect is a character with a
 *    leak.
 *
 * Everything is tick-driven, like the rest of the core. A buff that lasts 180 ticks lasts
 * three seconds at 60 Hz and still lasts three seconds when the frame rate collapses.
 */

/** A multiplier set layered on top of an entity's base stats. */
export interface StatModifier {
  readonly moveSpeed: number;
  /** Multiplier on damage this entity deals. */
  readonly damageOut: number;
  /** Multiplier on damage this entity takes. */
  readonly damageIn: number;
  /** Multiplier on attack cadence. Above 1 means faster. */
  readonly attackRate: number;
}

export const NEUTRAL_MODIFIER: StatModifier = {
  moveSpeed: 1,
  damageOut: 1,
  damageIn: 1,
  attackRate: 1
};

/**
 * What a tag means.
 *
 * Only the tags listed here do anything. An unrecognised tag is inert rather than an
 * error, so content can carry descriptive labels without the simulation guessing at them.
 */
export interface TagRule {
  readonly moveSpeed?: number;
  readonly damageOut?: number;
  readonly damageIn?: number;
  readonly attackRate?: number;
  /**
   * Ground-level hazards — lava, belts, spikes, springs — do not affect this entity.
   *
   * Deliberately narrow. A flying unit still collides with walls and still gets shot;
   * "flying" is not "immune". Anything wider has to be argued for explicitly.
   */
  readonly ignoresGroundHazards?: boolean;
}

export const TAG_RULES: Readonly<Record<string, TagRule>> = {
  flying: { ignoresGroundHazards: true },
  // Heavier armour moves slower. The trade has to cut both ways or the tag is free.
  armored: { moveSpeed: 0.85, damageIn: 0.6 },
  // Hitting harder while taking more: a glass cannon, not an upgrade.
  frenzied: { damageOut: 1.4, damageIn: 1.15 }
};

/** Resolves a buff id to its definition. A function rather than a Map so it stays pure. */
export type BuffCatalog = (id: string) => BuffSpec | undefined;

/**
 * Modifiers combine as additive deltas from 1, then clamp.
 *
 * Multiplicative stacking was the obvious alternative and is the wrong one: three stacks
 * of a −50% slow would multiply to 0.125 and a fourth would effectively freeze the unit.
 * Additive deltas keep the second stack as meaningful as the first.
 */
const MIN_MODIFIER = 0.15;
const MAX_MODIFIER = 4;

function clampModifier(value: number): number {
  return value < MIN_MODIFIER ? MIN_MODIFIER : value > MAX_MODIFIER ? MAX_MODIFIER : value;
}

/** True when any tag on this entity carries the given rule. */
export function hasTag(entity: Entity, tag: string): boolean {
  return entity.tags.includes(tag);
}

/** Whether ground hazards pass this entity by. */
export function ignoresGroundHazards(entity: Entity): boolean {
  for (const tag of entity.tags) {
    if (TAG_RULES[tag]?.ignoresGroundHazards === true) {
      return true;
    }
  }
  return false;
}

/**
 * Aggregates every tag and buff into one multiplier set.
 *
 * Fast-paths the common case: most entities carry neither, and this runs several times per
 * entity per tick.
 */
export function modifiersOf(entity: Entity, catalog: BuffCatalog): StatModifier {
  const buffs = entity.buffs;
  if (entity.tags.length === 0 && (!buffs || buffs.length === 0)) {
    return NEUTRAL_MODIFIER;
  }

  let moveSpeed = 1;
  let damageOut = 1;
  let damageIn = 1;
  let attackRate = 1;

  const applyRule = (rule: TagRule, weight: number): void => {
    if (rule.moveSpeed !== undefined) {
      moveSpeed += (rule.moveSpeed - 1) * weight;
    }
    if (rule.damageOut !== undefined) {
      damageOut += (rule.damageOut - 1) * weight;
    }
    if (rule.damageIn !== undefined) {
      damageIn += (rule.damageIn - 1) * weight;
    }
    if (rule.attackRate !== undefined) {
      attackRate += (rule.attackRate - 1) * weight;
    }
  };

  for (const tag of entity.tags) {
    const rule = TAG_RULES[tag];
    if (rule) {
      applyRule(rule, 1);
    }
  }

  for (const buff of buffs ?? []) {
    const spec = catalog(buff.id);
    if (!spec) {
      continue;
    }
    applyRule(spec, buff.stacks);
  }

  return {
    moveSpeed: clampModifier(moveSpeed),
    damageOut: clampModifier(damageOut),
    damageIn: clampModifier(damageIn),
    attackRate: clampModifier(attackRate)
  };
}

/**
 * Applies a buff, or refreshes and stacks it if already present.
 *
 * A re-application refreshes the full duration rather than adding to it. Extending a
 * duration without bound lets a fast attacker keep a permanent slow on a target it is
 * already beating, which turns a tempo effect into a lock.
 */
export function applyBuff(target: Entity, spec: BuffSpec, sourceId: EntityId): void {
  if (spec.excludes && spec.excludes.length > 0 && target.buffs) {
    const excluded = new Set(spec.excludes);
    target.buffs = target.buffs.filter((buff) => !excluded.has(buff.id));
  }

  if (!target.buffs) {
    target.buffs = [];
  }
  const list = target.buffs;

  const existing = list.find((buff) => buff.id === spec.id);
  if (existing) {
    existing.ticksLeft = spec.durationTicks;
    existing.stacks = Math.min(existing.stacks + 1, Math.max(spec.maxStacks, 1));
    return;
  }

  list.push({
    id: spec.id,
    sourceId,
    ticksLeft: spec.durationTicks,
    stacks: 1
  });
}

/**
 * Advances every buff by one tick and drops the expired ones.
 *
 * Iterates backwards so removal does not shift the entries still to be visited — the
 * classic splice-during-forward-iteration bug, which here would leave a buff alive
 * forever on exactly the entities that have several.
 */
export function stepBuffs(entities: readonly Entity[]): void {
  for (const entity of entities) {
    const buffs = entity.buffs;
    if (!buffs || buffs.length === 0) {
      continue;
    }
    for (let i = buffs.length - 1; i >= 0; i -= 1) {
      const buff = buffs[i];
      if (!buff) {
        continue;
      }
      buff.ticksLeft -= 1;
      if (buff.ticksLeft <= 0) {
        buffs.splice(i, 1);
      }
    }
  }
}
