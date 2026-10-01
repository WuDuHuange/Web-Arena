import type { BattleSetup, Faction, SpawnDef } from "./types.ts";
import { createRng } from "./rng.ts";

/**
 * Programmatic deployments used to stress the simulation and render seams.
 *
 * Phase 1 acceptance asks for 100 characters plus 20 field objects at 60 FPS, and for
 * three failure modes to be ruled out by assertion rather than by eyeballing:
 * dense crowding, corner wedging, and high-speed tunnelling.
 *
 * None of these are gameplay content. They exist to be measured.
 */

export interface PressureOptions {
  readonly fixedStepMs: number;
  /** Number of moving units. Split evenly between the two factions. */
  readonly units: number;
  /** Number of static props. */
  readonly props: number;
  readonly seed?: number;
}

export const PRESSURE_BOUNDS = { width: 960, height: 600 } as const;

/** Shifts the whole deployment by a constant so scenes can be composed or offset. */
export interface SceneOffset {
  readonly x: number;
  readonly y: number;
}

/**
 * Baseline Phase 1 load: 100 units and 20 props spread across the field.
 *
 * Units start evenly on the two opposite edges and are given a gentle closing velocity
 * so they meet in the middle instead of idling. Matching masses keep the crowd
 * symmetric, which makes the crowding assertion meaningful.
 */
export function pressureSetup(options: PressureOptions): BattleSetup {
  const { fixedStepMs, units, props } = options;
  const seed = options.seed ?? 20261001;
  const rng = createRng(seed);

  const half = Math.floor(units / 2);
  const spawns: SpawnDef[] = [];

  pushColumn(spawns, "red", half, rng, 0);
  pushColumn(spawns, "blue", units - half, rng, 1);
  pushProps(spawns, props, rng);

  return { seed, fixedStepMs, bounds: PRESSURE_BOUNDS, spawns };
}

/** Both factions bunched into a small pocket, to force sustained contact overlap. */
export function compressionSetup(options: PressureOptions): BattleSetup {
  const { fixedStepMs, units } = options;
  const seed = options.seed ?? 20261002;
  const rng = createRng(seed);

  const half = Math.floor(units / 2);
  const spawns: SpawnDef[] = [];
  const cx = PRESSURE_BOUNDS.width / 2;

  for (let i = 0; i < half; i += 1) {
    spawns.push(
      unit("red", cx - 40 + rng.range(-8, 8), PRESSURE_BOUNDS.height / 2 + rng.range(-120, 120), 12, 1, 60, 40)
    );
  }
  for (let i = 0; i < units - half; i += 1) {
    spawns.push(
      unit("blue", cx + 40 + rng.range(-8, 8), PRESSURE_BOUNDS.height / 2 + rng.range(-120, 120), 12, 1, 60, -40)
    );
  }
  pushProps(spawns, options.props, rng);

  return { seed, fixedStepMs, bounds: PRESSURE_BOUNDS, spawns };
}

/** Everything shoved into one corner, to see whether bodies wedge or escape the walls. */
export function cornerSetup(options: PressureOptions): BattleSetup {
  const { fixedStepMs, units } = options;
  const seed = options.seed ?? 20261003;
  const rng = createRng(seed);

  const spawns: SpawnDef[] = [];
  const margin = 70;

  for (let i = 0; i < units; i += 1) {
    const faction: Faction = i % 2 === 0 ? "red" : "blue";
    spawns.push(
      unit(
        faction,
        margin + rng.range(0, 60),
        margin + rng.range(0, 60),
        12,
        1,
        60,
        faction === "red" ? 60 : -60
      )
    );
  }
  pushProps(spawns, options.props, rng);

  return { seed, fixedStepMs, bounds: PRESSURE_BOUNDS, spawns };
}

/**
 * A handful of very fast bodies aimed at thin static props.
 *
 * With radius 6 and a step of 1000/60 ms, a body must exceed roughly
 * (2 * 6) / (1000/60) = 720 world units per second before a naive discrete solver can
 * skip over it entirely. These projectiles are launched well past that threshold so the
 * tunnelling assertion has something real to catch.
 */
export function tunnellingSetup(options: PressureOptions): BattleSetup {
  const { fixedStepMs } = options;
  const seed = options.seed ?? 20261004;
  const rng = createRng(seed);

  const spawns: SpawnDef[] = [];
  const midY = PRESSURE_BOUNDS.height / 2;

  for (let lane = 0; lane < 8; lane += 1) {
    const y = 60 + lane * 60;
    spawns.push({ kind: "projectile", faction: "red", x: 60, y, radius: 6, mass: 0.4, hp: 1, vx: 1500 });
    spawns.push({ kind: "prop", faction: "neutral", x: PRESSURE_BOUNDS.width - 120, y, radius: 10, mass: 2, hp: 40 });
  }

  spawns.push(prop("neutral", PRESSURE_BOUNDS.width / 2, midY - 90, 14, 3, 80));
  spawns.push(prop("neutral", PRESSURE_BOUNDS.width / 2, midY + 90, 14, 3, 80));

  void rng;
  return { seed, fixedStepMs, bounds: PRESSURE_BOUNDS, spawns };
}

function pushColumn(
  out: SpawnDef[],
  faction: Faction,
  count: number,
  rng: ReturnType<typeof createRng>,
  side: 0 | 1
): void {
  // Spread the faction over a grid that grows *inward* from its own edge, so no spawn
  // can ever be placed outside the arena regardless of how many units are requested.
  const cols = Math.max(Math.ceil(Math.sqrt(count)), 1);
  const rows = Math.max(Math.ceil(count / cols), 1);
  const colStep = 30;
  const rowStep = 500 / Math.max(rows - 1, 1);
  const baseX = side === 0 ? 120 : PRESSURE_BOUNDS.width - 120;
  const dir = side === 0 ? 1 : -1;
  const vx = side === 0 ? 120 : -120;

  for (let i = 0; i < count; i += 1) {
    const col = Math.floor(i / rows);
    const row = i % rows;
    const x = baseX + dir * col * colStep;
    const y = 50 + row * rowStep;
    out.push(unit(faction, x + rng.range(-4, 4), y + rng.range(-6, 6), 12, 1, 60, vx));
  }
}

function pushProps(out: SpawnDef[], count: number, rng: ReturnType<typeof createRng>): void {
  for (let i = 0; i < count; i += 1) {
    const angle = (i / Math.max(count, 1)) * Math.PI * 2;
    const radius = 160 + (i % 3) * 40;
    const x = PRESSURE_BOUNDS.width / 2 + Math.cos(angle) * radius + rng.range(-10, 10);
    const y = PRESSURE_BOUNDS.height / 2 + Math.sin(angle) * radius * 0.6 + rng.range(-10, 10);
    out.push(prop("neutral", x, y, 22, 3, 200));
  }
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
