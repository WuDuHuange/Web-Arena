import { findNearestTarget, resolveFacing, resolveMovementIntent } from "./ai.ts";
import { cadenceTicks, selectAbility, stepCombat, stopDistanceFor } from "./combat.ts";
import type { AbilitySpec, Entity, Faction } from "./types.ts";
import type { World } from "./world.ts";

/**
 * Battle orchestration for one tick.
 *
 * Ordering inside a tick is fixed and matters:
 *
 *   1. For every entity, decide intent (target, desired velocity, facing).
 *   2. Resolve combat for every entity against the candidate set.
 *   3. Hand movement intent to the physics adapter (done by the caller).
 *
 * Intent is decided for *all* entities before any combat resolves, so whether a unit acts
 * this tick does not depend on whether an earlier unit in the same tick already killed
 * something. That asymmetry is the classic source of "the same seed replays differently
 * after a refactor".
 */

export interface TickOutcome {
  readonly damage: number;
  readonly killed: number;
}

const TURN_RATE_RADIANS_PER_TICK = 0.12;

/**
 * Entity ids that were removed during the last `runCombat`, keyed by nothing but order.
 *
 * Kept on the instance so the caller can flush dead bodies out of the world and the
 * physics engine once per tick, rather than mid-iteration.
 */
export class Battle {
  private readonly abilities: readonly AbilitySpec[];
  private readonly characterAbilities = new Map<string, readonly AbilitySpec[]>();
  private readonly characterSpeed = new Map<string, number>();
  private readonly characterAggro = new Map<string, number>();
  private readonly pendingRemovals: number[] = [];

  constructor(world: World, abilities: readonly AbilitySpec[]) {
    this.abilities = abilities;
    void world;
  }

  /**
   * Registers the per-character lookups once, so the hot path is a map read rather than
   * a linear scan over the content library every tick.
   */
  registerCharacter(
    characterId: string,
    speed: number,
    aggroRange: number,
    abilities: readonly AbilitySpec[]
  ): void {
    this.characterAbilities.set(characterId, abilities);
    this.characterSpeed.set(characterId, speed);
    this.characterAggro.set(characterId, aggroRange);
  }

  /** Resolves one tick. Returns nothing; callers read `world` and `takeRemovals`. */
  run(world: World): TickOutcome {
    const entities = world.all();

    // Phase 1: intent. Nothing is mutated except each entity's own combat intent fields.
    for (const entity of entities) {
      const combat = entity.combat;
      if (!combat || entity.health.dead) {
        continue;
      }

      const abilities = this.characterAbilities.get(combat.characterId) ?? this.abilities;
      const current = selectAbility(abilities, combat.abilityIndex);
      const target = findNearestTarget(entity, entities);

      const speed = this.characterSpeed.get(combat.characterId) ?? 0;
      const stop = current ? stopDistanceFor(current) : 0;
      resolveMovementIntent(entity, target, speed, stop);

      // Only turn while not mid-swing, so a committed attack keeps its direction. This is
      // what makes sidestepping a telegraphed attack actually work.
      if (combat.phase === "cooldown") {
        entity.transform.facing = resolveFacing(entity, target, TURN_RATE_RADIANS_PER_TICK);
      }
    }

    // Phase 2: combat resolution, over the same immutable snapshot of the entity list.
    let damage = 0;
    let killed = 0;

    for (const entity of entities) {
      const combat = entity.combat;
      if (!combat || entity.health.dead) {
        continue;
      }

      const abilities = this.characterAbilities.get(combat.characterId) ?? this.abilities;
      const ability = selectAbility(abilities, combat.abilityIndex);
      if (!ability) {
        continue;
      }

      const target = findNearestTarget(entity, entities);
      const result = stepCombat(entity, ability, target, entities, 0);

      for (const event of result.events) {
        damage += event.amount;
        if (event.killed) {
          killed += 1;
          this.pendingRemovals.push(event.targetId);
        }
      }
    }

    return { damage, killed };
  }

  /** Drains the removal queue. Call once per tick, after combat and before physics sync. */
  takeRemovals(): readonly number[] {
    const out = this.pendingRemovals.slice();
    this.pendingRemovals.length = 0;
    return out;
  }

  /**
   * Whether the battle is over.
   *
   * "Over" means at most one faction still has a living combatant. Deliberately computed
   * from the world rather than tracked incrementally, so it cannot drift out of sync with
   * the actual entity list.
   */
  static survivorFactions(entities: readonly Entity[]): ReadonlySet<Faction> {
    const alive = new Set<Faction>();
    for (const entity of entities) {
      if (entity.combat && !entity.health.dead) {
        alive.add(entity.faction);
      }
    }
    return alive;
  }

  static isDecided(entities: readonly Entity[]): boolean {
    return Battle.survivorFactions(entities).size <= 1;
  }
}

/** Total ticks one full attack cycle of `ability` takes. Re-exported for diagnostics. */
export { cadenceTicks };
