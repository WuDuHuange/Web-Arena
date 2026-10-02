import type { BattleSetup, CombatProfile, SpawnDef } from "../simulation/types.ts";
import type { AbilitySpec, BuffSpec } from "../simulation/types.ts";
import { BUFF_LIBRARY, CHARACTER_LIBRARY, CONTENT_LIBRARY, PROP_LIBRARY } from "./library.ts";
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

/**
 * The simulation-relevant projection of every character in the library.
 *
 * `tags` is carried through deliberately. Dropping it here would leave the capability
 * table in the core with nothing to interpret — the tags would validate, render in the
 * content panel and then do absolutely nothing, which is the failure mode that is hardest
 * to notice because every part of the system looks correct on its own.
 */
export function combatProfiles(): readonly CombatProfile[] {
  return CHARACTER_LIBRARY.map((c) => ({
    id: c.id,
    abilityIds: c.abilityIds,
    speed: c.speed,
    aggroRange: c.aggroRange,
    tags: c.tags ?? []
  }));
}

/** Every ability in the library, keyed by the id the character list references. */
export function abilitySpecs(): readonly AbilitySpec[] {
  return CONTENT_LIBRARY.abilities.map((a) => a.spec);
}

/** Every timed effect in the library, so a battle can resolve an `appliesBuff` id. */
export function buffSpecs(): readonly BuffSpec[] {
  return BUFF_LIBRARY;
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
 * Turns placements into spawns.
 *
 * An unknown placement id is skipped rather than thrown on: it is a content bug the
 * validator is expected to have caught, and one missing prop should not make the whole
 * arena fail to build.
 */
function propSpawns(placements: readonly PropPlacement[]): SpawnDef[] {
  const out: SpawnDef[] = [];
  for (const placement of placements) {
    const definition = PROP_LIBRARY.find((p) => p.id === placement.id);
    if (!definition) {
      continue;
    }
    out.push(propSpawn(placement, definition));
  }
  return out;
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
  spawns.push(...propSpawns(options.props ?? []));

  return {
    seed: options.seed ?? 20261002,
    fixedStepMs: options.fixedStepMs,
    bounds: ARENA_BOUNDS,
    spawns,
    abilities: abilitySpecs(),
    buffs: buffSpecs(),
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

const RED_ROTATION = ["red.blade", "red.lancer", "red.caster", "red.bomber"] as const;
const BLUE_ROTATION = ["blue.skirmisher", "blue.hexer", "blue.shrieker", "blue.rune"] as const;

/**
 * The architecture's stated stress case: 100 characters plus 20 field objects.
 *
 * `buildLineup` cannot express this. It lays a side out as a single column, so 50 units
 * would need a 2700-unit-tall arena; this grids each side instead, which is also closer to
 * how a crowded battle actually looks.
 *
 * The traps sit in a middle band, clear of both spawn grids. A trap overlapping a spawn
 * would apply its effect before anyone could move, which measures the solver's
 * deep-penetration resolution rather than the frame rate this scene exists to measure.
 */
export function stressMatchup(fixedStepMs: number, perSide = 50): BattleSetup {
  const spawns: SpawnDef[] = [];
  const columns = 5;
  const rows = Math.ceil(perSide / columns);

  const place = (
    faction: "red" | "blue",
    ids: readonly string[],
    facing: number,
    baseX: number,
    /** Column step. Negative for the side that marches leftward. */
    step: number
  ): void => {
    for (let i = 0; i < perSide; i += 1) {
      const id = ids[i % ids.length];
      if (id === undefined) {
        continue;
      }
      const character = characterById(id);
      if (!character) {
        continue;
      }
      const column = Math.floor(i / rows);
      const row = i % rows;
      spawns.push({
        kind: "unit",
        faction,
        // Columns step inward from the edge, rows run down the field. The step has to
        // point away from the wall: five columns at 28 units starting from x=900 puts the
        // last one at 1012, which is outside a 960-wide arena, and the unit spawns in the
        // wall before the battle even starts.
        x: baseX + column * step,
        y: 40 + row * 58,
        radius: character.radius,
        mass: character.mass,
        hp: character.hp,
        facing,
        characterId: character.id,
        appearance: character.appearance,
        tags: []
      });
    }
  };

  place("red", RED_ROTATION, 0, 60, 28);
  place("blue", BLUE_ROTATION, Math.PI, 900, -28);

  const mid = ARENA_BOUNDS.height / 2;
  const kinds = [
    "prop.lava",
    "prop.conveyor",
    "prop.spring",
    "prop.barrel",
    "prop.spike",
    "prop.turret",
    "prop.shrine"
  ];
  const props: PropPlacement[] = [];
  for (let i = 0; i < 20; i += 1) {
    const id = kinds[i % kinds.length];
    if (id === undefined) {
      continue;
    }
    props.push({
      id,
      x: 300 + (i % 5) * 90,
      y: mid - 180 + Math.floor(i / 5) * 90,
      facing: i % 2 === 0 ? 0 : Math.PI
    });
  }

  return {
    seed: 20261007,
    fixedStepMs,
    bounds: ARENA_BOUNDS,
    spawns: [...spawns, ...propSpawns(props)],
    abilities: abilitySpecs(),
    buffs: buffSpecs(),
    characters: combatProfiles()
  };
}

export function characterById(id: string): CharacterDef | undefined {
  return CHARACTER_LIBRARY.find((c) => c.id === id);
}
