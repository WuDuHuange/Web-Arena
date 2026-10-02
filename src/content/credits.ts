/**
 * Asset attribution registry.
 *
 * Empty on purpose, and that emptiness is a fact rather than an omission: this build ships
 * no external assets. Every shape is drawn with PixiJS primitives and every sound is
 * synthesised, so there is nothing to attribute yet.
 *
 * It exists now so that the first imported asset has somewhere to go. The architecture
 * baseline requires each public asset to be licence-checked individually, and "we will do
 * that later" is how a shipped build ends up with unattributed art in it.
 *
 * Adding an asset means adding an entry here AND a row in the credits panel. The two are
 * checked against each other by `findUnregisteredAppearances`, so an appearance key that
 * resolves to a real file without a credit is reported rather than silently accepted.
 */

export interface AssetCredit {
  /** The `appearance` key this asset resolves for. */
  readonly appearance: string;
  /** Human title of the work. */
  readonly title: string;
  readonly author: string;
  /** Direct link to the source page, not a search result. */
  readonly source: string;
  /** Licence name, and where its text can be read. */
  readonly licence: string;
  /** Acquisition date, ISO 8601. Provenance without a date is not provenance. */
  readonly obtained: string;
}

/** Every credit currently verified. Empty until the asset phase begins. */
export const ASSET_CREDITS: readonly AssetCredit[] = [];

const REQUIRED_FIELDS: readonly (keyof AssetCredit)[] = [
  "appearance",
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
        problems.push(`${credit.appearance || "(未命名)"} 缺少 ${field}`);
      }
    }
  }
  return problems;
}

/**
 * Reports appearance keys that are in use but have no credit entry.
 *
 * Only meaningful once assets exist. While every appearance is procedurally generated this
 * returns everything, which is why the caller decides whether the asset phase has started
 * rather than this function guessing.
 */
export function findUnregisteredAppearances(
  appearances: readonly string[],
  credits: readonly AssetCredit[]
): readonly string[] {
  const registered = new Set(credits.map((credit) => credit.appearance));
  return appearances.filter((key) => !registered.has(key));
}
