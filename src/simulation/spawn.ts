import { initialPhase } from "./combat.ts";
import type { AbilitySpec, BattleSetup, Entity, Faction, SpawnDef } from "./types.ts";
import { World } from "./world.ts";

/** Builds the initial world from an immutable deployment. */
export function createWorldFromSetup(setup: BattleSetup): World {
  const world = new World();
  const byId = new Map(setup.abilities.map((a) => [a.id, a]));

  for (const spawn of setup.spawns) {
    world.add(toEntity(spawn, setup, byId));
  }
  return world;
}

function toEntity(
  spawn: SpawnDef,
  setup: BattleSetup,
  abilitiesById: Map<string, AbilitySpec>
): Omit<Entity, "id"> {
  const base: Omit<Entity, "id"> = {
    kind: spawn.kind,
    faction: spawn.faction,
    tags: spawn.tags ?? [],
    transform: {
      position: { x: spawn.x, y: spawn.y },
      facing: spawn.facing ?? defaultFacing(spawn)
    },
    motion: { velocity: { x: spawn.vx ?? 0, y: spawn.vy ?? 0 } },
    collider: {
      radius: spawn.radius,
      mass: spawn.mass,
      fixed: spawn.kind === "prop"
    },
    health: { current: spawn.hp, max: spawn.hp },
    render: { appearance: spawn.appearance ?? defaultAppearance(spawn) }
  };

  const character = spawn.characterId
    ? setup.characters?.find((c) => c.id === spawn.characterId)
    : undefined;
  if (!character) {
    return base;
  }

  const abilities = character.abilityIds
    .map((id) => abilitiesById.get(id))
    .filter((a): a is AbilitySpec => a !== undefined);

  const first = abilities[0];
  const start = initialPhase(first);

  return {
    ...base,
    combat: {
      characterId: character.id,
      abilityIndex: 0,
      phase: start.phase,
      phaseTicksLeft: start.ticks,
      applied: false,
      aggroRange: character.aggroRange,
      desiredVelocity: { x: 0, y: 0 }
    }
  };
}

/**
 * Fallback heading: point at the opposite side of the arena.
 *
 * A deployment that omits `facing` still needs a sensible one, because a cone or line
 * ability with a meaningless facing would silently miss everything.
 */
function defaultFacing(spawn: SpawnDef): number {
  return spawn.faction === "red" ? 0 : Math.PI;
}

function defaultAppearance(spawn: SpawnDef): string {
  return `${spawn.faction}-${spawn.kind}`;
}

export const GREYBOX_BOUNDS = { width: 960, height: 600 } as const;

/**
 * Minimal grey-box deployment used to prove the seams.
 *
 * It exists to exercise placement, hard-body collision, wall bounce and separation.
 * Velocities are world units per second and are tuned so the two sides actually meet
 * and bounce within a few seconds of watching.
 */
export function greyboxSetup(fixedStepMs: number): BattleSetup {
  return {
    seed: 20261001,
    fixedStepMs,
    bounds: GREYBOX_BOUNDS,
    abilities: [],
    spawns: [
      unit("red", 140, 160, 12, 1, 60, 200),
      unit("red", 140, 300, 12, 1, 60, 240),
      unit("red", 140, 440, 14, 1.6, 90, 180),
      unit("blue", 820, 160, 12, 1, 60, -200),
      unit("blue", 820, 300, 12, 1, 60, -240),
      unit("blue", 820, 440, 14, 1.6, 90, -180),
      prop("neutral", 480, 200, 26, 3, 0),
      prop("neutral", 480, 400, 26, 3, 0)
    ]
  };
}

function unit(
  faction: Faction,
  x: number,
  y: number,
  radius: number,
  mass: number,
  hp: number,
  vx: number
): SpawnDef {
  return { kind: "unit", faction, x, y, radius, mass, hp, vx };
}

function prop(faction: Faction, x: number, y: number, radius: number, mass: number, hp: number): SpawnDef {
  return { kind: "prop", faction, x, y, radius, mass, hp };
}
