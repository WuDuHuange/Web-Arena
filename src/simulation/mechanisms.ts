import { ignoresGroundHazards } from "./effects.ts";
import { distance, headingTo, hitsCircle } from "./geometry.ts";
import type { Entity, PropBehavior, PropTrigger } from "./types.ts";

/**
 * Field-object mechanisms.
 *
 * Seven mechanisms, four primitive families:
 *
 *   field     aura, conveyor    - write into the movement/health pipeline every tick
 *   impulse   spring            - change a unit's velocity once, then let inertia finish
 *   trigger   spike, explosive  - react to overlap, with a cooldown or a one-shot latch
 *   emitter   turret, shrine    - create new entities on a cadence
 *
 * The same three rules the combat core follows apply here, for the same reasons:
 *
 *  1. Damage and blast geometry are pure functions over positions. The physics engine is
 *     never asked who is inside a blast, so a frame-rate drop cannot change a mechanism's
 *     effect any more than it can change an ability's.
 *  2. All timing is ticks. `intervalTicks` and `cooldownTicks` are integer counts, never
 *     milliseconds.
 *  3. Every tick is resolved in two passes — decide, then apply — so a mechanism's
 *     effect does not depend on where its owner happens to sit in iteration order.
 */

/** A damage application produced by a mechanism this tick, for diagnostics and tests. */
export interface MechanismDamage {
  readonly sourceId: number;
  readonly targetId: number;
  readonly trigger: PropTrigger;
  readonly amount: number;
  readonly killed: boolean;
}

/** An entity the emitters want created this tick. Created by the caller, not by this module. */
export interface ProjectileRequest {
  readonly sourceId: number;
  readonly faction: Entity["faction"];
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly damage: number;
  readonly reach: number;
  /**
   * How long the shot lives, in ticks.
   *
   * A projectile that never expires is a leak: every shot an emitter ever fired stays in
   * the world forever, and the entity count grows without bound in a long battle. Derived
   * from reach and speed rather than authored, so a faster shot does not get a longer
   * life than a slower one over the same distance.
   */
  readonly lifeTicks: number;
  readonly toTargetId: number;
}

/** A velocity overlay a field applies this tick, keyed by the entity it lands on. */
export interface VelocityOverlay {
  readonly targetId: number;
  readonly x: number;
  readonly y: number;
}

export interface MechanismTickResult {
  readonly damage: readonly MechanismDamage[];
  readonly overlays: readonly VelocityOverlay[];
  readonly projectiles: readonly ProjectileRequest[];
  /**
   * Barrels that should go off this tick, in the order they were triggered.
   *
   * Returned as roots rather than resolved here because the chain is a loop with a bound,
   * and a loop with a bound belongs to the caller that owns the tick — not to a function
   * that would have to recurse to express it.
   */
  readonly detonations: readonly Entity[];
}

const EMPTY: MechanismTickResult = {
  damage: [],
  overlays: [],
  projectiles: [],
  detonations: []
};

/**
 * The mechanisms that are physically part of the floor.
 *
 * A flying unit passes over these and nothing else. Keying the exemption on the mechanism
 * rather than on the unit is the whole safety property: `flying` cannot grow into
 * "ignores everything" by accident, because the list of things it ignores is right here
 * and a barrel blast or a turret shot is not on it.
 */
const GROUND_BOUND: ReadonlySet<PropTrigger> = new Set<PropTrigger>([
  "aura",
  "conveyor",
  "spring",
  "spike"
]);

/**
 * Whether a mechanism may affect an entity at all.
 *
 * `hostile` is evaluated against the mechanism's own faction, so a turret owned by neutral
 * shoots at everyone while one owned by red shoots only at blue. Keeping this a pure
 * predicate means a test can ask the question without building a world.
 *
 * This is the single place the ground-hazard exemption is applied, which is why it lives
 * here rather than in each `step*` function: there are four ground mechanisms and three
 * call sites inside them, and a check that has to be remembered in three places is a check
 * that will be missing from one of them.
 */
export function mechanismAffects(
  behavior: PropBehavior,
  ownerFaction: Entity["faction"],
  target: Entity
): boolean {
  if (GROUND_BOUND.has(behavior.kind) && ignoresGroundHazards(target)) {
    return false;
  }
  switch (behavior.affects) {
    case "all":
      return true;
    case "none":
      return false;
    case "hostile":
      return target.faction !== ownerFaction;
  }
}

/** Whether an entity is a legitimate target: alive, not a mechanism, not the mechanism itself. */
function isCandidate(owner: Entity, entity: Entity): boolean {
  if (entity.id === owner.id || entity.health.dead) {
    return false;
  }
  // A mechanism never reacts to another mechanism. Without this a lava pool would count as
  // a valid target for an adjacent conveyor, and a neutral emitter would shoot the barrel
  // next to it instead of the units it exists to threaten.
  if (entity.behavior) {
    return false;
  }
  return true;
}

/**
 * Overlap test for a mechanism, in world units.
 *
 * Deliberately an edge-to-edge circle test rather than anything the physics engine
 * reports, so "this unit is standing on the spikes" is answerable from positions alone.
 */
export function overlapsMechanism(prop: Entity, behavior: PropBehavior, other: Entity): boolean {
  if (behavior.kind === "conveyor" || behavior.kind === "aura") {
    return hitsCircle(prop.transform.position, behavior.radius, {
      x: other.transform.position.x,
      y: other.transform.position.y,
      radius: other.collider.radius
    });
  }
  return distance(prop.transform.position, other.transform.position) <=
    behavior.reach + prop.collider.radius + other.collider.radius;
}

/**
 * Resolves every mechanism for one tick.
 *
 * Two passes, exactly like `Battle.run`: continuous sources are applied first, then the
 * reactive mechanisms decide against the entity list as it was at the top of the tick. A
 * barrel that goes off therefore cannot change whether a later barrel in the same tick also
 * goes off by proximity, which is what keeps a chain reproducible.
 *
 * Blast chains are returned to the caller instead of being walked here, so the loop bound
 * lives next to the other bounds in `Simulation.step`. See `blast` for why.
 */
export function stepMechanisms(
  entities: readonly Entity[],
  tick: number
): MechanismTickResult {
  const withMechanisms = entities.filter((e) => e.behavior !== undefined && e.mechanism !== undefined);
  if (withMechanisms.length === 0) {
    return EMPTY;
  }

  const damage: MechanismDamage[] = [];
  const overlays: VelocityOverlay[] = [];
  const projectiles: ProjectileRequest[] = [];
  const detonations: Entity[] = [];

  // Pass 1: continuous sources. Aura and conveyor write every tick, and their internal
  // interval counters already throttle the *effect* — a throttled aura still needs to be
  // stepped every tick or its phase would only advance while a unit was standing on it.
  for (const prop of withMechanisms) {
    const behavior = prop.behavior;
    const mechanism = prop.mechanism;
    if (!behavior || !mechanism || mechanism.spent) {
      continue;
    }

    switch (behavior.kind) {
      case "aura":
        stepAura(prop, behavior, entities, damage, tick);
        break;
      case "conveyor":
        stepConveyor(prop, behavior, entities, overlays);
        break;
      default:
        break;
    }
  }

  // Pass 2: triggers and emitters. These are the ones whose outcome can depend on what
  // already happened this tick, so they run after every continuous source has been applied.
  for (const prop of withMechanisms) {
    const behavior = prop.behavior;
    const mechanism = prop.mechanism;
    if (!behavior || !mechanism || mechanism.spent) {
      continue;
    }

    if (mechanism.cooldownTicksLeft > 0) {
      mechanism.cooldownTicksLeft -= 1;
      // A latched trigger stays armed-off until nothing is overlapping it, so a unit that
      // parks on a spike does not re-trip it the instant the cooldown expires. That is the
      // difference between a trap and a blender.
      continue;
    }

    switch (behavior.kind) {
      case "spike":
        stepSpike(prop, behavior, entities, damage);
        break;
      case "spring":
        stepSpring(prop, behavior, entities, overlays);
        break;
      case "explosive":
        if (explosiveIsTriggered(prop, behavior, entities)) {
          detonations.push(prop);
        }
        break;
      case "turret":
      case "shrine":
        stepEmitter(prop, behavior, entities, projectiles, tick);
        break;
      default:
        break;
    }
  }

  return { damage, overlays, projectiles, detonations };
}

/**
 * Continuous damage inside a radius, throttled by `intervalTicks`.
 *
 * The counter is per-mechanism, not per-target. That is a deliberate simplification: it
 * means a mechanism pulses on a single global beat instead of tracking a separate timer
 * for every unit standing in it, which keeps the state small and the behaviour legible.
 */
function stepAura(
  prop: Entity,
  behavior: PropBehavior,
  entities: readonly Entity[],
  damage: MechanismDamage[],
  tick: number
): void {
  const mechanism = prop.mechanism;
  if (!mechanism) {
    return;
  }

  // The counter still advances while empty, so an aura's beat is a property of the arena
  // rather than of whoever is standing in it. An aura that only ticked when occupied would
  // deal its first hit instantly on contact, which is a different mechanic.
  const interval = Math.max(behavior.intervalTicks, 1);
  mechanism.intervalTicksLeft -= 1;
  if (mechanism.intervalTicksLeft > 0) {
    return;
  }
  mechanism.intervalTicksLeft = interval;

  if (behavior.damage <= 0) {
    return;
  }

  for (const entity of entities) {
    if (!isCandidate(prop, entity)) {
      continue;
    }
    if (!mechanismAffects(behavior, prop.faction, entity)) {
      continue;
    }
    if (!hitsCircle(prop.transform.position, behavior.radius, {
      x: entity.transform.position.x,
      y: entity.transform.position.y,
      radius: entity.collider.radius
    })) {
      continue;
    }

    const killed = applyDamage(entity, behavior.damage);
    damage.push({
      sourceId: prop.id,
      targetId: entity.id,
      trigger: "aura",
      amount: behavior.damage,
      killed
    });
  }

  void tick;
}

/**
 * A conveyor writes a velocity overlay rather than a position.
 *
 * Moving the unit directly would let it be pushed through a wall; a velocity goes through
 * the same solver as everything else, so the arena stays sealed.
 *
 * The overlay is *added* to the unit's own intent by the caller. That is what makes a
 * conveyor push a unit against its will while it is still trying to walk forward, which is
 * the entire point of the mechanic.
 */
function stepConveyor(
  prop: Entity,
  behavior: PropBehavior,
  entities: readonly Entity[],
  overlays: VelocityOverlay[]
): void {
  if (behavior.force <= 0) {
    return;
  }
  const heading = behavior.forceFacing ?? prop.transform.facing;

  for (const entity of entities) {
    if (!isCandidate(prop, entity) || entity.collider.fixed) {
      continue;
    }
    if (!mechanismAffects(behavior, prop.faction, entity)) {
      continue;
    }
    if (!hitsCircle(prop.transform.position, behavior.radius, {
      x: entity.transform.position.x,
      y: entity.transform.position.y,
      radius: entity.collider.radius
    })) {
      continue;
    }

    overlays.push({
      targetId: entity.id,
      x: Math.cos(heading) * behavior.force,
      y: Math.sin(heading) * behavior.force
    });
  }
}

/**
 * A spring launches whatever is on it, along its own facing.
 *
 * Unconditional and repeatable, unlike a spike: the point of a spring is to be reusable.
 * It latches while something is still on the pad so a unit resting there is not relaunched
 * every tick, and unlatches the moment the pad is clear.
 */
function stepSpring(
  prop: Entity,
  behavior: PropBehavior,
  entities: readonly Entity[],
  overlays: VelocityOverlay[]
): void {
  const mechanism = prop.mechanism;
  if (!mechanism || behavior.force <= 0) {
    return;
  }

  const heading = behavior.forceFacing ?? prop.transform.facing;
  let touching = false;

  for (const entity of entities) {
    if (!isCandidate(prop, entity) || entity.collider.fixed) {
      continue;
    }
    if (!mechanismAffects(behavior, prop.faction, entity)) {
      continue;
    }
    if (!overlapsMechanism(prop, behavior, entity)) {
      continue;
    }
    touching = true;

    // Already launched: the velocity overlay would be a no-op anyway, but skipping the
    // launch keeps the cooldown honest.
    if (mechanism.latched) {
      continue;
    }

    overlays.push({
      targetId: entity.id,
      x: Math.cos(heading) * behavior.force,
      y: Math.sin(heading) * behavior.force
    });
  }

  if (touching && !mechanism.latched) {
    mechanism.latched = true;
    mechanism.cooldownTicksLeft = Math.max(behavior.cooldownTicks, 1);
  } else if (!touching) {
    mechanism.latched = false;
  }
}

/** A spike fires once when something steps on it, then goes quiet for its cooldown. */
function stepSpike(
  prop: Entity,
  behavior: PropBehavior,
  entities: readonly Entity[],
  damage: MechanismDamage[]
): void {
  const mechanism = prop.mechanism;
  if (!mechanism) {
    return;
  }

  // Compute the beat before the overlap check so the counter advances even with nothing on
  // the pad. Skipping it would stall the phase and make the cooldown depend on traffic.
  mechanism.intervalTicksLeft = Math.max(behavior.intervalTicks, 0);

  let victim: Entity | undefined;
  for (const entity of entities) {
    if (!isCandidate(prop, entity)) {
      continue;
    }
    if (!mechanismAffects(behavior, prop.faction, entity)) {
      continue;
    }
    if (!overlapsMechanism(prop, behavior, entity)) {
      continue;
    }
    // Lowest id wins, the same total-order rule the AI uses: a spike that picked by
    // iteration order would make the same seed replay differently.
    if (!victim || entity.id < victim.id) {
      victim = entity;
    }
  }

  if (!victim) {
    return;
  }

  mechanism.cooldownTicksLeft = Math.max(behavior.cooldownTicks, 1);

  if (behavior.damage <= 0) {
    return;
  }
  const killed = applyDamage(victim, behavior.damage);
  damage.push({
    sourceId: prop.id,
    targetId: victim.id,
    trigger: "spike",
    amount: behavior.damage,
    killed
  });
}

/**
 * Whether a barrel should go off.
 *
 * A barrel with a blast reach is a hazard: something has to walk into it. A barrel with no
 * reach has nothing to walk into, so it goes off as soon as it is stepped on at all — which
 * the generic overlap test already expresses, since `reach` collapses to its own body.
 */
function explosiveIsTriggered(
  prop: Entity,
  behavior: PropBehavior,
  entities: readonly Entity[]
): boolean {
  for (const entity of entities) {
    if (!isCandidate(prop, entity)) {
      continue;
    }
    if (!mechanismAffects(behavior, prop.faction, entity)) {
      continue;
    }
    if (!overlapsMechanism(prop, behavior, entity)) {
      continue;
    }
    return true;
  }
  return false;
}

/**
 * Applies one barrel's blast: area damage, a radial shove, and the set of barrels it
 * should chain into.
 *
 * Exported so the simulation's chain driver and its tests share one implementation rather
 * than each carrying a copy of the geometry.
 *
 * Returns the chain candidates rather than detonating them itself. That is what lets the
 * caller own the loop bound: this function cannot recurse, so the only way a chain runs
 * away is if the caller lets it, and the caller is where the depth cap lives.
 */
export function blast(
  prop: Entity,
  behavior: PropBehavior,
  entities: readonly Entity[],
  damage: MechanismDamage[],
  overlays: VelocityOverlay[]
): readonly Entity[] {
  const mechanism = prop.mechanism;
  if (!mechanism || mechanism.spent) {
    return [];
  }

  mechanism.spent = true;

  const blastRadius = Math.max(behavior.reach, behavior.radius);
  const origin = prop.transform.position;

  for (const entity of entities) {
    if (!isCandidate(prop, entity)) {
      continue;
    }
    if (!mechanismAffects(behavior, prop.faction, entity)) {
      continue;
    }
    if (!hitsCircle(origin, blastRadius, {
      x: entity.transform.position.x,
      y: entity.transform.position.y,
      radius: entity.collider.radius
    })) {
      continue;
    }

    if (behavior.damage > 0) {
      const killed = applyDamage(entity, behavior.damage);
      damage.push({
        sourceId: prop.id,
        targetId: entity.id,
        trigger: "explosive",
        amount: behavior.damage,
        killed
      });
    }

    if (behavior.force > 0) {
      // Pushed directly away from the blast, which is what "群体击退" means: a body in the
      // middle of a cluster is shoved outward, not in a fixed direction.
      //
      // A body exactly on the origin has no defined away-vector, so the fallback keeps the
      // result finite instead of producing a NaN heading that would poison the solver.
      const dx = entity.transform.position.x - origin.x;
      const dy = entity.transform.position.y - origin.y;
      const length = Math.hypot(dx, dy);
      const ux = length > 1e-6 ? dx / length : Math.cos(prop.transform.facing);
      const uy = length > 1e-6 ? dy / length : Math.sin(prop.transform.facing);

      // The shove is an overlay, not a direct velocity write, so it merges with whatever
      // the unit was already trying to do and still goes through the one write path.
      //
      // Closer bodies are thrown harder: a linear falloff is the cheapest thing that
      // reads as a real blast, and it keeps a body at the rim from being launched as far
      // as one at the centre.
      const falloff = 1 - Math.min(Math.hypot(dx, dy) / blastRadius, 1);
      const strength = behavior.force * (0.35 + 0.65 * falloff);
      overlays.push({
        targetId: entity.id,
        x: ux * strength,
        y: uy * strength
      });
    }
  }

  return chainTargets(prop, behavior, entities);
}

/**
 * Emitters create projectiles on a cadence.
 *
 * The projectile is requested, not created: this module has no access to `World`, so the
 * simulation owns entity creation and iteration order stays the world's business. That
 * separation is what keeps "who gets which id" deterministic.
 */
function stepEmitter(
  prop: Entity,
  behavior: PropBehavior,
  entities: readonly Entity[],
  projectiles: ProjectileRequest[],
  tick: number
): void {
  const mechanism = prop.mechanism;
  if (!mechanism) {
    return;
  }

  const interval = Math.max(behavior.intervalTicks, 1);
  mechanism.intervalTicksLeft -= 1;
  if (mechanism.intervalTicksLeft > 0) {
    return;
  }
  mechanism.intervalTicksLeft = interval;

  if ((behavior.projectileSpeed ?? 0) <= 0 || behavior.reach <= 0) {
    return;
  }

  // Nearest valid target, tie-broken by lowest id — the same total order as the AI.
  let target: Entity | undefined;
  let bestDistance = Infinity;
  for (const entity of entities) {
    if (!isCandidate(prop, entity)) {
      continue;
    }
    if (!mechanismAffects(behavior, prop.faction, entity)) {
      continue;
    }
    const dx = entity.transform.position.x - prop.transform.position.x;
    const dy = entity.transform.position.y - prop.transform.position.y;
    const distanceSq = dx * dx + dy * dy;
    if (distanceSq > behavior.reach * behavior.reach) {
      continue;
    }
    if (distanceSq < bestDistance - 1e-9) {
      bestDistance = distanceSq;
      target = entity;
    }
  }

  if (!target) {
    return;
  }

  const heading = headingTo(prop.transform.position, target.transform.position);
  const speed = behavior.projectileSpeed ?? 0;

  // Firing along the aim line means the projectile leads nothing. That is intentional for
  // a simple turret: a homing shot would need per-tick steering on the projectile, which
  // is a different mechanic and belongs with the ability system, not here.
  projectiles.push({
    sourceId: prop.id,
    faction: prop.faction,
    x: prop.transform.position.x,
    y: prop.transform.position.y,
    vx: Math.cos(heading) * speed,
    vy: Math.sin(heading) * speed,
    damage: behavior.damage,
    reach: behavior.reach,
    // 1.4x the straight-line time to reach its own reach, so the shot gets to overshoot
    // slightly rather than evaporating exactly at its nominal range.
    lifeTicks: Math.max(Math.ceil((behavior.reach / speed) * 60 * 1.4), 1),
    toTargetId: target.id
  });

  void tick;
}

/**
 * Advances every live projectile and resolves its impact.
 *
 * Projectiles are simulated here rather than by the ECS at large because they need one
 * thing nothing else does: a swept segment test. A shot moving at 300 units per second
 * covers 5 units per tick, so a discrete point check would let it pass through a target
 * that is only 6 units across. Testing the segment the shot travelled is what makes hits
 * independent of tick rate.
 *
 * Returns the ids that should be removed: shots that hit, and shots that ran out of life.
 */
export function stepProjectiles(
  entities: readonly Entity[],
  dtSeconds: number
): { damage: MechanismDamage[]; spent: number[] } {
  const damage: MechanismDamage[] = [];
  const spent: number[] = [];

  for (const projectile of entities) {
    const shot = projectile.projectile;
    if (!shot) {
      continue;
    }

    const from = { x: projectile.transform.position.x, y: projectile.transform.position.y };
    const to = {
      x: from.x + projectile.motion.velocity.x * dtSeconds,
      y: from.y + projectile.motion.velocity.y * dtSeconds
    };

    let hit: Entity | undefined;
    for (const entity of entities) {
      if (entity.id === projectile.id || entity.health.dead) {
        continue;
      }
      if (entity.faction === projectile.faction) {
        continue;
      }
      if (entity.behavior) {
        // Field objects are not targets: a turret should not shoot the lava.
        continue;
      }
      if (segmentHitsCircle(from, to, entity.transform.position, entity.collider.radius)) {
        hit = entity;
        break;
      }
    }

    if (hit) {
      const applied = Math.max(shot.damage, 0);
      hit.health.current = Math.max(hit.health.current - applied, 0);
      const killed = hit.health.current === 0;
      if (killed) {
        hit.health.dead = true;
      }
      damage.push({
        sourceId: projectile.id,
        targetId: hit.id,
        trigger: "turret",
        amount: applied,
        killed
      });
      spent.push(projectile.id);
      continue;
    }

    // A projectile integrates its own position rather than being moved by the physics
    // engine. That is deliberate: the engine would bounce it off the target it is meant to
    // hit, and the swept test would then be reading a position the shot was never allowed
    // to reach. Movement is folded into the persistent velocity so the next tick's segment
    // starts where this one ended.
    projectile.transform.position.x = to.x;
    projectile.transform.position.y = to.y;

    shot.ticksLeft -= 1;
    if (shot.ticksLeft <= 0) {
      spent.push(projectile.id);
    }
  }

  return { damage, spent };
}

/**
 * Segment versus circle.
 *
 * A swept test rather than a point test, because the whole reason a projectile can miss a
 * stationary target it visually passed through is that the check only looked at the end of
 * the step.
 */
export function segmentHitsCircle(
  from: { x: number; y: number },
  to: { x: number; y: number },
  centre: { x: number; y: number },
  radius: number
): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lengthSq = dx * dx + dy * dy;

  if (lengthSq <= 1e-12) {
    return distance(from, centre) <= radius;
  }

  // Projection of the centre onto the segment, clamped to the segment's own extent.
  const t = Math.min(Math.max(((centre.x - from.x) * dx + (centre.y - from.y) * dy) / lengthSq, 0), 1);
  const closestX = from.x + dx * t;
  const closestY = from.y + dy * t;
  return Math.hypot(centre.x - closestX, centre.y - closestY) <= radius;
}

/**
 * The barrels a blast should chain into.
 *
 * Exported so the chain driver and its tests agree on the rule rather than each carrying
 * its own copy. Membership is decided purely by distance and by "has not already gone off":
 * `blast` marks a barrel spent before returning its candidates, so a ring of barrels
 * naturally shrinks to empty.
 */
export function chainTargets(
  origin: Entity,
  behavior: PropBehavior,
  entities: readonly Entity[]
): readonly Entity[] {
  const chainRadius = behavior.chainRadius ?? 0;
  if (chainRadius <= 0) {
    return [];
  }

  const out: Entity[] = [];
  for (const entity of entities) {
    if (entity.id === origin.id) {
      continue;
    }
    if (!entity.behavior || !entity.mechanism) {
      continue;
    }
    if (entity.behavior.kind !== "explosive") {
      continue;
    }
    if (entity.mechanism.spent) {
      continue;
    }
    // A chain propagates regardless of allegiance. A barrel does not check teams when it
    // goes off, and pretending otherwise would make chaining depend on a read that the
    // blast damage does not use either.
    if (distance(origin.transform.position, entity.transform.position) > chainRadius + entity.collider.radius) {
      continue;
    }
    out.push(entity);
  }
  return out;
}

/** Reduces health and reports whether this application was lethal. */
function applyDamage(target: Entity, amount: number): boolean {
  const applied = Math.max(amount, 0);
  target.health.current = Math.max(target.health.current - applied, 0);
  if (target.health.current === 0) {
    target.health.dead = true;
    return true;
  }
  return false;
}
