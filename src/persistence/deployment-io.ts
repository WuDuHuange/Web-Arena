import type { BattleSetup } from "../simulation/types.ts";

/**
 * Deployment import.
 *
 * An exported deployment is a JSON file the user can open in an editor, so it comes back
 * as untrusted input. Feeding a malformed setup straight into the simulation produces a
 * blank arena or a world full of NaN, and neither symptom points at the file that caused
 * it. This checks the shape first and reports problems in the same vocabulary as the
 * content validator: a path and a sentence.
 *
 * Deliberately strict about the fields the simulation reads and silent about the rest, so
 * a future field can be added to the format without this becoming the thing that blocks it.
 */

export interface DeploymentParseResult {
  readonly ok: boolean;
  /** Non-null only when `ok` is true. */
  readonly setup: BattleSetup | null;
  readonly issues: readonly string[];
}

/** A deployment beyond this size is a mistake or an attack, not a lineup. */
const MAX_SPAWNS = 2000;
/** Reporting every problem in a 2000-entry file helps nobody; the first batch is enough. */
const MAX_REPORTED = 12;

const VALID_KINDS = new Set(["unit", "prop", "projectile"]);
const VALID_FACTIONS = new Set(["red", "blue", "neutral"]);

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses and validates a deployment JSON string.
 *
 * Returns issues rather than throwing: a bad file is an expected event with a user-facing
 * explanation, not an exceptional one.
 */
export function parseDeployment(text: string): DeploymentParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, setup: null, issues: ["文件不是合法的 JSON"] };
  }

  if (!isRecord(raw)) {
    return { ok: false, setup: null, issues: ["顶层必须是一个对象"] };
  }

  const issues: string[] = [];

  if (!isFiniteNumber(raw.seed)) {
    issues.push("seed 必须是有限数字");
  }
  if (!isFiniteNumber(raw.fixedStepMs) || raw.fixedStepMs <= 0) {
    issues.push("fixedStepMs 必须是正数");
  }

  if (!isRecord(raw.bounds)) {
    issues.push("bounds 必须是 { width, height }");
  } else if (
    !isFiniteNumber(raw.bounds.width) ||
    !isFiniteNumber(raw.bounds.height) ||
    raw.bounds.width <= 0 ||
    raw.bounds.height <= 0
  ) {
    issues.push("bounds.width 与 bounds.height 必须是正数");
  }

  if (!Array.isArray(raw.abilities)) {
    issues.push("abilities 必须是数组（没有技能时给空数组）");
  }

  if (!Array.isArray(raw.spawns)) {
    issues.push("spawns 必须是数组");
  } else if (raw.spawns.length === 0) {
    issues.push("spawns 不能为空，否则战场上一个实体都没有");
  } else if (raw.spawns.length > MAX_SPAWNS) {
    issues.push(`spawns 有 ${raw.spawns.length} 项，超过上限 ${MAX_SPAWNS}`);
  } else {
    raw.spawns.forEach((spawn, index) => {
      const at = `spawns[${index}]`;
      if (!isRecord(spawn)) {
        issues.push(`${at} 不是对象`);
        return;
      }
      if (typeof spawn.kind !== "string" || !VALID_KINDS.has(spawn.kind)) {
        issues.push(`${at}.kind 必须是 unit / prop / projectile`);
      }
      if (typeof spawn.faction !== "string" || !VALID_FACTIONS.has(spawn.faction)) {
        issues.push(`${at}.faction 必须是 red / blue / neutral`);
      }
      for (const key of ["x", "y", "radius", "mass", "hp"]) {
        if (!isFiniteNumber(spawn[key])) {
          issues.push(`${at}.${key} 必须是有限数字`);
        }
      }
      // Zero radius or zero mass degenerates the solver rather than failing loudly, so it
      // is checked here instead of being discovered as jitter later.
      if (isFiniteNumber(spawn.radius) && spawn.radius <= 0) {
        issues.push(`${at}.radius 必须大于 0`);
      }
      if (isFiniteNumber(spawn.mass) && spawn.mass <= 0) {
        issues.push(`${at}.mass 必须大于 0`);
      }
      if (isFiniteNumber(spawn.hp) && spawn.hp < 0) {
        issues.push(`${at}.hp 不能为负`);
      }
    });
  }

  if (issues.length > 0) {
    return { ok: false, setup: null, issues: issues.slice(0, MAX_REPORTED) };
  }

  // Every field the simulation reads has been checked above; the cast only carries the
  // optional fields this validator deliberately does not police.
  return { ok: true, setup: raw as unknown as BattleSetup, issues: [] };
}

export interface DeploymentSummary {
  readonly units: number;
  readonly props: number;
  readonly bounds: string;
}

/** One-line description of a deployment, for the panel after an import. */
export function summariseDeployment(setup: BattleSetup): DeploymentSummary {
  const units = setup.spawns.filter((s) => s.kind === "unit").length;
  const props = setup.spawns.filter((s) => s.kind === "prop").length;
  return {
    units,
    props,
    bounds: `${setup.bounds.width}×${setup.bounds.height}`
  };
}
