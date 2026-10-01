import { PhysicsAdapter } from "../physics/adapter.ts";
import { FixedStepClock } from "./clock.ts";
import { createRng } from "./rng.ts";
import type { Rng } from "./rng.ts";
import { createWorldFromSetup } from "./spawn.ts";
import type { BattleSetup, WorldSnapshot } from "./types.ts";
import type { World } from "./world.ts";

export interface SimulationOptions {
  /** Defaults to 8 steps, i.e. a bounded amount of catch-up per frame. */
  readonly maxCatchUpSteps?: number;
}

/**
 * The authoritative battle core.
 *
 * It owns the clock, the world, the seeded RNG and the physics adapter. It never
 * touches the DOM, React, PixiJS or audio, so it can be stepped from a test runner
 * with no renderer present.
 *
 * Scope note: this is a skeleton. It advances the clock and resolves hard-body
 * positions only. Targeting, abilities, damage and buffs are the next milestones.
 */
export class Simulation {
  private readonly setup: BattleSetup;
  private readonly world: World;
  private readonly clock: FixedStepClock;
  private readonly physics: PhysicsAdapter;
  private readonly rng: Rng;

  constructor(setup: BattleSetup, options: SimulationOptions = {}) {
    this.setup = setup;
    this.world = createWorldFromSetup(setup);
    this.clock = new FixedStepClock({
      fixedStepMs: setup.fixedStepMs,
      maxCatchUpSteps: options.maxCatchUpSteps ?? 8
    });
    this.physics = new PhysicsAdapter(setup.bounds);
    this.rng = createRng(setup.seed);
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
   * The counter is bumped here rather than in `advance` so that a caller which drives
   * the simulation tick-by-tick (tests, replays, a head-less benchmark) sees the same
   * `tick` as a caller which feeds irregular frame deltas.
   */
  step(): void {
    this.clock.commitStep();
    this.physics.step(this.setup.fixedStepMs);
    this.physics.writeBack(this.world);
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

  snapshot(): WorldSnapshot {
    return this.world.snapshot(this.clock.steps);
  }
}
