import { hitsTarget } from "./geometry.ts";
import type { AbilitySpec, Combat, Entity } from "./types.ts";

/**
 * Ability cadence and damage resolution.
 *
 * Contract with the rest of the core:
 *  - This module owns the combat phase machine and health. Nothing else writes them.
 *  - It never reads or writes positions; geometry is tested against authoritative
 *    transform values the physics adapter already resolved for this tick.
 *  - No randomness is consumed here yet. When it is, it must come from the world's seeded
 *    RNG so a battle stays reproducible.
 *
 * The phase machine runs on ticks, never milliseconds:
 *
 *    windup --(activeTicks)--> active --(cooldownTicks)--> windup
 *
 * A frame-rate drop changes how many ticks run in a wall-clock second, but it can never
 * change the number of ticks an ability spends winding up.
 */

/** What a single damage application did, for diagnostics and tests. */
export interface DamageEvent {
  readonly attackerId: number;
  readonly targetId: number;
  readonly abilityId: string;
  readonly amount: number;
  /** True when this application reduced the target to zero. */
  readonly killed: boolean;
}

export interface CombatStepResult {
  readonly events: readonly DamageEvent[];
  /** Entities removed this tick because their health reached zero. */
  readonly removed: readonly number[];
}

/**
 * Total ticks one full attack cycle takes.
 *
 * Exposed so the AI can decide "am I in range *in time*" rather than only "am I in range
 * now", and so tests can compute expected cadence without duplicating the sum.
 */
export function cadenceTicks(ability: AbilitySpec): number {
  return Math.max(ability.windupTicks, 0) + Math.max(ability.activeTicks, 1) + Math.max(ability.cooldownTicks, 0);
}

/** Distance at which the caster should stop closing and start swinging. */
export function stopDistanceFor(ability: AbilitySpec): number {
  const geometry = ability.geometry;
  switch (geometry.kind) {
    case "melee":
      return geometry.range;
    case "cone":
      return geometry.range * 0.5;
    case "line":
      // A line wants to be lined up, not adjacent; half its reach reads as "at range".
      return geometry.range * 0.5;
    case "circle":
      return geometry.centredOnCaster ? geometry.range * 0.5 : geometry.range * 0.75;
  }
}

/** Picks the ability to use next, wrapping around the character's rotation. */
export function selectAbility(abilities: readonly AbilitySpec[], index: number): AbilitySpec | undefined {
  if (abilities.length === 0) {
    return undefined;
  }
  return abilities[index % abilities.length];
}

/**
 * Advances one entity's combat state by exactly one tick.
 *
 * Two things are deliberately NOT done here:
 *  - It does not choose a target. Targeting is the AI system's job, and the result is
 *    passed in, so this function stays a pure state transition over one entity.
 *  - It does not mutate anything except the caster's own combat phase and the targets'
 *    health.
 */
export function stepCombat(
  self: Entity,
  ability: AbilitySpec,
  target: Entity | undefined,
  candidates: readonly Entity[],
  tick: number
): CombatStepResult {
  const combat = self.combat;
  if (!combat || self.health.dead) {
    return { events: [], removed: [] };
  }

  combat.phaseTicksLeft -= 1;

  if (combat.phaseTicksLeft > 0) {
    return { events: [], removed: [] };
  }

  switch (combat.phase) {
    case "windup": {
      // The windup is over: the damaging frame begins now.
      combat.phase = "active";
      combat.phaseTicksLeft = Math.max(ability.activeTicks, 1);
      combat.applied = false;
      return { events: [], removed: [] };
    }

    case "active": {
      const events: DamageEvent[] = [];
      const removed: number[] = [];

      // Guard against a multi-tick active window applying damage repeatedly. Without
      // this, a 3-tick active frame deals triple damage and every balance number is a
      // lie.
      if (!combat.applied) {
        combat.applied = true;
        applyActiveFrame(self, ability, target, candidates, events, removed);
      }

      combat.phase = "cooldown";
      combat.phaseTicksLeft = Math.max(ability.cooldownTicks, 1);
      return { events, removed };
    }

    case "cooldown": {
      combat.phase = "windup";
      combat.phaseTicksLeft = Math.max(ability.windupTicks, 1);
      // Advance the rotation so the next swing can use the next ability.
      combat.abilityIndex += 1;
      void tick;
      return { events: [], removed: [] };
    }
  }
}

/** Resolves the damaging frame: who is inside the geometry, and for how much. */
function applyActiveFrame(
  self: Entity,
  ability: AbilitySpec,
  target: Entity | undefined,
  candidates: readonly Entity[],
  events: DamageEvent[],
  removed: number[]
): void {
  const origin = self.transform.position;
  const facing = self.transform.facing;
  const radius = self.collider.radius;

  // The aim point for a non-centred area effect is the current target's position. Falling
  // back to the caster's own position keeps the call total even when the target died mid
  // windup.
  const aim = ability.geometry.kind === "circle" && !ability.geometry.centredOnCaster
    ? (target?.transform.position ?? origin)
    : undefined;

  const maxTargets = Math.max(ability.maxTargets, 1);
  let hits = 0;

  for (const candidate of candidates) {
    if (hits >= maxTargets) {
      break;
    }
    if (candidate.id === self.id || candidate.health.dead) {
      continue;
    }
    if (candidate.faction === self.faction) {
      continue;
    }
    // Field objects are scenery, not combatants. A unit must not be able to destroy the
    // lava it is standing in, and an emitter lashed to a wall should not be killable by
    // the side it is shooting at. Mechanisms have their own removal rules (`spent`,
    // `consumed`); health is not one of them.
    if (candidate.behavior) {
      continue;
    }

    const inside = hitsTarget(
      ability.geometry,
      origin,
      radius,
      facing,
      {
        x: candidate.transform.position.x,
        y: candidate.transform.position.y,
        radius: candidate.collider.radius
      },
      aim
    );

    if (!inside) {
      continue;
    }

    hits += 1;
    const amount = Math.max(ability.damage, 0);
    candidate.health.current = Math.max(candidate.health.current - amount, 0);

    const killed = candidate.health.current === 0;
    if (killed) {
      candidate.health.dead = true;
      removed.push(candidate.id);
    }

    events.push({
      attackerId: self.id,
      targetId: candidate.id,
      abilityId: ability.id,
      amount,
      killed
    });
  }
}

/** Initialises the combat phase machine for a fresh entity. */
export function initialPhase(ability: AbilitySpec | undefined): { phase: Combat["phase"]; ticks: number } {
  // A fresh unit starts in windup so its first attack lands after a real telegraph rather
  // than instantly on tick 0.
  return { phase: "windup", ticks: Math.max(ability?.windupTicks ?? 1, 1) };
}
