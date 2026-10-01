export interface ClockOptions {
  /** Length of one authoritative simulation step, in milliseconds. */
  readonly fixedStepMs: number;
  /** Upper bound on steps run for a single frame, so catch-up stays bounded. */
  readonly maxCatchUpSteps: number;
}

/**
 * Turns irregular frame deltas into a whole number of fixed simulation steps.
 *
 * This is the mechanism behind "a frame-rate drop must not change skill timing or
 * damage": the simulation only ever advances in whole `fixedStepMs` units, and the
 * remainder is carried over instead of being dropped or rounded away.
 */
export class FixedStepClock {
  private readonly fixedStepMs: number;
  private readonly maxCatchUpSteps: number;
  private accumulatorMs = 0;
  private totalSteps = 0;
  private droppedMs = 0;

  constructor(options: ClockOptions) {
    if (!(options.fixedStepMs > 0)) {
      throw new Error("fixedStepMs must be greater than 0");
    }
    if (!(options.maxCatchUpSteps >= 1)) {
      throw new Error("maxCatchUpSteps must be at least 1");
    }
    this.fixedStepMs = options.fixedStepMs;
    this.maxCatchUpSteps = options.maxCatchUpSteps;
  }

  /**
   * Feeds one frame delta and returns how many fixed steps should run now.
   *
   * When a frame is late by more than `maxCatchUpSteps` worth of time, the excess is
   * dropped rather than replayed: the simulation must not silently skip结算 nor run
   * an unbounded backlog after the tab was in the background.
   */
  advance(deltaMs: number): number {
    if (!(deltaMs > 0)) {
      return 0;
    }

    this.accumulatorMs += deltaMs;
    let steps = Math.floor(this.accumulatorMs / this.fixedStepMs);
    if (steps <= 0) {
      return 0;
    }

    if (steps > this.maxCatchUpSteps) {
      const droppedSteps = steps - this.maxCatchUpSteps;
      this.droppedMs += droppedSteps * this.fixedStepMs;
      this.accumulatorMs -= droppedSteps * this.fixedStepMs;
      steps = this.maxCatchUpSteps;
    }

    this.accumulatorMs -= steps * this.fixedStepMs;
    // Note: `totalSteps` is deliberately *not* bumped here. `advance` only decides how
    // many steps are due; the owner calls `commitStep` as each one actually executes, so
    // a tick-by-tick driver and a frame-delta driver stay on the same counter.
    return steps;
  }

  /** Total authoritative steps executed so far. */
  get steps(): number {
    return this.totalSteps;
  }

  /**
   * Records that one authoritative step has been executed outside of `advance`.
   *
   * Used by `Simulation.step()` so a tick-by-tick driver keeps the same counter as a
   * frame-delta driver. Deliberately does not touch the accumulator: the caller has
   * already decided that a step happens now.
   */
  commitStep(): void {
    this.totalSteps += 1;
  }

  /** Simulated time discarded by catch-up clamping, in milliseconds. */
  get droppedMsTotal(): number {
    return this.droppedMs;
  }

  /** Fraction of a step already accumulated, for render interpolation. */
  get alpha(): number {
    return this.accumulatorMs / this.fixedStepMs;
  }
}
