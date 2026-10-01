import type { AbilityGeometry, MutableVec2 } from "./types.ts";

/**
 * Pure hit-geometry tests.
 *
 * These are deliberately hand-written rather than delegated to the physics engine. Two
 * reasons, both load-bearing:
 *
 *  1. Reproducibility. A hit must depend only on the tick and the seed, never on the
 *     solver's contact manifold or on a version bump in Matter.js.
 *  2. Testability. Every function here takes plain numbers and returns a boolean, so the
 *     whole hit layer is exercisable in `node --test` with no engine and no browser.
 *
 * Everything works in world units. Angles are radians, measured with +x as 0 and
 * increasing clockwise on screen (which is the natural reading of `Math.atan2(y, x)`).
 */

export interface CircleTarget {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
}

/** Wraps an angle into (-PI, PI]. */
export function normalizeAngle(angle: number): number {
  let a = angle;
  while (a <= -Math.PI) {
    a += Math.PI * 2;
  }
  while (a > Math.PI) {
    a -= Math.PI * 2;
  }
  return a;
}

/** Smallest signed difference `to - from`, in (-PI, PI]. */
export function angleDelta(from: number, to: number): number {
  return normalizeAngle(to - from);
}

/**
 * Rotates `from` toward `to` by at most `maxStep` radians.
 *
 * Used so a caster turns gradually instead of snapping, which keeps the turn rate a
 * data-driven property rather than an instant teleport of the facing.
 */
export function turnToward(from: number, to: number, maxStep: number): number {
  const delta = angleDelta(from, to);
  if (Math.abs(delta) <= maxStep) {
    return normalizeAngle(to);
  }
  return normalizeAngle(from + Math.sign(delta) * maxStep);
}

/** Distance between two points. */
export function distance(a: MutableVec2, b: MutableVec2): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Heading from `a` to `b`, in radians. */
export function headingTo(a: MutableVec2, b: MutableVec2): number {
  return Math.atan2(b.y - a.y, b.x - a.x);
}

/**
 * Circle versus circle, using edge-to-edge distance.
 *
 * Comparing edge distance (not centre distance) is what lets a large target be hit by a
 * short-range ability: the caster reaches from its own edge, not from its centre.
 */
export function hitsCircle(origin: MutableVec2, originRadius: number, target: CircleTarget): boolean {
  return distance(origin, target) <= originRadius + target.radius;
}

/**
 * Melee: a short circle centred on the caster, in the facing direction.
 *
 * Modelled as a circle *offset ahead of the caster* rather than a plain radius, so a
 * melee unit hits what it is facing and not what is standing behind it.
 */
export function hitsMelee(
  origin: MutableVec2,
  originRadius: number,
  facing: number,
  geometry: AbilityGeometry,
  target: CircleTarget
): boolean {
  const reach = geometry.range;
  if (reach <= 0) {
    return hitsCircle(origin, originRadius, target);
  }
  const centre = {
    x: origin.x + Math.cos(facing) * reach,
    y: origin.y + Math.sin(facing) * reach
  };
  return hitsCircle(centre, originRadius, target);
}

/**
 * Cone: inside `halfAngle` of the facing direction, within `range` of the caster's edge.
 *
 * Includes a closing circle at the caster's own radius: without it a target standing
 * inside the cone's mouth but slightly off-axis would be missed, which reads as a
 * whiff at point-blank range.
 */
export function hitsCone(
  origin: MutableVec2,
  originRadius: number,
  facing: number,
  geometry: AbilityGeometry,
  target: CircleTarget
): boolean {
  const dx = target.x - origin.x;
  const dy = target.y - origin.y;
  const centreDistance = Math.hypot(dx, dy);

  if (centreDistance <= originRadius + target.radius) {
    return true;
  }
  if (centreDistance > geometry.range + originRadius + target.radius) {
    return false;
  }

  const halfAngle = geometry.halfAngle ?? Math.PI / 4;
  // The angular tolerance widens for nearby targets, because the target's own radius
  // subtends a larger angle the closer it is. Without this, a wide enemy adjacent to the
  // caster falls outside a narrow cone and the attack looks broken.
  const angularSlack = Math.atan2(target.radius, Math.max(centreDistance, 1e-6));
  const targetAngle = Math.atan2(dy, dx);
  return Math.abs(angleDelta(facing, targetAngle)) <= halfAngle + angularSlack;
}

/**
 * Line: a thick segment extending `range` forward from the caster.
 *
 * Modelled with a real width rather than as a zero-width ray so a target that is a few
 * units off the axis is still hit, and so fast projectiles cannot slip past between
 * ticks purely by being off-axis.
 */
export function hitsLine(
  origin: MutableVec2,
  originRadius: number,
  facing: number,
  geometry: AbilityGeometry,
  target: CircleTarget
): boolean {
  const width = geometry.width ?? originRadius;
  const dirX = Math.cos(facing);
  const dirY = Math.sin(facing);

  const relX = target.x - origin.x;
  const relY = target.y - origin.y;

  // Projection along the attack axis, clamped to the segment [0, range].
  const along = relX * dirX + relY * dirY;
  if (along < -target.radius || along > geometry.range + target.radius) {
    return false;
  }
  const clampedAlong = Math.min(Math.max(along, 0), geometry.range);

  // Perpendicular distance from the clamped point on the axis.
  const closestX = origin.x + dirX * clampedAlong;
  const closestY = origin.y + dirY * clampedAlong;
  const perpDistance = Math.hypot(target.x - closestX, target.y - closestY);

  return perpDistance <= width / 2 + target.radius;
}

/**
 * Circle: an area effect, either centred on the caster or on the aim point.
 *
 * When `centredOnCaster` is false the caller supplies the aim point in `aim`, which is
 * how an aimed ground AoE is expressed without adding a new geometry kind.
 */
export function hitsArea(
  origin: MutableVec2,
  originRadius: number,
  geometry: AbilityGeometry,
  target: CircleTarget,
  aim?: MutableVec2
): boolean {
  const centre = !geometry.centredOnCaster && aim ? aim : origin;
  const baseRadius = !geometry.centredOnCaster && aim ? 0 : originRadius;
  return hitsCircle(centre, baseRadius + geometry.range, target);
}

/**
 * The single entry point the damage system calls.
 *
 * A new geometry kind is added here and nowhere else, which keeps the "one primitive per
 * mechanic" boundary honest.
 */
export function hitsTarget(
  geometry: AbilityGeometry,
  origin: MutableVec2,
  originRadius: number,
  facing: number,
  target: CircleTarget,
  aim?: MutableVec2
): boolean {
  switch (geometry.kind) {
    case "melee":
      return hitsMelee(origin, originRadius, facing, geometry, target);
    case "cone":
      return hitsCone(origin, originRadius, facing, geometry, target);
    case "line":
      return hitsLine(origin, originRadius, facing, geometry, target);
    case "circle":
      return hitsArea(origin, originRadius, geometry, target, aim);
    default:
      // Exhaustiveness guard. Adding a kind to the type without handling it here would
      // otherwise turn every attack of that kind into a silent no-op.
      throw new Error(`unhandled ability geometry: ${(geometry as { kind: string }).kind}`);
  }
}
