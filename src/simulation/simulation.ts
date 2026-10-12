import { PhysicsAdapter } from "../physics/adapter.ts";
import { Battle } from "./battle.ts";
import type { TickOutcome } from "./battle.ts";
import { FixedStepClock } from "./clock.ts";
import { stepBuffs } from "./effects.ts";
import { blast, stepMechanisms, stepProjectiles } from "./mechanisms.ts";
import type { MechanismDamage, ProjectileRequest, VelocityOverlay } from "./mechanisms.ts";
import { createRng } from "./rng.ts";
import type { Rng } from "./rng.ts";
import { createWorldFromSetup } from "./spawn.ts";
import type { AbilitySpec, BattleSetup, Entity, WorldSnapshot } from "./types.ts";
import type { World } from "./world.ts";

export interface SimulationOptions {
  /** Defaults to 8 steps, i.e. a bounded amount of catch-up per frame. */
  readonly maxCatchUpSteps?: number;
}

/**
 * How many links one blast chain may follow before it is cut off.
 *
 * A ring of barrels is a legal deployment, so a chain is not a tree and cannot be trusted
 * to terminate on its own. `blast` marks each barrel spent before returning its
 * neighbours, which is enough for a tree but not for a ring that loops back — this cap is
 * what makes the ring terminate. It is generous relative to any plausible layout: 32 links
 * at meaningful spacing spans the whole arena several times.
 */
const MAX_CHAIN_LINKS = 32;

/**
 * Fraction of an impulse that survives each tick.
 *
 * A spring launch or a blast shove would otherwise carry a unit across the arena forever,
 * because nothing in a top-down arena applies friction. 0.94 keeps a launch readable as a
 * throw — roughly 16 ticks, a bit over a quarter second, to shed half its speed — without
 * turning the arena into an ice rink or into glue.
 */
const IMPULSE_DECAY_PER_TICK = 0.94;

/** Below this speed an impulse is snapped to zero, so a coasting body actually comes to rest. */
const MIN_IMPULSE = 2;

/**
 * The authoritative battle core.
 *
 * It owns the clock, the world, the seeded RNG, the battle systems and the physics
 * adapter. It never touches the DOM, React, PixiJS or audio, so it can be stepped from a
 * test runner with no renderer present.
 *
 * One `step()` is one authoritative tick and does exactly this, in order:
 *   1. Advance every timed effect and drop the expired ones.
 *   2. Resolve intent and combat (the `Battle` orchestrator).
 *   3. Resolve field mechanisms: continuous sources, then triggers and emitters.
 *   4. Walk any blast chains, bounded by `MAX_CHAIN_LINKS`.
 *   5. Create the projectiles emitters asked for, and advance the ones already in flight.
 *   6. Remove everything that died or expired this tick, from world and physics alike.
 *   7. Push intent into Matter and let it resolve hard-body motion.
 *   8. Copy resolved positions back.
 *
 * Effects tick first because a buff applied during this tick's combat should get its full
 * authored duration, not duration-minus-one. Counting down first also means an effect that
 * expires does so before anything reads its modifiers this tick, so the tick a slow ends is
 * already a full-speed tick rather than a half-speed one.
 *
 * Mechanisms run after combat so a barrel triggered by a unit that died this tick still
 * has a stable entity list to read, and projectiles are created before the removal pass so
 * a shot fired and a body killed in the same tick are both handled by one sweep.
 */
export class Simulation {
  private readonly setup: BattleSetup;
  private readonly world: World;
  private readonly clock: FixedStepClock;
  private readonly physics: PhysicsAdapter;
  private readonly battle: Battle;
  private readonly rng: Rng;
  private readonly abilitiesById: Map<string, AbilitySpec>;
  private readonly pendingRemovals: number[] = [];
  private lastOutcome: TickOutcome = { damage: 0, killed: 0 };
  private mechanismDamageTotal = 0;
  private chainLinksLastTick = 0;
  private lastSnapshot: WorldSnapshot;

  constructor(setup: BattleSetup, options: SimulationOptions = {}) {
    this.setup = setup;
    this.world = createWorldFromSetup(setup);
    this.clock = new FixedStepClock({
      fixedStepMs: setup.fixedStepMs,
      maxCatchUpSteps: options.maxCatchUpSteps ?? 8
    });
    this.physics = new PhysicsAdapter(setup.bounds);
    this.rng = createRng(setup.seed);

    this.abilitiesById = new Map(setup.abilities.map((a) => [a.id, a]));

    this.battle = new Battle(this.world, setup.abilities, setup.buffs ?? []);
    for (const profile of setup.characters ?? []) {
      const abilities = profile.abilityIds
        .map((id) => this.abilitiesById.get(id))
        .filter((a): a is AbilitySpec => a !== undefined);
      this.battle.registerCharacter(profile.id, profile.speed, profile.aggroRange, abilities);
    }

    this.physics.sync(this.world);
    this.lastSnapshot = this.world.snapshot(0);
  }

  /**
   * Feeds one render-frame delta and runs a whole number of fixed steps.
   * Returns how many steps ran, which is what diagnostics and tests assert on.
   */
  advance(deltaMs: number): number {
    const steps = this.clock.advance(deltaMs);
    for (let i = 0; i < steps; i += 1) {
      this.step();
    }
    return steps;
  }

  /**
   * Advances exactly one tick, discarding any partial step first.
   *
   * The driver behind the step button, and the reason it is not just `step()`: while a
   * battle is paused the clock still holds the fraction of a step that the last frame
   * accumulated. Stepping without settling would leave that fraction in place, so every
   * frame the renderer draws would interpolate between two ticks and a tick-at-a-time
   * inspection would never actually show a tick. The counter is not affected either way —
   * `step()` owns that — so a stepped sequence and a real-time run agree tick for tick.
   */
  stepManually(): void {
    this.clock.settle();
    this.step();
  }

  /**
   * Runs exactly one authoritative fixed step and advances the tick counter.
   *
   * The counter is bumped here rather than in `advance` so that a caller which drives the
   * simulation tick-by-tick (tests, replays, a head-less benchmark) sees the same `tick`
   * as a caller which feeds irregular frame deltas.
   */
  step(): void {
    this.clock.commitStep();

    // 1. Timed effects count down first. A buff applied last tick is already running, and
    //    one applied during this tick's combat gets its full duration rather than losing a
    //    tick to bookkeeping order.
    stepBuffs(this.world.all());

    // 2. Intent and combat resolution.
    this.lastOutcome = this.battle.run(this.world);

    // 3. Field mechanisms. Overlays are held until movement is written, so a conveyor or a
    //    blast shove cannot be overwritten by the AI's own intent later in the same tick.
    const entities = this.world.all();
    const mechanisms = stepMechanisms(entities, this.clock.steps);
    const overlays: VelocityOverlay[] = [...mechanisms.overlays];
    const mechanismDamage: MechanismDamage[] = [...mechanisms.damage];

    // 4. Blast chains. A queue with a hard cap, not recursion: a ring of barrels is a legal
    //    layout and a recursive walk would not terminate on one.
    const pending = [...mechanisms.detonations];
    let links = 0;
    while (pending.length > 0 && links < MAX_CHAIN_LINKS) {
      const barrel = pending.shift();
      if (!barrel || !barrel.behavior || !barrel.mechanism || barrel.mechanism.spent) {
        continue;
      }
      links += 1;
      const chained = blast(barrel, barrel.behavior, entities, mechanismDamage, overlays);
      for (const next of chained) {
        pending.push(next);
      }
    }
    this.chainLinksLastTick = links;

    // A barrel that went off is consumed: it has done its job and leaving a spent husk
    // behind would block movement with an invisible obstacle.
    for (const barrel of mechanisms.detonations) {
      this.pendingRemovals.push(barrel.id);
    }

    // 5. Emitters: create this tick's shots, then advance every shot already in flight.
    for (const request of mechanisms.projectiles) {
      this.spawnProjectile(request);
    }
    const shots = stepProjectiles(this.world.all(), this.setup.fixedStepMs / 1000);
    mechanismDamage.push(...shots.damage);
    for (const id of shots.spent) {
      this.pendingRemovals.push(id);
    }
    // Mechanism damage is folded into the tick outcome so diagnostics do not have to know
    // where a point of damage came from to report that damage happened.
    for (const event of mechanismDamage) {
      this.mechanismDamageTotal += event.amount;
      if (event.killed) {
        this.lastOutcome = { damage: this.lastOutcome.damage, killed: this.lastOutcome.killed + 1 };
        this.pendingRemovals.push(event.targetId);
      }
    }

    // 6. Flush the dead and the spent. Physics bodies must go too, or a corpse keeps
    //    blocking the living and the arena slowly fills with invisible obstacles.
    const removals = this.battle.takeRemovals();
    for (const id of removals) {
      this.pendingRemovals.push(id);
    }
    const unique = [...new Set(this.pendingRemovals)];
    this.pendingRemovals.length = 0;

    if (unique.length > 0) {
      for (const id of unique) {
        this.world.remove(id);
      }
      this.physics.forget(unique);
    }

    // 7. Push movement intent and resolve hard-body motion.
    this.applyMovementIntent(overlays);
    this.physics.applyVelocities(this.world);
    this.physics.step(this.setup.fixedStepMs);

    // 8. Copy resolved motion back into the authoritative world.
    this.physics.writeBack(this.world);
  }

  /**
   * Copies each entity's resolved movement intent into its physical velocity.
   *
   * The AI writes intent; this is the one place intent becomes velocity, so there is a
   * single answer to "why is this unit moving". Terrain overlays are added here rather than
   * by the mechanisms module so there is still exactly one writer per tick.
   *
   * There are three kinds of mover, and conflating any two of them produces a body that
   * reports one motion and performs another:
   *
   *  - **AI-driven.** Intent is rebuilt from scratch every tick and is authoritative: a unit
   *    that wants to stand still stands still. A terrain overlay is added on top of that
   *    intent, every tick, for as long as the unit is standing in it.
   *  - **Impulse-driven** (`persistentVelocity`, no AI). Nothing re-derives its motion, so it
   *    keeps whatever it was last given, decaying. An impulse is *folded into* this vector
   *    rather than added on top of it, or a spring would add its full force every tick
   *    forever instead of launching once. Only projectiles use this today.
   *  - **Plain physical.** Neither of the above: the solver owns its motion outright. A
   *    terrain overlay is added for this tick only, which is the correct reading of a shove —
   *    the body is thrown, and then the solver is free to bounce it off a wall.
   */
  private applyMovementIntent(overlays: readonly VelocityOverlay[] = []): void {
    // Sum per target first, so two overlapping conveyors produce one push rather than the
    // last one winning by accident of ordering.
    const totals = new Map<number, { x: number; y: number }>();
    for (const overlay of overlays) {
      const existing = totals.get(overlay.targetId);
      if (existing) {
        existing.x += overlay.x;
        existing.y += overlay.y;
      } else {
        totals.set(overlay.targetId, { x: overlay.x, y: overlay.y });
      }
    }

    // Fold impulses into the persistent bodies first, so the loop below is a pure read.
    for (const entity of this.world.all()) {
      if (entity.collider.fixed || entity.combat || !entity.persistentVelocity) {
        continue;
      }
      const total = totals.get(entity.id);
      if (total) {
        entity.persistentVelocity.x += total.x;
        entity.persistentVelocity.y += total.y;
      }
    }

    for (const entity of this.world.all()) {
      if (entity.collider.fixed) {
        continue;
      }
      const overlay = totals.get(entity.id);

      if (entity.combat) {
        // AI intent is authoritative and rebuilt every tick, so terrain is added on top of
        // it rather than accumulated into anything.
        entity.motion.velocity.x = entity.combat.desiredVelocity.x + (overlay?.x ?? 0);
        entity.motion.velocity.y = entity.combat.desiredVelocity.y + (overlay?.y ?? 0);
        continue;
      }

      if (entity.persistentVelocity) {
        // Already folded in above. A projectile is exempt from decay: it is a ballistic shot
        // at a constant speed, and fading it would make a turret's effective range depend on
        // the decay constant rather than on the reach it was authored with.
        if (!entity.projectile) {
          entity.persistentVelocity.x *= IMPULSE_DECAY_PER_TICK;
          entity.persistentVelocity.y *= IMPULSE_DECAY_PER_TICK;
          if (Math.abs(entity.persistentVelocity.x) < MIN_IMPULSE) {
            entity.persistentVelocity.x = 0;
          }
          if (Math.abs(entity.persistentVelocity.y) < MIN_IMPULSE) {
            entity.persistentVelocity.y = 0;
          }
        }
        entity.motion.velocity.x = entity.persistentVelocity.x;
        entity.motion.velocity.y = entity.persistentVelocity.y;
        continue;
      }

      // A plain body: the solver's resolved velocity, plus this tick's push if any.
      entity.motion.velocity.x += overlay?.x ?? 0;
      entity.motion.velocity.y += overlay?.y ?? 0;
    }
  }

  /**
   * Creates a projectile entity.
   *
   * Added through the same `World.add` as everything else so id assignment stays in one
   * place. Because the world is iterated by insertion order, a shot created mid-tick is
   * appended after every existing entity, and the next tick sees it in a stable position —
   * which is what keeps a battle reproducible when emitters are firing.
   */
  private spawnProjectile(request: ProjectileRequest): void {
    const entity: Omit<Entity, "id"> = {
      kind: "projectile",
      faction: request.faction,
      tags: [],
      transform: {
        position: { x: request.x, y: request.y },
        facing: Math.atan2(request.vy, request.vx)
      },
      motion: { velocity: { x: request.vx, y: request.vy } },
      // A projectile is a kinematic mover, not a rigid body. `fixed` keeps it out of the
      // solver entirely: if it were a real body, the engine would bounce it off the very
      // target it is supposed to hit, and the swept hit test would run a tick too late to
      // ever see the overlap. Damage for a shot is decided by geometry, exactly like an
      // ability, and the physics engine is not allowed a vote.
      collider: { radius: 4, mass: 0.3, fixed: true },
      health: { current: 1, max: 1 },
      render: { appearance: `projectile-${request.sourceId}` },
      projectile: {
        damage: request.damage,
        ticksLeft: request.lifeTicks,
        sourceId: request.sourceId
      },
      persistentVelocity: { x: request.vx, y: request.vy }
    };

    this.world.add(entity);
    this.physics.spawn(this.world);
  }

  get tick(): number {
    return this.clock.steps;
  }

  /** Interpolation factor in [0, 1) for the renderer. */
  get alpha(): number {
    return this.clock.alpha;
  }

  get droppedMs(): number {
    return this.clock.droppedMsTotal;
  }

  /** Seeded source of randomness, to be consumed by AI and effect rolls later. */
  get random(): Rng {
    return this.rng;
  }

  /** Damage and kills resolved during the most recent tick. */
  get outcome(): TickOutcome {
    return this.lastOutcome;
  }

  /** Total damage dealt by field mechanisms since the simulation was built. */
  get mechanismDamage(): number {
    return this.mechanismDamageTotal;
  }

  /**
   * Blast links walked on the most recent tick.
   *
   * Exposed because a chain that silently hits the cap looks identical to one that
   * resolved naturally, and the difference is worth being able to assert on.
   */
  get chainLinks(): number {
    return this.chainLinksLastTick;
  }

  /** Live projectiles in flight, for diagnostics. */
  get projectileCount(): number {
    return this.world.all().filter((e) => e.projectile !== undefined).length;
  }

  /** True when at most one faction still has a living combatant. */
  get decided(): boolean {
    return Battle.isDecided(this.world.all());
  }

  snapshot(): WorldSnapshot {
    this.lastSnapshot = this.world.snapshot(this.clock.steps);
    return this.lastSnapshot;
  }
}
