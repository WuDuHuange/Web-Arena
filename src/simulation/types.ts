/**
 * Domain vocabulary shared across the simulation core.
 *
 * Nothing in this file may reference the DOM, React, PixiJS or audio. The core is
 * expected to run head-less, including inside `node --test`.
 */

export type EntityId = number;

export type Faction = "red" | "blue" | "neutral";

export type EntityKind = "unit" | "prop" | "projectile";

export interface MutableVec2 {
  x: number;
  y: number;
}

/**
 * Placement in continuous world units. Deliberately abstract: never screen pixels,
 * so zoom, window size and DPI cannot change collision results.
 */
export interface Transform {
  position: MutableVec2;
}

/** Linear motion intent. The physics adapter is the only writer of resolved values. */
export interface Motion {
  velocity: MutableVec2;
}

/** Hard-body footprint. Kept independent from the sprite size on purpose. */
export interface Collider {
  radius: number;
  mass: number;
  /** Static bodies never move but still block. */
  fixed: boolean;
}

export interface Health {
  current: number;
  max: number;
}

export interface RenderRef {
  /** Appearance key resolved by the renderer. The core never loads assets. */
  appearance: string;
}

/**
 * Composition over inheritance: every entity carries the same small set of
 * components and differs by data, not by class.
 */
export interface Entity {
  id: EntityId;
  kind: EntityKind;
  faction: Faction;
  /** Declarative tags. A capability system decides what each tag actually means. */
  tags: readonly string[];
  transform: Transform;
  motion: Motion;
  collider: Collider;
  health: Health;
  render: RenderRef;
}

/** Read-only projection of the world, safe to hand to the renderer or diagnostics. */
export interface WorldSnapshot {
  readonly tick: number;
  readonly entities: readonly Entity[];
}

/** One placement entry of a deployment. */
export interface SpawnDef {
  readonly kind: EntityKind;
  readonly faction: Faction;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly mass: number;
  readonly hp: number;
  /** Initial linear velocity, in world units per second. */
  readonly vx?: number;
  readonly vy?: number;
  readonly tags?: readonly string[];
  readonly appearance?: string;
}

/** Immutable starting point of a battle. Resetting restores exactly this. */
export interface BattleSetup {
  readonly seed: number;
  /** Authoritative step length in milliseconds. Render rate never feeds back into it. */
  readonly fixedStepMs: number;
  readonly bounds: { readonly width: number; readonly height: number };
  readonly spawns: readonly SpawnDef[];
}
