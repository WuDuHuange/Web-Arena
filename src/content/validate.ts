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
 * ability's library id and its embedded spec id, and characters that would fight with no
 * abilities at all.
 *
 * The last one is the subtle one. A character with an empty or unresolvable rotation
 * loads fine and then simply never attacks, which in a battle looks like a unit that is
 * broken in a way nobody can point at.
 */
export function validateContent(library: ContentLibrary): ValidationResult {
  const issues: ValidationIssue[] = [];

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
