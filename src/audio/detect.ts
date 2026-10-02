import type { WorldSnapshot } from "../simulation/types.ts";
import type { Cue } from "./synth.ts";

/**
 * Derives sound cues by diffing successive snapshots.
 *
 * The alternative — emitting events from inside the simulation — was rejected. Events
 * would have to be buffered per tick, drained exactly once, and kept out of every
 * determinism assertion; a bug there shows up as duplicate or missing audio, which is
 * both harmless-looking and miserable to trace. Reading two snapshots and comparing them
 * cannot affect the simulation at all, because nothing here writes to it.
 *
 * The cost is that a cue fires one frame after the fact, which at 60 Hz is imperceptible.
 */

export interface CueEvent {
  readonly cue: Cue;
  readonly intensity: number;
}

export interface CueDetector {
  /** Returns at most one cue of each kind per frame, so a wide AoE cannot spam the mixer. */
  detect(snapshot: WorldSnapshot): readonly CueEvent[];
  /** Must be called on reset: entity ids are reused, and stale state would fake cues. */
  reset(): void;
}

/** A shove this much faster than the entity's last recorded speed reads as a launch. */
const SPRING_SPEED_DELTA = 130;

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function createCueDetector(): CueDetector {
  const health = new Map<number, number>();
  const dead = new Set<number>();
  const spent = new Set<number>();
  const shots = new Set<number>();
  const impulse = new Map<number, number>();

  const reset = (): void => {
    health.clear();
    dead.clear();
    spent.clear();
    shots.clear();
    impulse.clear();
  };

  return {
    reset,

    detect(snapshot: WorldSnapshot): readonly CueEvent[] {
      const events: CueEvent[] = [];
      const seenHealth = new Set<number>();
      const seenShots = new Set<number>();
      const seenImpulse = new Set<number>();

      let damage = 0;
      let wounded = 0;
      let killed = 0;
      let blasted = 0;
      let fired = 0;
      let launched = 0;

      for (const entity of snapshot.entities) {
        seenHealth.add(entity.id);

        const previous = health.get(entity.id);
        if (previous !== undefined && entity.health.current < previous - 0.001) {
          damage += previous - entity.health.current;
          wounded += 1;
        }
        health.set(entity.id, entity.health.current);

        if (entity.health.dead) {
          if (!dead.has(entity.id)) {
            dead.add(entity.id);
            killed += 1;
          }
        } else if (dead.has(entity.id)) {
          // A reset that reuses an id must not leave this entity pre-marked as dead.
          dead.delete(entity.id);
        }

        // A one-shot trap is spent exactly once, so that transition is the blast.
        if (entity.mechanism?.spent) {
          if (!spent.has(entity.id)) {
            spent.add(entity.id);
            blasted += 1;
          }
        }

        if (entity.projectile) {
          seenShots.add(entity.id);
          if (!shots.has(entity.id)) {
            // Both sets must be updated. Recording only the per-frame set means every frame
            // the shot is in flight reports it again as a fresh firing.
            shots.add(entity.id);
            fired += 1;
          }
        }

        // A spring throws things that have no AI to move them. The signature is a body
        // that suddenly carries far more velocity than it had a moment ago.
        if (entity.persistentVelocity && !entity.projectile && !entity.behavior) {
          seenImpulse.add(entity.id);
          const speed = Math.hypot(entity.persistentVelocity.x, entity.persistentVelocity.y);
          const before = impulse.get(entity.id) ?? speed;
          if (speed - before > SPRING_SPEED_DELTA) {
            launched += 1;
          }
          impulse.set(entity.id, speed);
        }
      }

      // Drop state for anything that left the world, or the maps grow without bound.
      for (const id of [...health.keys()]) {
        if (!seenHealth.has(id)) {
          health.delete(id);
          dead.delete(id);
          spent.delete(id);
        }
      }
      for (const id of [...shots]) {
        if (!seenShots.has(id)) {
          shots.delete(id);
        }
      }
      for (const id of [...impulse.keys()]) {
        if (!seenImpulse.has(id)) {
          impulse.delete(id);
        }
      }

      if (wounded > 0) {
        events.push({ cue: "hit", intensity: clamp01(0.4 + damage / 70) });
      }
      if (killed > 0) {
        events.push({ cue: "kill", intensity: clamp01(0.5 + killed * 0.2) });
      }
      if (blasted > 0) {
        events.push({ cue: "blast", intensity: 1 });
      }
      if (fired > 0) {
        events.push({ cue: "shot", intensity: clamp01(0.5 + fired * 0.15) });
      }
      if (launched > 0) {
        events.push({ cue: "spring", intensity: 0.8 });
      }

      return events;
    }
  };
}
