/**
 * What the battle core reports to an observer, and nothing more.
 *
 * The simulation already computes all of this: `stepCombat` returns `DamageEvent`s and
 * the mechanism pass returns `MechanismDamage`. Both are consumed for their totals and
 * then dropped, which is fine while the only question anyone asks is "how much damage
 * happened this tick". It stops being fine the moment the question is "why did that unit
 * die" — a body killed by a chain of barrels, a spike field and a turret all read as the
 * same `killed += 1`, and by the time a replay or a post-battle summary wants the answer,
 * the information is gone.
 *
 * So this is a reporting channel, not a second source of truth. Two rules keep it that
 * way:
 *
 *   - **It cannot influence the simulation.** Events are emitted after the fact, from
 *     values the step already computed. Nothing here is read back.
 *   - **It allocates nothing when nobody is listening.** The emit hook is optional and
 *     every call site is `sink?.(...)`, so an unobserved run pays one branch per event
 *     and no object churn. At 60 Hz with a hundred units that distinction matters.
 *
 * This deliberately does not replace `CueDetector`. Audio still diffs snapshots, for the
 * reasons written up in `audio/detect.ts`: a cue only needs to know that *something*
 * happened, and diffing cannot corrupt the run. Attribution needs the cause, which a
 * snapshot comparison cannot recover.
 */

/**
 * Damage from one source to one target, in one tick.
 *
 * `cause` carries an ability id for a unit's attack and a `PropTrigger` for a mechanism.
 * Both fit in one field on purpose: a battle log should read as a single timeline, not as
 * two logs that have to be merged by timestamp afterwards.
 */
export interface DamageDealt {
  readonly kind: "damage";
  readonly tick: number;
  readonly sourceId: number;
  readonly targetId: number;
  readonly cause: string;
  readonly amount: number;
}

/**
 * A target reduced to zero, attributed to the hit that did it.
 *
 * Emitted alongside the `damage` event for the same hit rather than instead of it, so a
 * consumer that only wants deaths can filter and one that wants the killing blow does not
 * have to look it up.
 */
export interface EntityDied {
  readonly kind: "death";
  readonly tick: number;
  readonly targetId: number;
  readonly sourceId: number;
  readonly cause: string;
}

export type BattleEvent = DamageDealt | EntityDied;

/** Anything that wants the timeline. Kept as a plain function so a test can collect into an array. */
export type BattleEventSink = (event: BattleEvent) => void;
