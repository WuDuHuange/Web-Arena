import { PhysicsAdapter } from "../physics/adapter.ts";
import { Battle } from "./battle.ts";
import type { TickOutcome } from "./battle.ts";
import { FixedStepClock } from "./clock.ts";
import { createRng } from "./rng.ts";
import type { Rng } from "./rng.ts";
import { createWorldFromSetup } from "./spawn.ts";
import type { AbilitySpec, BattleSetup, WorldSnapshot } from "./types.ts";
import type { World } from "./world.ts";

export interface SimulationOptions {
  /** Defaults to 8 steps, i.e. a bounded amount of catch-up per frame. */
  readonly maxCatchUpSteps?: number;
}

/**
 * The authoritative battle core.
 *
 * It owns the clock, the world, the seeded RNG, the battle systems and the physics
 * adapter. It never touches the DOM, React, PixiJS or audio, so it can be stepped from a
 * test runner with no renderer present.
 *
 * One `step()` is one authoritative tick and does exactly this, in order:
 *   1. Resolve intent and combat (the `Battle` orchestrator).
 *   2. Remove anything that died this tick, from world and physics alike.
 *   3. Push intent into Matter and let it resolve hard-body motion.
 *   4. Copy resolved positions back.
 *
 * Movement intent is written in step 3 rather than step 1 so the physics engine sees the
 * intent from the tick it belongs to.
 */
export class Simulation {
  private readonly setup: BattleSetup;
  private readonly world: World;
  private readonly clock: FixedStepClock;
  private readonly physics: PhysicsAdapter;
  private readonly battle: Battle;
  private readonly rng: Rng;
  private readonly abilitiesById: Map<string, AbilitySpec>;
  private lastOutcome: TickOutcome = { damage: 0, killed: 0 };

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

    this.battle = new Battle(this.world, setup.abilities);
    for (const profile of setup.characters ?? []) {
      const abilities = profile.abilityIds
        .map((id) => this.abilitiesById.get(id))
        .filter((a): a is AbilitySpec => a !== undefined);
      this.battle.registerCharacter(profile.id, profile.speed, profile.aggroRange, abilities);
    }

    this.physics.sync(this.world);
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
   * Runs exactly one authoritative fixed step and advances the tick counter.
   *
   * The counter is bumped here rather than in `advance` so that a caller which drives the
   * simulation tick-by-tick (tests, replays, a head-less benchmark) sees the same `tick`
   * as a caller which feeds irregular frame deltas.
   */
  step(): void {
    this.clock.commitStep();

    // 1. Intent and combat resolution.
    this.lastOutcome = this.battle.run(this.world);

    // 2. Flush the dead. Physics bodies must go too, or a corpse keeps blocking the
    //    living and the arena slowly fills with invisible obstacles.
    const removals = this.battle.takeRemovals();
    if (removals.length > 0) {
      for (const id of removals) {
        this.world.remove(id);
      }
      this.physics.forget(removals);
    }

    // 3. Push movement intent and resolve hard-body motion.
    this.applyMovementIntent();
    this.physics.applyVelocities(this.world);
    this.physics.step(this.setup.fixedStepMs);

    // 4. Copy resolved motion back into the authoritative world.
    this.physics.writeBack(this.world);
  }

  /**
   * Copies each entity's resolved movement intent into its physical velocity.
   *
   * The AI writes intent; this is the one place intent becomes velocity, so there is a
   * single answer to "why is this unit moving".
   */
  private applyMovementIntent(): void {
    for (const entity of this.world.all()) {
      if (!entity.combat || entity.collider.fixed) {
        continue;
      }
      entity.motion.velocity.x = entity.combat.desiredVelocity.x;
      entity.motion.velocity.y = entity.combat.desiredVelocity.y;
    }
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

  /** True when at most one faction still has a living combatant. */
  get decided(): boolean {
    return Battle.isDecided(this.world.all());
  }

  snapshot(): WorldSnapshot {
    return this.world.snapshot(this.clock.steps);
  }
}
