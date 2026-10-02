import { distance } from "../simulation/geometry.ts";
import type { Faction } from "../simulation/types.ts";

/**
 * The authored deployment, before it becomes a battle.
 *
 * A draft is what the player builds by dragging; a `BattleSetup` is what the simulation
 * consumes. Keeping them as two separate types rather than letting the editor mutate a
 * `BattleSetup` is the whole safety property of this module: `BattleSetup` is immutable and
 * is the thing a reset restores, so anything the editor touches has to be a different
 * object or "reset" and "keep editing" become the same operation.
 *
 * Everything here is pure. No DOM, no Pixi, no React — so "does a unit placed here count
 * as overlapping" is answerable in `node --test` without a browser.
 */

/** One unit the player has placed. `key` is stable identity for selection and React. */
export interface UnitPlacement {
  readonly key: string;
  readonly characterId: string;
  readonly faction: Faction;
  /** World units. Never screen pixels, so zoom and window size cannot change the result. */
  readonly x: number;
  readonly y: number;
  /** Heading in radians. Red faces +x, blue faces -x by default. */
  readonly facing: number;
  /**
   * Tags carried by the spawn rather than by the character.
   *
   * The editor has no UI for these, and that is on purpose — a scenario that fields an
   * armoured blade without editing the character definition is a scenario concern, not a
   * player concern. They are carried anyway so that importing such a deployment and then
   * nudging one unit does not silently strip every spawn-level override in the file.
   */
  readonly tags?: readonly string[];
}

/** One field object the player has placed. */
export interface PropPlacementEntry {
  readonly key: string;
  readonly propId: string;
  readonly x: number;
  readonly y: number;
  readonly facing: number;
}

export interface DeploymentDraft {
  readonly units: readonly UnitPlacement[];
  readonly props: readonly PropPlacementEntry[];
}

export interface DraftBounds {
  readonly width: number;
  readonly height: number;
}

/**
 * The radii the validator needs.
 *
 * Passed in rather than imported so this module stays free of the content library: a test
 * can hand it two numbers, and the app hands it the real catalogue. The same reason
 * `BattleSetup` carries its abilities.
 */
export interface DraftCatalog {
  readonly unitRadius: (characterId: string) => number | undefined;
  /**
   * The radius of a prop's *collider*, not of its effect.
   *
   * These are different numbers on purpose — lava is 54 units of effect around a 10-unit
   * body — and only the collider can push a unit out of position. Validating against the
   * effect radius would forbid placing a unit anywhere near a trap, which is the opposite
   * of what a trap is for.
   */
  readonly propBodyRadius: (propId: string) => number | undefined;
  /**
   * The radius of a prop's effect footprint, which is what the player sees and therefore
   * what they can click on.
   *
   * Clicking a lava pool anywhere inside the pool has to select the pool, or a 10-unit body
   * inside a 54-unit disc becomes a pixel-hunt. Units are hit-tested first, so this does not
   * steal clicks from a unit standing in the hazard.
   */
  readonly propEffectRadius: (propId: string) => number | undefined;
}

export type DraftIssueLevel = "error" | "warning";

export interface DraftIssue {
  readonly level: DraftIssueLevel;
  readonly message: string;
  /** Placement this issue is about, when it is about one. */
  readonly key?: string;
}

export const EMPTY_DRAFT: DeploymentDraft = { units: [], props: [] };

/**
 * How far apart two placed units must be, as a fraction of their touching distance.
 *
 * Exactly touching is legal but produces a solver deep-penetration resolution on tick 0,
 * which makes the opening of a battle depend on how the engine resolves an overlap rather
 * than on the deployment. A small margin removes that entirely.
 */
const SEPARATION_MARGIN = 1.05;

/**
 * How far outside its body a placement still counts as clicked, in world units.
 *
 * A unit is grabbed with a little slack, so a 12-unit-radius body is not a pixel-hunt. A
 * prop is grabbed at its effect footprint — see `DraftCatalog.propEffectRadius` — with this
 * value as a floor, so even a mechanism with a tiny effect area is still clickable.
 */
const UNIT_GRAB_SLOP = 6;
const PROP_MIN_GRAB = 14;

export function isDraftEmpty(draft: DeploymentDraft): boolean {
  return draft.units.length === 0 && draft.props.length === 0;
}

/** Factions that have at least one unit placed. */
export function draftFactions(draft: DeploymentDraft): readonly Faction[] {
  const seen = new Set<Faction>();
  for (const unit of draft.units) {
    seen.add(unit.faction);
  }
  return [...seen];
}

/**
 * Whether the draft can be fought.
 *
 * A battle needs two sides. Starting one with a single faction resolves on tick 0 —
 * `isDecided` sees one survivor faction — and the app would jump straight to 已分胜负 on an
 * arena where nothing happened. That reads as a bug rather than as "you have not placed an
 * opponent yet", so it is refused up front with a reason.
 */
export function draftReadiness(draft: DeploymentDraft): { ready: boolean; reason: string } {
  const factions = draftFactions(draft);
  if (factions.length === 0) {
    return { ready: false, reason: "还没有放置任何单位" };
  }
  if (factions.length === 1) {
    return {
      ready: false,
      reason: `只有${factionLabel(factions[0])}方有单位，需要双方都有才能开战`
    };
  }
  return { ready: true, reason: "" };
}

function factionLabel(faction: Faction | undefined): string {
  switch (faction) {
    case "red":
      return "红";
    case "blue":
      return "蓝";
    default:
      return "中立";
  }
}

/** Default heading for a freshly placed unit: point it at the opposing side. */
export function defaultFacing(faction: Faction): number {
  return faction === "red" ? 0 : Math.PI;
}

/**
 * Checks a draft before it is allowed to become a battle.
 *
 * The architecture asks for exactly this — "开战前检查越界与非法重叠" — and the reason it
 * has to happen before the battle rather than during it is that neither failure is visible
 * as a failure once the simulation starts. A unit outside the wall is ejected by the solver
 * and looks like it spawned late. Two units on the same spot are separated by the solver and
 * look like one unit. Both produce a battle that runs and is wrong.
 */
export function validateDraft(
  draft: DeploymentDraft,
  bounds: DraftBounds,
  catalog: DraftCatalog
): readonly DraftIssue[] {
  const issues: DraftIssue[] = [];

  // Props are checked first so the unit pass can report a unit sitting inside a prop body.
  const bodies: { key: string; x: number; y: number; radius: number; label: string }[] = [];

  for (const prop of draft.props) {
    const radius = catalog.propBodyRadius(prop.propId) ?? 0;
    if (radius <= 0) {
      issues.push({ level: "error", message: `未知机关「${prop.propId}」`, key: prop.key });
      continue;
    }
    if (!insideBounds(prop.x, prop.y, radius, bounds)) {
      issues.push({ level: "error", message: "机关超出了场地边界", key: prop.key });
      continue;
    }

    // Props are solid to each other as well. Their colliders are fixed bodies, so two in the
    // same place are not pushed apart by the solver — they sit inside one another and jitter
    // every unit that walks past. The effect radii are irrelevant here: two overlapping lava
    // pools are a legitimate design, two overlapping colliders are not.
    let clash = false;
    for (const other of bodies) {
      if (distance(prop, other) < (radius + other.radius) * SEPARATION_MARGIN) {
        issues.push({ level: "error", message: `与${other.label}的实体重叠`, key: prop.key });
        clash = true;
        break;
      }
    }
    if (clash) {
      continue;
    }

    bodies.push({ key: prop.key, x: prop.x, y: prop.y, radius, label: "机关" });
  }

  const placed: { key: string; x: number; y: number; radius: number }[] = [];

  for (const unit of draft.units) {
    const radius = catalog.unitRadius(unit.characterId);
    if (radius === undefined) {
      issues.push({ level: "error", message: `未知兵装「${unit.characterId}」`, key: unit.key });
      continue;
    }

    if (!insideBounds(unit.x, unit.y, radius, bounds)) {
      issues.push({ level: "error", message: "单位超出了场地边界", key: unit.key });
      continue;
    }

    // A unit placed inside a prop's body is pushed out by the solver on the first tick. The
    // effect radius is irrelevant here — standing in lava is the point of lava.
    for (const body of bodies) {
      if (distance(unit, body) < (radius + body.radius) * SEPARATION_MARGIN) {
        issues.push({
          level: "error",
          message: `与${body.label}的实体重叠`,
          key: unit.key
        });
        break;
      }
    }

    for (const other of placed) {
      if (distance(unit, other) < (radius + other.radius) * SEPARATION_MARGIN) {
        issues.push({ level: "error", message: "与另一个单位重叠", key: unit.key });
        break;
      }
    }

    placed.push({ key: unit.key, x: unit.x, y: unit.y, radius });
  }

  return issues;
}

function insideBounds(x: number, y: number, radius: number, bounds: DraftBounds): boolean {
  return x - radius >= 0 && x + radius <= bounds.width && y - radius >= 0 && y + radius <= bounds.height;
}

/**
 * Rebuilds a draft from a built deployment.
 *
 * This is what makes import round-trip. Without it, exporting a hand-authored deployment and
 * reading it back would produce a field you can fight on but cannot edit — every unit would
 * have lost its identity, so the first drag would start from nothing.
 *
 * Spawns without a character are skipped: a projectile is not something a player placed.
 */
export function draftFromSetup(
  setup: {
    readonly spawns: readonly {
      readonly kind: string;
      readonly faction: Faction;
      readonly x: number;
      readonly y: number;
      readonly facing?: number;
      readonly characterId?: string;
      readonly tags?: readonly string[];
      readonly behavior?: unknown;
    }[];
    readonly bounds: DraftBounds;
  },
  propIdOf: (behavior: unknown) => string | undefined
): DeploymentDraft {
  const units: UnitPlacement[] = [];
  const props: PropPlacementEntry[] = [];
  let index = 0;

  for (const spawn of setup.spawns) {
    if (spawn.characterId) {
      const tags = spawn.tags ?? [];
      units.push({
        key: `imported-u${index}`,
        characterId: spawn.characterId,
        faction: spawn.faction,
        x: spawn.x,
        y: spawn.y,
        facing: spawn.facing ?? defaultFacing(spawn.faction),
        ...(tags.length > 0 ? { tags } : {})
      });
      index += 1;
      continue;
    }
    if (spawn.behavior) {
      const propId = propIdOf(spawn.behavior);
      if (propId) {
        props.push({
          key: `imported-p${index}`,
          propId,
          x: spawn.x,
          y: spawn.y,
          facing: spawn.facing ?? 0
        });
        index += 1;
      }
    }
  }

  return { units, props };
}

/** A one-line description for the panel. */
export function summariseDraft(draft: DeploymentDraft): string {
  const red = draft.units.filter((u) => u.faction === "red").length;
  const blue = draft.units.filter((u) => u.faction === "blue").length;
  return `红 ${red} · 蓝 ${blue} · 机关 ${draft.props.length}`;
}

// --- Editing operations ------------------------------------------------------
//
// Every one of these returns a new draft rather than mutating the current one. The draft is
// React state and the preview is rebuilt from it, so an in-place edit would change the data
// without changing what is on screen — the exact class of bug that makes an editor feel
// broken while every unit test of the underlying maths still passes.

/** The smallest unused `prefix + n`. Derived from the draft, so tests get stable keys. */
function nextKey(draft: DeploymentDraft, prefix: string): string {
  let highest = 0;
  const scan = (keys: readonly string[]): void => {
    for (const key of keys) {
      if (!key.startsWith(prefix)) {
        continue;
      }
      const n = Number(key.slice(prefix.length));
      if (Number.isInteger(n) && n > highest) {
        highest = n;
      }
    }
  };
  scan(draft.units.map((u) => u.key));
  scan(draft.props.map((p) => p.key));
  return `${prefix}${highest + 1}`;
}

function clamp(value: number, low: number, high: number): number {
  // Written so it still behaves when the low bound is above the high one, which happens when
  // a body is wider than the arena. Returning the low bound puts it inside the wall rather
  // than outside, and the validator reports the overlap instead of a spawn failure.
  const upper = Math.max(low, high);
  return Math.min(Math.max(value, low), upper);
}

/** Every occupied body, for the free-spot search and the overlap rules. */
function occupiedBodies(
  draft: DeploymentDraft,
  catalog: DraftCatalog
): { x: number; y: number; radius: number }[] {
  const out: { x: number; y: number; radius: number }[] = [];
  for (const unit of draft.units) {
    const radius = catalog.unitRadius(unit.characterId);
    if (radius !== undefined) {
      out.push({ x: unit.x, y: unit.y, radius });
    }
  }
  for (const prop of draft.props) {
    const radius = catalog.propBodyRadius(prop.propId);
    if (radius !== undefined) {
      out.push({ x: prop.x, y: prop.y, radius });
    }
  }
  return out;
}

/**
 * A legal position for a new placement, near `preferX`.
 *
 * Adding a unit from the palette should not immediately produce a validation error. The
 * alternative — dropping everything at a fixed point and letting the player sort it out —
 * means the first thing a new user sees is a red ring, which reads as "this is broken"
 * rather than "move it".
 */
function findFreeSpot(
  draft: DeploymentDraft,
  radius: number,
  bounds: DraftBounds,
  catalog: DraftCatalog,
  preferX: number
): { x: number; y: number } {
  const occupied = occupiedBodies(draft, catalog);
  const step = Math.max(radius * 3.4, 34);
  const centreY = bounds.height / 2;
  const rows = Math.ceil(bounds.height / step) + 1;
  // March inward from the preferred edge, then across the field, then from the other edge.
  const inward = preferX <= bounds.width / 2 ? 1 : -1;

  for (let column = 0; column < 16; column += 1) {
    const x = preferX + column * step * inward;
    if (x - radius < 0 || x + radius > bounds.width) {
      break;
    }
    for (let row = 0; row < rows; row += 1) {
      // Rows run outward from the midline in both directions, so the first unit lands in the
      // middle of its own edge rather than in a corner.
      const offsets = row === 0 ? [0] : [row, -row];
      for (const offset of offsets) {
        const y = centreY + offset * step;
        if (y - radius < 0 || y + radius > bounds.height) {
          continue;
        }
        const clear = occupied.every(
          (body) => distance({ x, y }, body) >= (radius + body.radius) * SEPARATION_MARGIN
        );
        if (clear) {
          return { x, y };
        }
      }
    }
  }

  // The field is full. Return a position inside the wall anyway: the validator reports the
  // overlap with a name attached, which is more useful than a unit spawned into the wall
  // where the symptom looks like a physics bug.
  return {
    x: clamp(preferX, radius, bounds.width - radius),
    y: clamp(centreY, radius, bounds.height - radius)
  };
}

/** Adds a unit and returns the draft plus the new placement's key, for selection. */
export function addUnit(
  draft: DeploymentDraft,
  characterId: string,
  faction: Faction,
  bounds: DraftBounds,
  catalog: DraftCatalog
): { draft: DeploymentDraft; key: string } {
  const radius = catalog.unitRadius(characterId);
  if (radius === undefined) {
    return { draft, key: "" };
  }

  const preferX = faction === "red" ? bounds.width * 0.09 : bounds.width * 0.91;
  const spot = findFreeSpot(draft, radius, bounds, catalog, preferX);
  const key = nextKey(draft, "u");

  return {
    draft: {
      units: [
        ...draft.units,
        { key, characterId, faction, x: spot.x, y: spot.y, facing: defaultFacing(faction) }
      ],
      props: draft.props
    },
    key
  };
}

/** Adds a field object and returns the draft plus its key. */
export function addProp(
  draft: DeploymentDraft,
  propId: string,
  bounds: DraftBounds,
  catalog: DraftCatalog
): { draft: DeploymentDraft; key: string } {
  const radius = catalog.propBodyRadius(propId);
  if (radius === undefined) {
    return { draft, key: "" };
  }

  const spot = findFreeSpot(draft, radius, bounds, catalog, bounds.width / 2);
  const key = nextKey(draft, "p");

  return {
    draft: {
      units: draft.units,
      props: [...draft.props, { key, propId, x: spot.x, y: spot.y, facing: 0 }]
    },
    key
  };
}

/**
 * Moves a placement, keeping its body inside the wall.
 *
 * Clamping here rather than at validation time is what makes dragging feel solid: a unit
 * that follows the cursor past the wall and then snaps back on release looks like a bug,
 * and the boundary is the one rule the player cannot learn from the arena floor.
 */
export function movePlacement(
  draft: DeploymentDraft,
  key: string,
  x: number,
  y: number,
  bounds: DraftBounds,
  catalog: DraftCatalog
): DeploymentDraft {
  const unit = draft.units.find((u) => u.key === key);
  if (unit) {
    const radius = catalog.unitRadius(unit.characterId) ?? 0;
    const nx = clamp(x, radius, bounds.width - radius);
    const ny = clamp(y, radius, bounds.height - radius);
    return {
      units: draft.units.map((u) => (u.key === key ? { ...u, x: nx, y: ny } : u)),
      props: draft.props
    };
  }

  const prop = draft.props.find((p) => p.key === key);
  if (!prop) {
    return draft;
  }
  const radius = catalog.propBodyRadius(prop.propId) ?? 0;
  const nx = clamp(x, radius, bounds.width - radius);
  const ny = clamp(y, radius, bounds.height - radius);
  return {
    units: draft.units,
    props: draft.props.map((p) => (p.key === key ? { ...p, x: nx, y: ny } : p))
  };
}

/** Turns a placement by `delta` radians, normalised into [0, 2π). */
export function rotatePlacement(draft: DeploymentDraft, key: string, delta: number): DeploymentDraft {
  const turn = (facing: number): number => {
    const next = (facing + delta) % (Math.PI * 2);
    return next < 0 ? next + Math.PI * 2 : next;
  };
  return {
    units: draft.units.map((u) => (u.key === key ? { ...u, facing: turn(u.facing) } : u)),
    props: draft.props.map((p) => (p.key === key ? { ...p, facing: turn(p.facing) } : p))
  };
}

/** Removes a placement. A key that is not present is not an error. */
export function removePlacement(draft: DeploymentDraft, key: string): DeploymentDraft {
  return {
    units: draft.units.filter((u) => u.key !== key),
    props: draft.props.filter((p) => p.key !== key)
  };
}

/**
 * The placement under a world-space point, if any.
 *
 * Units are tested before props, and each list is walked backwards, because that is the
 * order the renderer draws them in: later placements sit on top, and units sit over the
 * floor. A hit test that disagrees with what is drawn means clicking the thing you can see
 * and getting the thing underneath it.
 */
export function hitTestDraft(
  draft: DeploymentDraft,
  catalog: DraftCatalog,
  x: number,
  y: number
): string | undefined {
  const point = { x, y };

  for (let i = draft.units.length - 1; i >= 0; i -= 1) {
    const unit = draft.units[i];
    if (!unit) {
      continue;
    }
    const radius = catalog.unitRadius(unit.characterId);
    if (radius !== undefined && distance(point, unit) <= radius + UNIT_GRAB_SLOP) {
      return unit.key;
    }
  }

  for (let i = draft.props.length - 1; i >= 0; i -= 1) {
    const prop = draft.props[i];
    if (!prop) {
      continue;
    }
    const effect = catalog.propEffectRadius(prop.propId) ?? 0;
    const body = catalog.propBodyRadius(prop.propId) ?? 0;
    if (distance(point, prop) <= Math.max(effect, body, PROP_MIN_GRAB)) {
      return prop.key;
    }
  }

  return undefined;
}

/**
 * The position of a placement, or `undefined` if the key is not in the draft.
 *
 * The editor needs this for two things: the offset between a cursor and the body it grabbed,
 * so a drag does not snap the body to the pointer, and arrow-key nudging, which is relative
 * to where the thing already is.
 */
export function findPlacement(
  draft: DeploymentDraft,
  key: string
): { readonly x: number; readonly y: number } | undefined {
  const unit = draft.units.find((u) => u.key === key);
  if (unit) {
    return unit;
  }
  return draft.props.find((p) => p.key === key);
}

/** Groups issues by the placement they concern, for the red rings and the panel. */export function issuesByKey(issues: readonly DraftIssue[]): Map<string, DraftIssue[]> {
  const out = new Map<string, DraftIssue[]>();
  for (const issue of issues) {
    if (!issue.key) {
      continue;
    }
    const list = out.get(issue.key);
    if (list) {
      list.push(issue);
    } else {
      out.set(issue.key, [issue]);
    }
  }
  return out;
}
