import type { AbilitySpec } from "../simulation/types.ts";

/**
 * Content definitions. JSON is the source of truth at runtime; these interfaces are the
 * contract the loader validates against.
 *
 * Honest boundary: a NEW character or prop that only reuses existing abilities can be
 * added as data. A genuinely new mechanic (a new geometry, a new trigger) still requires
 * extending the systems.
 */

/**
 * Ability as authored in the content library.
 *
 * `spec` is the same structure the simulation consumes, so there is exactly one shape to
 * keep in sync rather than a content schema that drifts from the runtime contract.
 */
export interface AbilityDef {
  readonly id: string;
  readonly name: string;
  readonly spec: AbilitySpec;
}

export interface CharacterDef {
  readonly id: string;
  readonly name: string;
  /**
   * Ability rotation, in order. The combat system walks this list and loops, so a
   * character's attack pattern is pure data.
   */
  readonly abilityIds: readonly string[];
  /** Display-only in the MVP. It participates in no budget, purchase or economy loop. */
  readonly cost: number;
  readonly appearance: string;
  /** Baseline stats. Kept here so a new unit is a config change, not a code change. */
  readonly radius: number;
  readonly mass: number;
  readonly hp: number;
  /** Movement speed in world units per second while closing on a target. */
  readonly speed: number;
  /** How far this character looks for something to attack. */
  readonly aggroRange: number;
}

export interface PropDef {
  readonly id: string;
  readonly name: string;
  /** Reuses the same trigger/effect vocabulary as characters. */
  readonly trigger: "aura" | "conveyor" | "spring" | "explosive" | "spike" | "turret" | "shrine";
  readonly appearance: string;
}

export interface ContentLibrary {
  readonly characters: readonly CharacterDef[];
  readonly abilities: readonly AbilityDef[];
  readonly props: readonly PropDef[];
}
