import type { BattleSetup } from "../simulation/types.ts";

const STORAGE_KEY = "project-arena.deployment.v1";

/**
 * Deployment persistence.
 *
 * This stores the DEPLOYMENT only, never per-tick battle state: browser storage is not
 * a tick-by-tick data bus. Live battle state stays in memory and is discarded on reset.
 */
export function saveDeployment(setup: BattleSetup): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(setup));
}

export function loadDeployment(): BattleSetup | null {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (raw === null) {
    return null;
  }
  try {
    return JSON.parse(raw) as BattleSetup;
  } catch {
    return null;
  }
}

/** Serialises a deployment for download or hand-off. */
export function exportDeployment(setup: BattleSetup): string {
  return JSON.stringify(setup, null, 2);
}
