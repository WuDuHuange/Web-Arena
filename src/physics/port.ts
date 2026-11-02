/**
 * The slice of the simulation that the physics layer is allowed to see.
 *
 * `Entity` also carries `health`, `combat`, `buffs`, `behavior` and `mechanism`. None of
 * that is the solver's business, and today the adapter simply happens not to read it --
 * which is a weaker guarantee than it looks. One autocomplete on `entity.` is enough to
 * let a damage rule leak into collision code, and that leak is invisible until someone
 * tries to swap the engine.
 *
 * Structural typing does the narrowing for free: `Entity` and `World` already satisfy
 * these shapes, so nothing is wrapped or cast. What changes is what the adapter is able
 * to *name*.
 *
 * `transform` and `motion` are readonly properties holding mutable objects, which is
 * deliberate: the adapter may write `position.x`, but it may not replace the transform
 * wholesale with something the simulation does not own.
 */

/** Position and velocity are written back after the step, so the objects stay mutable. */
export interface PhysicsEntity {
  readonly id: number;
  readonly transform: {
    position: { x: number; y: number };
  };
  readonly motion: {
    velocity: { x: number; y: number };
  };
  readonly collider: {
    readonly radius: number;
    readonly mass: number;
    readonly fixed: boolean;
  };
  /**
   * Present on anything an emitter fired. Kinematic movers own their own transform, so
   * the adapter uses this only to decide whether to write the resolved motion back.
   */
  readonly projectile?: unknown;
}

/**
 * Insertion-ordered entity source.
 *
 * Only `all()` is required. A real `World` has more methods, and structural typing means
 * it still fits -- the point is that the adapter cannot reach the rest.
 */
export interface PhysicsWorld {
  all(): readonly PhysicsEntity[];
}
