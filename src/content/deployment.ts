import type { BattleSetup, CombatProfile, SpawnDef } from "../simulation/types.ts";
import type { AbilitySpec } from "../simulation/types.ts";
import { CHARACTER_LIBRARY, CONTENT_LIBRARY, PROP_LIBRARY } from "./library.ts";
import type { CharacterDef, PropDef, PropPlacement } from "./schema.ts";

/**
 * Builds an actual battle out of the content library.
 *
 * This is the seam between content and simulation: the library is authored by hand, and
 * this module flattens it into the immutable `BattleSetup` the core consumes. The core
 * itself never imports the library, which is what keeps it testable without assets.
 */

export const ARENA_BOUNDS = { width: 960, height: 600 } as const;

export interface LineupOptions {
  readonly fixedStepMs: number;
  readonly seed?: number;
  /** Character ids on each side, in placement order. */
  readonly red: readonly string[];
  readonly blue: readonly string[];
  /** Field objects to place, by library id. Omitted means an empty arena. */
  readonly props?: readonly PropPlacement[];
}

/** The simulation-relevant projection of every character in the library. */
export function combatProfiles(): readonly CombatProfile[] {
  return CHARACTER_LIBRARY.map((c) => ({
    id: c.id,
    abilityIds: c.abilityIds,
    speed: c.speed,
    aggroRange: c.aggroRange
  }));
}

/** Every ability in the library, keyed by the id the character list references. */
export function abilitySpecs(): readonly AbilitySpec[] {
  return CONTENT_LIBRARY.abilities.map((a) => a.spec);
}

/**
 * Turns a prop placement into a spawn.
 *
 * The prop's collider is deliberately much smaller than its behaviour radius. A floor plate
 * is not a wall: if the collider matched the effect radius, the solver would eject any unit
 * standing on the tile before the mechanism could react, and every trap would be a bollard
 * that can never be triggered.
 */
export function propSpawn(placement: PropPlacement, definition: PropDef): SpawnDef {
  return {
    kind: "prop",
    // Field objects are neutral, always. A hazard belongs to nobody: `affects: "hostile"`
    // on an emitter already means "shoot whoever is not on my side", and since the prop has
    // no side, that reads as "shoot everyone". Assigning a team here would silently make a
    // trap safe for half the arena.
    faction: "neutral",
    x: placement.x,
    y: placement.y,
    radius: Math.min(definition.behavior.radius, 10),
    mass: 3,
    hp: 1,
    facing: placement.facing ?? 0,
    behavior: definition.behavior,
    appearance: definition.appearance
  };
}

/**
 * Places a lineup on the field.
 *
 * Each side is arranged in a column near its own edge and spaced so that no two units
 * start overlapping. Overlapping spawns would make the opening seconds depend on how the
 * solver resolves a deep penetration, which is neither deterministic-looking nor fair.
 */
export function buildLineup(options: LineupOptions): BattleSetup {
  const spawns: SpawnDef[] = [];

  pushSide(spawns, "red", options.red, 0);
  pushSide(spawns, "blue", options.blue, 1);

  for (const placement of options.props ?? []) {
    const definition = PROP_LIBRARY.find((p) => p.id === placement.id);
    if (!definition) {
      // A bad placement id is a content bug the validator is expected to have caught.
      // Skipping keeps the arena from failing to build over one missing prop.
      continue;
    }
    spawns.push(propSpawn(placement, definition));
  }

  return {
    seed: options.seed ?? 20261002,
    fixedStepMs: options.fixedStepMs,
    bounds: ARENA_BOUNDS,
    spawns,
    abilities: abilitySpecs(),
    characters: combatProfiles()
  };
}

function pushSide(out: SpawnDef[], faction: "red" | "blue", ids: readonly string[], side: 0 | 1): void {
  const margin = 90;
  const spacing = 56;
  const baseX = side === 0 ? margin : ARENA_BOUNDS.width - margin;
  const facing = side === 0 ? 0 : Math.PI;

  const count = ids.length;
  const totalHeight = (count - 1) * spacing;
  const startY = ARENA_BOUNDS.height / 2 - totalHeight / 2;

  for (let i = 0; i < count; i += 1) {
    const character = CHARACTER_LIBRARY.find((c) => c.id === ids[i]);
    if (!character) {
      // A missing id is a content bug, and validateContent is expected to have caught it
      // before this point. Skipping quietly here keeps a bad deploy from crashing the
      // whole arena, while the validator remains the thing that reports it.
      continue;
    }

    out.push({
      kind: "unit",
      faction,
      x: baseX + (i % 2) * 26,
      y: startY + i * spacing,
      radius: character.radius,
      mass: character.mass,
      hp: character.hp,
      facing,
      characterId: character.id,
      appearance: character.appearance,
      tags: []
    });
  }
}

/**
 * The default matchup: one of each archetype per side.
 *
 * Both sides field all four geometries, so a battle where one archetype never lands a hit
 * points straight at that archetype's hit test rather than at an unbalanced roster.
 */
export function defaultMatchup(fixedStepMs: number): BattleSetup {
  return buildLineup({
    fixedStepMs,
    red: ["red.blade", "red.lancer", "red.caster", "red.bomber"],
    blue: ["blue.skirmisher", "blue.hexer", "blue.shrieker", "blue.rune"]
  });
}

/** A crowded version of the default matchup, for watching many-on-many resolution. */
export function squadMatchup(fixedStepMs: number, copies = 3): BattleSetup {
  const red: string[] = [];
  const blue: string[] = [];
  for (let i = 0; i < copies; i += 1) {
    red.push("red.blade", "red.lancer", "red.caster", "red.bomber");
    blue.push("blue.skirmisher", "blue.hexer", "blue.shrieker", "blue.rune");
  }
  return buildLineup({ fixedStepMs, red, blue });
}

/**
 * The Phase 3 acceptance scene: every mechanism on the field, with both rosters present.
 *
 * Laid out as a corridor rather than a scatter. Each mechanism needs to be *reachable* by a
 * unit walking across the middle, because a mechanism nobody can step on is a mechanism
 * whose behaviour is never exercised — and the whole point of this scene is that a single
 * run touches all seven.
 */
export function mechanismMatchup(fixedStepMs: number): BattleSetup {
  const mid = ARENA_BOUNDS.height / 2;

  const props: PropPlacement[] = [
    // A lava pool and a conveyor across the midline: the two continuous sources.
    { id: "prop.lava", x: 430, y: mid },
    { id: "prop.conveyor", x: 520, y: mid - 90 },

    // Triggers on the approach, so a unit crossing the field walks onto one.
    { id: "prop.spike", x: 360, y: mid + 80 },
    { id: "prop.spring", x: 360, y: mid - 80, facing: Math.PI },
    { id: "prop.barrel", x: 600, y: mid + 70 },
    { id: "prop.barrel", x: 660, y: mid + 70 },

    // Emitters placed *inside* the contested band rather than at an edge. A turret parked
    // behind its own line never fires: the battle is decided around the midline, and by the
    // time anything wandered back into its reach the fight would already be over. Reach is
    // large, so the constraint is really the distance to the crossing, not the range.
    { id: "prop.turret", x: 560, y: mid + 170 },
    { id: "prop.shrine", x: 560, y: mid - 170 }
  ];

  return buildLineup({
    fixedStepMs,
    seed: 20261005,
    red: ["red.blade", "red.lancer", "red.caster", "red.bomber"],
    blue: ["blue.skirmisher", "blue.hexer", "blue.shrieker", "blue.rune"],
    props
  });
}

export function characterById(id: string): CharacterDef | undefined {
  return CHARACTER_LIBRARY.find((c) => c.id === id);
}
