import type { BattleSetup, Entity, SpawnDef } from "./types.ts";
import { World } from "./world.ts";

/** Builds the initial world from an immutable deployment. */
export function createWorldFromSetup(setup: BattleSetup): World {
  const world = new World();
  for (const spawn of setup.spawns) {
    world.add(toEntity(spawn));
  }
  return world;
}

function toEntity(spawn: SpawnDef): Omit<Entity, "id"> {
  return {
    kind: spawn.kind,
    faction: spawn.faction,
    tags: spawn.tags ?? [],
    transform: { position: { x: spawn.x, y: spawn.y } },
    motion: { velocity: { x: spawn.vx ?? 0, y: spawn.vy ?? 0 } },
    collider: {
      radius: spawn.radius,
      mass: spawn.mass,
      fixed: spawn.kind === "prop"
    },
    health: { current: spawn.hp, max: spawn.hp },
    render: { appearance: spawn.appearance ?? defaultAppearance(spawn) }
  };
}

function defaultAppearance(spawn: SpawnDef): string {
  return `${spawn.faction}-${spawn.kind}`;
}

export const GREYBOX_BOUNDS = { width: 960, height: 600 } as const;

/**
 * Minimal grey-box deployment used to prove the seams.
 *
 * It exists to exercise placement, hard-body collision, wall bounce and separation.
 * There is intentionally no targeting, skill or damage resolution here yet.
 *
 * Velocities are world units per second and are tuned so the two sides actually meet
 * and bounce within a few seconds of watching.
 */
export function greyboxSetup(fixedStepMs: number): BattleSetup {
  return {
    seed: 20261001,
    fixedStepMs,
    bounds: GREYBOX_BOUNDS,
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
  faction: SpawnDef["faction"],
  x: number,
  y: number,
  radius: number,
  mass: number,
  hp: number,
  vx: number
): SpawnDef {
  return { kind: "unit", faction, x, y, radius, mass, hp, vx };
}

function prop(faction: SpawnDef["faction"], x: number, y: number, radius: number, mass: number, hp: number): SpawnDef {
  return { kind: "prop", faction, x, y, radius, mass, hp };
}
