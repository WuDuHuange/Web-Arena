/**
 * Content definitions. JSON is the source of truth at runtime; these interfaces are
 * the contract the loader validates against.
 *
 * Honest boundary: a NEW character or prop that only reuses existing abilities can be
 * added as data. A genuinely new mechanic still requires extending the systems.
 */

export interface AbilityDef {
  readonly id: string;
  readonly name: string;
  /** Hit-shape family. Concrete geometry is a later milestone. */
  readonly shape: "melee" | "cone" | "line" | "circle";
}

export interface CharacterDef {
  readonly id: string;
  readonly name: string;
  /** References into the ability library. Must resolve, or the content is rejected. */
  readonly abilityIds: readonly string[];
  /** Display-only in the MVP. It participates in no budget, purchase or economy loop. */
  readonly cost: number;
  readonly appearance: string;
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
