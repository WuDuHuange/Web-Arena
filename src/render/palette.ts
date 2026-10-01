import type { Faction } from "../simulation/types.ts";

/** Team readability colours. Kept in one place so the core never knows about colour. */
export function factionColor(faction: Faction): number {
  switch (faction) {
    case "red":
      return 0xe0554b;
    case "blue":
      return 0x4b8fe0;
    case "neutral":
      return 0x9aa4b2;
  }
}
