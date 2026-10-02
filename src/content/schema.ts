import type { AbilitySpec, PropBehavior } from "../simulation/types.ts";

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

/**
 * A field object.
 *
 * `behavior` is the same structure the simulation consumes, for the same reason
 * `AbilityDef.spec` is: one shape to keep in sync instead of two that drift.
 *
 * `appearance` is deliberately a free-form string with no relation to `behavior`. That
 * separation is what makes "swapping art must not change collision or damage" checkable
 * rather than aspirational: a test can hold `behavior` fixed and vary only this key.
 */
export interface PropDef {
  readonly id: string;
  readonly name: string;
  readonly behavior: PropBehavior;
  readonly appearance: string;
}

/** A prop as it is placed on the field. Position is deployment's business, not the catalog's. */
export interface PropPlacement {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  /** Overrides the catalog facing. Defaults to the prop definition's own. */
  readonly facing?: number;
}

export interface ContentLibrary {
  readonly characters: readonly CharacterDef[];
  readonly abilities: readonly AbilityDef[];
  readonly props: readonly PropDef[];
}
