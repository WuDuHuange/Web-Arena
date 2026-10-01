import type { BattleSetup, CombatProfile, SpawnDef } from "../simulation/types.ts";
import type { AbilitySpec } from "../simulation/types.ts";
import { CHARACTER_LIBRARY, CONTENT_LIBRARY } from "./library.ts";
import type { CharacterDef } from "./schema.ts";

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

export function characterById(id: string): CharacterDef | undefined {
  return CHARACTER_LIBRARY.find((c) => c.id === id);
}
