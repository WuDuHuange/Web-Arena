import type { ContentLibrary } from "./schema.ts";

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

export interface ValidationResult {
  readonly ok: boolean;
  readonly issues: readonly ValidationIssue[];
}

/**
 * Validates a content library BEFORE a battle starts, so structural mistakes surface
 * as a clear message instead of a runtime failure mid-fight.
 *
 * Currently enforced: duplicate ids, empty ids, and dangling ability references.
 */
export function validateContent(library: ContentLibrary): ValidationResult {
  const issues: ValidationIssue[] = [];

  const abilityIds = new Set<string>();
  for (const ability of library.abilities) {
    if (ability.id.length === 0) {
      issues.push({ path: "abilities", message: "ability id must not be empty" });
      continue;
    }
    if (abilityIds.has(ability.id)) {
      issues.push({ path: `abilities.${ability.id}`, message: "duplicate ability id" });
      continue;
    }
    abilityIds.add(ability.id);
  }

  const characterIds = new Set<string>();
  for (const character of library.characters) {
    if (characterIds.has(character.id)) {
      issues.push({ path: `characters.${character.id}`, message: "duplicate character id" });
    } else {
      characterIds.add(character.id);
    }

    for (const ref of character.abilityIds) {
      if (!abilityIds.has(ref)) {
        issues.push({
          path: `characters.${character.id}.abilityIds`,
          message: `dangling ability reference "${ref}"`
        });
      }
    }
  }

  const propIds = new Set<string>();
  for (const prop of library.props) {
    if (propIds.has(prop.id)) {
      issues.push({ path: `props.${prop.id}`, message: "duplicate prop id" });
      continue;
    }
    propIds.add(prop.id);
  }

  return { ok: issues.length === 0, issues };
}
