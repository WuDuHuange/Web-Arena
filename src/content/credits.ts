/**
 * Asset attribution registry.
 *
 * Two kinds of slot, and they answer different questions:
 *
 *   `appearance`  a character or prop sprite, named by the appearance registry's own key.
 *                 These are cross-checked against the content library, so an appearance key
 *                 that resolves to a real file without a credit is reported rather than
 *                 silently accepted.
 *   `material`    a texture or track the renderer loads directly — the floor, the music.
 *                 There is no appearance key to cross-check, so the credit itself is the
 *                 only record that the licence question was asked and answered.
 *
 * The architecture baseline requires each public asset to be licence-checked individually.
 * "We will do that later" is how a shipped build ends up with unattributed art in it, so the
 * mechanism went in before the first asset did.
 *
 * A credit is not the same thing as an obligation. A CC0 asset needs no attribution at all;
 * it is listed anyway, because "we read the licence and it was CC0" is the fact worth
 * recording, and a registry that lists only the assets legally requiring a row cannot tell a
 * checked asset from an unchecked one.
 */

export type AssetKind = "appearance" | "material";

export interface AssetCredit {
  readonly kind: AssetKind;
  /**
   * The slot this asset fills: an appearance key, or the loader's key for a material.
   *
   * Stable across renames of the file on disk, because it is what the code asks for.
   */
  readonly slot: string;
  /** Human title of the work, as the source names it. */
  readonly title: string;
  readonly author: string;
  /** Direct link to the source page, not a search result. */
  readonly source: string;
  /** Licence name, and where its text can be read. */
  readonly licence: string;
  /** Acquisition date, ISO 8601. Provenance without a date is not provenance. */
  readonly obtained: string;
}

/**
 * Every credit currently verified.
 *
 * Four entries across the two kinds. The materials are the arena floor and the battle loop;
 * the appearances are the two character keys the unit library resolves to. Three of the four
 * are CC0 and therefore owe nothing, and they are listed anyway — the row records that the
 * licence was read, on a date, from the source, and a registry that could not tell a checked
 * asset from an unchecked one would be useless for the question it exists to answer.
 *
 * ⚠️ The music row is not decoration. CC BY 4.0 requires attribution, and it requires it
 * somewhere a visitor can reach: the corner line in the HUD and the 素材署名 block both
 * render from this list, so deleting the row breaks the obligation in two places at once.
 */
export const ASSET_CREDITS: readonly AssetCredit[] = [
  {
    kind: "material",
    slot: "ground.earth",
    title: "Ground051",
    author: "ambientCG",
    source: "https://ambientcg.com/a/Ground051",
    licence: "CC0 1.0 Universal — https://creativecommons.org/publicdomain/zero/1.0/",
    obtained: "2026-10-13"
  },
  {
    kind: "material",
    slot: "music.battle",
    // 魔王魂 names tracks by category and number; the subtitle is what a listener would
    // recognise, so both are recorded rather than either alone.
    title: "8bit27（キャロットマンステージ）",
    author: "森田交一 / 魔王魂",
    source: "https://maou.audio/bgm_8bit27/",
    licence: "CC BY 4.0 — https://creativecommons.org/licenses/by/4.0/",
    obtained: "2026-10-13"
  },
  {
    kind: "appearance",
    slot: "toon-robot",
    // One row per appearance key rather than one row per pack. The pack ships both
    // characters, but a slot is what the code asks for, and a single row covering two keys
    // would leave `findUnregisteredAppearances` unable to say which of them was checked.
    title: "Toon Characters — Robot（idle / attack）",
    author: "Kenney",
    source: "https://kenney.nl/assets/toon-characters",
    licence: "CC0 1.0 Universal — https://creativecommons.org/publicdomain/zero/1.0/",
    obtained: "2026-10-14"
  },
  {
    kind: "appearance",
    slot: "toon-zombie",
    title: "Toon Characters — Zombie（idle / attack）",
    author: "Kenney",
    source: "https://kenney.nl/assets/toon-characters",
    licence: "CC0 1.0 Universal — https://creativecommons.org/publicdomain/zero/1.0/",
    obtained: "2026-10-14"
  }
];

const REQUIRED_FIELDS: readonly (keyof AssetCredit)[] = [
  "kind",
  "slot",
  "title",
  "author",
  "source",
  "licence",
  "obtained"
];

/**
 * Reports credits that are present but incomplete.
 *
 * A half-filled credit is worse than a missing one: it looks like diligence while leaving
 * the actual licence question unanswered.
 */
export function findIncompleteCredits(credits: readonly AssetCredit[]): readonly string[] {
  const problems: string[] = [];
  for (const credit of credits) {
    for (const field of REQUIRED_FIELDS) {
      const value = credit[field];
      if (typeof value !== "string" || value.trim().length === 0) {
        problems.push(`${credit.slot || "(未命名)"} 缺少 ${field}`);
      }
    }
  }
  return problems;
}

/**
 * Reports appearance keys that are in use but have no credit entry.
 *
 * Only appearance-kind credits count. A material credit names a texture the renderer loads
 * directly and carries no appearance key, so counting it here would let it stand in for a
 * sprite that was never licensed.
 */
export function findUnregisteredAppearances(
  appearances: readonly string[],
  credits: readonly AssetCredit[]
): readonly string[] {
  const registered = new Set(
    credits.filter((credit) => credit.kind === "appearance").map((credit) => credit.slot)
  );
  return appearances.filter((key) => !registered.has(key));
}
