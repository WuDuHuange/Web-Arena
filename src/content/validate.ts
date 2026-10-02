import type { ContentLibrary } from "./schema.ts";

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

export interface ValidationResult {
  readonly ok: boolean;
  readonly issues: readonly ValidationIssue[];
}

/**
 * Validates a content library BEFORE a battle starts, so structural mistakes surface
 * as a clear message instead of a runtime failure mid-fight.
 *
 * Enforced: duplicate and empty ids, dangling ability references, a mismatch between an
 * ability's library id and its embedded spec id, characters that would fight with no
 * abilities at all, and effects that are unreachable or that would silently do nothing.
 *
 * The last of those is the theme. A character with an empty or unresolvable rotation loads
 * fine and then simply never attacks. An ability whose `appliesBuff` names a buff that is
 * not in the library resolves to nothing — `modifiersOf` skips unknown ids on purpose, so
 * the attack still deals damage and only the effect is missing. Both look like a unit that
 * is broken in a way nobody can point at, which is exactly what this function exists to
 * turn into a message.
 */
export function validateContent(library: ContentLibrary): ValidationResult {
  const issues: ValidationIssue[] = [];

  // Buffs are checked first: the ability pass below needs the full set of valid ids to
  // decide whether an `appliesBuff` reference dangles.
  const buffIds = new Set<string>();
  const buffs = library.buffs ?? [];
  for (const buff of buffs) {
    if (buff.id.length === 0) {
      issues.push({ path: "buffs", message: "buff id must not be empty" });
      continue;
    }
    if (buffIds.has(buff.id)) {
      issues.push({ path: `buffs.${buff.id}`, message: "duplicate buff id" });
      continue;
    }
    buffIds.add(buff.id);

    // A zero or negative duration is dropped by `stepBuffs` on the very first tick, so the
    // effect would never apply. It is not a crash, which is what makes it worth reporting.
    if (!(buff.durationTicks > 0)) {
      issues.push({
        path: `buffs.${buff.id}.durationTicks`,
        message: "durationTicks must be positive, or the effect expires before it applies"
      });
    }
    if (!(buff.maxStacks >= 1)) {
      issues.push({
        path: `buffs.${buff.id}.maxStacks`,
        message: "maxStacks must be at least 1"
      });
    }

    // A multiplier at or below zero is silently clamped to the floor in `modifiersOf`, so
    // the authored number and the simulated number would disagree with nothing to show for
    // it. Reported rather than clamped quietly.
    for (const key of ["moveSpeed", "damageOut", "damageIn", "attackRate"] as const) {
      const value = buff[key];
      if (value !== undefined && !(value > 0)) {
        issues.push({
          path: `buffs.${buff.id}.${key}`,
          message: `${key} must be positive; a multiplier is clamped to the floor rather than honoured`
        });
      }
    }

    // A buff that modifies nothing is a buff that does nothing. It costs a tick of bookkeeping
    // per entity per tick and produces no observable effect, which is worse than absent.
    const changesSomething =
      buff.moveSpeed !== undefined ||
      buff.damageOut !== undefined ||
      buff.damageIn !== undefined ||
      buff.attackRate !== undefined;
    if (!changesSomething) {
      issues.push({
        path: `buffs.${buff.id}`,
        message: "a buff that modifies no stat has no effect"
      });
    }
  }

  // Exclusivity is a cross-reference, so it can only be checked once every id is known.
  for (const buff of buffs) {
    for (const excluded of buff.excludes ?? []) {
      if (!buffIds.has(excluded)) {
        issues.push({
          path: `buffs.${buff.id}.excludes`,
          message: `dangling buff reference "${excluded}"`
        });
      }
      if (excluded === buff.id) {
        // `applyBuff` removes the exclusions and then re-adds this buff, so the net effect is
        // a refresh. It is not a crash and it is never what the author meant.
        issues.push({
          path: `buffs.${buff.id}.excludes`,
          message: "a buff must not exclude itself"
        });
      }
    }
  }

  const abilityIds = new Set<string>();
  for (const ability of library.abilities) {
    if (ability.id.length === 0) {
      issues.push({ path: "abilities", message: "ability id must not be empty" });
      continue;
    }
    if (abilityIds.has(ability.id)) {
      issues.push({ path: `abilities.${ability.id}`, message: "duplicate ability id" });
      continue;
    }
    abilityIds.add(ability.id);

    // The library key and the spec's own id must agree. When they drift, the ability
    // fights with whatever the spec says while diagnostics report the key, so a hit log
    // credits the wrong ability.
    if (ability.spec.id !== ability.id) {
      issues.push({
        path: `abilities.${ability.id}`,
        message: `spec.id "${ability.spec.id}" does not match library id`
      });
    }

    if (ability.spec.geometry.range < 0) {
      issues.push({
        path: `abilities.${ability.id}.geometry.range`,
        message: "range must not be negative"
      });
    }
    if (ability.spec.geometry.kind === "cone" && (ability.spec.geometry.halfAngle ?? 0) <= 0) {
      issues.push({
        path: `abilities.${ability.id}.geometry.halfAngle`,
        message: "a cone needs a positive halfAngle"
      });
    }
    if (ability.spec.maxTargets < 1) {
      issues.push({
        path: `abilities.${ability.id}.maxTargets`,
        message: "maxTargets must be at least 1"
      });
    }

    // An ability that names a buff nobody defines still hits and still deals its damage;
    // only the effect is missing. Silent partial failure, so it is a validation error.
    const applied = ability.spec.appliesBuff;
    if (applied && !buffIds.has(applied.buffId)) {
      issues.push({
        path: `abilities.${ability.id}.appliesBuff`,
        message: `dangling buff reference "${applied.buffId}"`
      });
    }
  }

  const characterIds = new Set<string>();
  for (const character of library.characters) {
    if (characterIds.has(character.id)) {
      issues.push({ path: `characters.${character.id}`, message: "duplicate character id" });
    } else {
      characterIds.add(character.id);
    }

    if (character.abilityIds.length === 0) {
      issues.push({
        path: `characters.${character.id}.abilityIds`,
        message: "a combatant needs at least one ability"
      });
    }

    for (const ref of character.abilityIds) {
      if (!abilityIds.has(ref)) {
        issues.push({
          path: `characters.${character.id}.abilityIds`,
          message: `dangling ability reference "${ref}"`
        });
      }
    }

    if (!(character.hp > 0)) {
      issues.push({ path: `characters.${character.id}.hp`, message: "hp must be positive" });
    }
    if (!(character.radius > 0)) {
      issues.push({ path: `characters.${character.id}.radius`, message: "radius must be positive" });
    }
    if (character.speed < 0) {
      issues.push({ path: `characters.${character.id}.speed`, message: "speed must not be negative" });
    }
    if (character.aggroRange <= 0) {
      issues.push({
        path: `characters.${character.id}.aggroRange`,
        message: "aggroRange must be positive, or the unit never acquires a target"
      });
    }
  }

  const propIds = new Set<string>();
  for (const prop of library.props) {
    if (propIds.has(prop.id)) {
      issues.push({ path: `props.${prop.id}`, message: "duplicate prop id" });
      continue;
    }
    propIds.add(prop.id);

    const behavior = prop.behavior;

    if (!(behavior.radius > 0)) {
      issues.push({ path: `props.${prop.id}.behavior.radius`, message: "radius must be positive" });
    }
    if (behavior.damage < 0) {
      issues.push({ path: `props.${prop.id}.behavior.damage`, message: "damage must not be negative" });
    }

    // A continuous source with damage but no interval deals its damage every single tick,
    // which is 60x the intended rate and turns lava into an instant kill.
    if (behavior.damage > 0 && behavior.kind === "aura" && behavior.intervalTicks <= 0) {
      issues.push({
        path: `props.${prop.id}.behavior.intervalTicks`,
        message: "a damaging aura needs a positive intervalTicks, or it deals damage every tick"
      });
    }
    if (behavior.intervalTicks < 0) {
      issues.push({
        path: `props.${prop.id}.behavior.intervalTicks`,
        message: "intervalTicks must not be negative"
      });
    }
    if (behavior.cooldownTicks < 0) {
      issues.push({
        path: `props.${prop.id}.behavior.cooldownTicks`,
        message: "cooldownTicks must not be negative"
      });
    }

    // A trigger with no reach reacts to nothing: it overlaps only its own body, so a unit
    // would have to be inside the prop's collider to set it off. That is possible but not
    // what "you stepped on it" means, so it is treated as an authoring mistake.
    if (behavior.kind === "spike" && behavior.reach <= 0) {
      issues.push({
        path: `props.${prop.id}.behavior.reach`,
        message: "a spike needs a positive reach, or nothing can ever trigger it"
      });
    }

    if (behavior.kind === "spring" && behavior.force <= 0) {
      issues.push({
        path: `props.${prop.id}.behavior.force`,
        message: "a spring with no force does nothing"
      });
    }

    if (behavior.kind === "explosive") {
      if (behavior.reach <= 0) {
        issues.push({
          path: `props.${prop.id}.behavior.reach`,
          message: "an explosive needs a positive reach to have a blast at all"
        });
      }
      // Chaining further than the blast itself cannot be triggered by this blast, so the
      // value is either a typo or dead data. Reported rather than silently ignored.
      if ((behavior.chainRadius ?? 0) > behavior.reach) {
        issues.push({
          path: `props.${prop.id}.behavior.chainRadius`,
          message: "chainRadius must not exceed reach, or a blast cannot trigger what it targets"
        });
      }
    }

    if (behavior.kind === "conveyor" && behavior.force <= 0) {
      issues.push({
        path: `props.${prop.id}.behavior.force`,
        message: "a conveyor with no force does not convey"
      });
    }

    if (behavior.kind === "turret" || behavior.kind === "shrine") {
      if (!(behavior.projectileSpeed ?? 0 > 0)) {
        issues.push({
          path: `props.${prop.id}.behavior.projectileSpeed`,
          message: "an emitter needs a positive projectileSpeed"
        });
      }
      if (behavior.reach <= 0) {
        issues.push({
          path: `props.${prop.id}.behavior.reach`,
          message: "an emitter with no reach never finds anything to shoot at"
        });
      }
      if (behavior.intervalTicks <= 0) {
        issues.push({
          path: `props.${prop.id}.behavior.intervalTicks`,
          message: "an emitter needs a positive intervalTicks to have a firing cadence"
        });
      }
      if (behavior.affects === "none") {
        issues.push({
          path: `props.${prop.id}.behavior.affects`,
          message: "an emitter that affects nothing fires for no reason"
        });
      }
    }
  }

  return { ok: issues.length === 0, issues };
}
