import { headingTo, turnToward } from "./geometry.ts";
import type { Entity, Faction } from "./types.ts";

/**
 * Targeting and movement intent.
 *
 * This module decides *intent* only: which enemy to approach and which way to face. It
 * never writes positions or velocities, and it never applies damage. The physics adapter
 * resolves movement, and the combat system resolves attacks.
 *
 * Determinism is the governing constraint. Every choice here is made by a total ordering
 * over entities, never by iteration order of a Map or by floating-point luck, so two runs
 * of the same deployment make the same decisions on the same tick.
 */

/** A faction is hostile to every faction that is not itself. */
export function isHostile(a: Faction, b: Faction): boolean {
  return a !== b;
}

/**
 * Nearest living hostile, breaking ties by lowest id.
 *
 * The tie-break is not cosmetic: without a total order, two equidistant targets can be
 * chosen in different orders across runs and the battle diverges from the same seed.
 */
export function findNearestTarget(self: Entity, candidates: readonly Entity[]): Entity | undefined {
  let best: Entity | undefined;
  let bestDistance = Infinity;

  for (const candidate of candidates) {
    if (!isHostile(self.faction, candidate.faction)) {
      continue;
    }
    if (candidate.health.dead) {
      continue;
    }
    if (candidate.id === self.id) {
      continue;
    }
    // Field objects are not targets. Without this a unit whose nearest "enemy" was a neutral
    // turret would march at it, stop at its edge and swing forever, which reads as a unit
    // that has simply stopped fighting.
    if (candidate.behavior) {
      continue;
    }
    // A projectile is not a target either: it is on the field for a fraction of a second and
    // chasing it would just make a unit twitch.
    if (candidate.projectile) {
      continue;
    }

    const dx = candidate.transform.position.x - self.transform.position.x;
    const dy = candidate.transform.position.y - self.transform.position.y;
    const distanceSq = dx * dx + dy * dy;

    if (distanceSq < bestDistance - 1e-9 || (Math.abs(distanceSq - bestDistance) <= 1e-9 && best && candidate.id < best.id)) {
      bestDistance = distanceSq;
      best = candidate;
    }
  }

  return best;
}

/**
 * Edge-to-edge distance, so a large target is reachable by a short-range attacker.
 *
 * Every "am I close enough to swing" decision uses this, which keeps reach consistent
 * with the geometry tests in `geometry.ts`.
 */
export function edgeDistance(self: Entity, other: Entity): number {
  const dx = other.transform.position.x - self.transform.position.x;
  const dy = other.transform.position.y - self.transform.position.y;
  return Math.hypot(dx, dy) - self.collider.radius - other.collider.radius;
}

/**
 * Resolves movement intent for one entity for one tick.
 *
 * The rule is deliberately simple in the MVP: close to within `stopDistance` of the
 * target, otherwise hold position. `stopDistance` is derived from the character's own
 * reach so that each unit naturally stops where its weapon is effective, without a
 * per-character movement script.
 */
export function resolveMovementIntent(
  self: Entity,
  target: Entity | undefined,
  speed: number,
  stopDistance: number
): void {
  const combat = self.combat;
  if (!combat) {
    return;
  }

  if (!target) {
    combat.desiredVelocity.x = 0;
    combat.desiredVelocity.y = 0;
    return;
  }

  const gap = edgeDistance(self, target);
  if (gap <= stopDistance) {
    combat.desiredVelocity.x = 0;
    combat.desiredVelocity.y = 0;
    return;
  }

  const heading = headingTo(self.transform.position, target.transform.position);
  combat.desiredVelocity.x = Math.cos(heading) * speed;
  combat.desiredVelocity.y = Math.sin(heading) * speed;
}

/**
 * Turns the caster toward its target at a bounded rate.
 *
 * `turnRate` is radians per tick, so a slower turn is a genuine disadvantage rather than
 * a cosmetic delay. Returns the new facing.
 */
export function resolveFacing(self: Entity, target: Entity | undefined, turnRate: number): number {
  if (!target) {
    return self.transform.facing;
  }
  const desired = headingTo(self.transform.position, target.transform.position);
  return turnToward(self.transform.facing, desired, turnRate);
}
