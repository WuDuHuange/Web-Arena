import Matter from "matter-js";
import type { World } from "../simulation/world.ts";

export interface PhysicsBounds {
  readonly width: number;
  readonly height: number;
}

/**
 * Matter expresses velocity as displacement per `Body._baseDelta` (1000 / 60 ms), while
 * the simulation speaks world units per second. This is the only place that conversion
 * happens, so the rest of the codebase can stay in one unit system.
 */
const MATTER_BASE_DELTA_MS = 1000 / 60;
const MS_PER_SECOND = 1000;

function toMatterVelocity(unitsPerSecond: number): number {
  return (unitsPerSecond * MATTER_BASE_DELTA_MS) / MS_PER_SECOND;
}

function fromMatterVelocity(matterVelocity: number): number {
  return (matterVelocity * MS_PER_SECOND) / MATTER_BASE_DELTA_MS;
}

/**
 * Thin adapter over Matter.js.
 *
 * It owns hard-body collision and wall contact ONLY. Damage, factions, targeting and
 * skill effects deliberately stay in the simulation core: the physics engine must
 * never decide who loses health or which side a body belongs to.
 *
 * Bodies are created in world iteration order, which is stable, so two simulations
 * built from the same deployment step through identical physics.
 */
export class PhysicsAdapter {
  private readonly engine: Matter.Engine;
  private readonly bodies = new Map<number, Matter.Body>();

  constructor(bounds: PhysicsBounds) {
    this.engine = Matter.Engine.create({
      gravity: { x: 0, y: 0, scale: 0 },
      enableSleeping: false
    });
    this.addWalls(bounds);
  }

  /** Creates missing bodies and pushes authoritative positions into Matter. */
  sync(world: World): void {
    for (const entity of world.all()) {
      const existing = this.bodies.get(entity.id);
      if (existing) {
        Matter.Body.setPosition(existing, {
          x: entity.transform.position.x,
          y: entity.transform.position.y
        });
        if (!entity.collider.fixed) {
          Matter.Body.setVelocity(existing, {
            x: toMatterVelocity(entity.motion.velocity.x),
            y: toMatterVelocity(entity.motion.velocity.y)
          });
        }
        continue;
      }

      const isDynamic = !entity.collider.fixed;
      const body = Matter.Bodies.circle(
        entity.transform.position.x,
        entity.transform.position.y,
        entity.collider.radius,
        {
          isStatic: !isDynamic,
          friction: 0,
          frictionAir: 0,
          restitution: 0.6,
          label: `entity:${entity.id}`
        }
      );

      // Only dynamic bodies get an explicit mass. A static body carries infinite mass by
      // design, and `Body.setMass` on it divides Infinity by Infinity: the resulting NaN
      // inertia poisons the solver the first time anything touches it.
      if (isDynamic) {
        Matter.Body.setMass(body, Math.max(entity.collider.mass, 0.001));
        Matter.Body.setVelocity(body, {
          x: toMatterVelocity(entity.motion.velocity.x),
          y: toMatterVelocity(entity.motion.velocity.y)
        });
      }

      Matter.Composite.add(this.engine.world, body);
      this.bodies.set(entity.id, body);
    }
  }

  /** Advances Matter by exactly one fixed step. */
  step(fixedStepMs: number): void {
    Matter.Engine.update(this.engine, fixedStepMs);
  }

  /**
   * Pushes each entity's current velocity into its physics body.
   *
   * This must be called every tick, before `step`. Matter integrates from the body's own
   * velocity, so writing `entity.motion.velocity` without calling this changes nothing
   * about where the entity actually goes — the body keeps whatever velocity it was
   * created with and the entity appears frozen while reporting a perfectly sensible
   * intent.
   */
  applyVelocities(world: World): void {
    for (const entity of world.all()) {
      if (entity.collider.fixed) {
        continue;
      }
      const body = this.bodies.get(entity.id);
      if (!body) {
        continue;
      }
      Matter.Body.setVelocity(body, {
        x: toMatterVelocity(entity.motion.velocity.x),
        y: toMatterVelocity(entity.motion.velocity.y)
      });
    }
  }

  /**
   * Drops the physics bodies for entities that no longer exist.
   *
   * Without this a dead unit keeps its body in the world: invisible to the renderer (it is
   * gone from the snapshot) but still solid to everything else, so the arena accumulates
   * phantom obstacles as a battle drags on.
   */
  forget(ids: readonly number[]): void {
    for (const id of ids) {
      const body = this.bodies.get(id);
      if (!body) {
        continue;
      }
      Matter.Composite.remove(this.engine.world, body);
      this.bodies.delete(id);
    }
  }

  /** Copies Matter's resolved motion back into the authoritative world. */
  writeBack(world: World): void {
    for (const entity of world.all()) {
      const body = this.bodies.get(entity.id);
      if (!body) {
        continue;
      }
      entity.transform.position.x = body.position.x;
      entity.transform.position.y = body.position.y;
      entity.motion.velocity.x = fromMatterVelocity(body.velocity.x);
      entity.motion.velocity.y = fromMatterVelocity(body.velocity.y);
    }
  }

  private addWalls(bounds: PhysicsBounds): void {
    const thickness = 40;
    const half = thickness / 2;
    const walls = [
      Matter.Bodies.rectangle(bounds.width / 2, -half, bounds.width + thickness * 2, thickness, { isStatic: true }),
      Matter.Bodies.rectangle(bounds.width / 2, bounds.height + half, bounds.width + thickness * 2, thickness, { isStatic: true }),
      Matter.Bodies.rectangle(-half, bounds.height / 2, thickness, bounds.height + thickness * 2, { isStatic: true }),
      Matter.Bodies.rectangle(bounds.width + half, bounds.height / 2, thickness, bounds.height + thickness * 2, { isStatic: true })
    ];
    Matter.Composite.add(this.engine.world, walls);
  }
}
