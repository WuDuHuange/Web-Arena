/**
 * Appearance resolution: which art a key draws, and what happens when it cannot.
 *
 * Every entity already carries a `render.appearance` string. Until now the renderer ignored
 * it completely — the key was authored, validated, exported, listed in the credits panel and
 * then never read. That is the failure mode this module exists to end, and it is worth being
 * precise about why the old behaviour was not merely incomplete but *undetectable*:
 *
 *   - **Nothing is authored.** The correct rendering is the procedural greybox.
 *   - **Art is authored and still loading.** Must not look like greybox.
 *   - **Art is authored and failed to load.** Must not look like greybox either.
 *
 * Collapsing the last two into the first is how "the art is broken" becomes indistinguishable
 * from "there is no art", which is exactly the silent degradation the architecture's Phase 3
 * gate forbids ("缺失资源有可见降级"). So the three states are separate types, the decision
 * is one pure function, and the renderer only executes what that function returns.
 *
 * The module lives under `content/` rather than `render/` because that is what it is: the
 * mapping from a content key to an art spec, declared alongside the keys themselves in
 * `library.ts`. It imports nothing at all, so `validateContent` can check it without
 * content depending on the renderer, and every rule below is testable under `node --test`.
 */

// --- Specs ------------------------------------------------------------------

/**
 * How an image is placed on the entity that owns it.
 *
 * Separate from the source, because the same file can be drawn two ways — a pose used as a
 * head-on idle and the same pose used as a telegraph want different anchors — and shared by
 * both slots, because both need it.
 *
 * Every field is optional and every default is the behaviour the greybox era already had.
 * That is not laziness: it means turning the art phase on cannot move a unit that was already
 * on screen. A spec that names nothing keeps drawing at its texture's own size, centred, with
 * no flip, which is exactly what the demo fixture did.
 */
export interface ArtPlacement {
  /**
   * Normalised anchor, `0..1` of the frame.
   *
   * `{ x: 0.5, y: 1 }` puts the bottom centre of the image on the unit's projected position,
   * which is where a standing character's feet are. The default — the centre — is right for a
   * symmetric marker and wrong for a portrait: a 128-pixel figure anchored at its middle
   * floats half its own height above the floor, and no amount of depth sorting fixes that.
   */
  readonly anchor?: { readonly x: number; readonly y: number };
  /**
   * The height the image is drawn at, in world units.
   *
   * Optional, and its absence is meaningful: an image with no height is drawn at one texture
   * pixel per world unit, which is the mapping the fixtures were tuned against. Real art has
   * to be told, because a 128-pixel portrait is not 128 world units tall — the whole arena is
   * only a few hundred units across.
   */
  readonly height?: number;
  /**
   * How the image answers the unit's facing.
   *
   * `mirror` flips it horizontally when the unit points left on screen, so a pose drawn
   * facing right reads as facing its target. `none` — the default — is for head-on art, where
   * the flip is invisible and the branch would only be a lie about what the art can express.
   */
  readonly facing?: "none" | "mirror";
}

/** One image, drawn unchanged for the whole life of the entity. */
export interface SingleFrameSpec extends ArtPlacement {
  readonly kind: "single";
  /**
   * Where the image comes from.
   *
   * Two schemes, and the prefix is what tells them apart: `asset:` names a slot in the asset
   * table — the only form a spec can use, because this module imports nothing and therefore
   * cannot read the glob that owns the hashed paths — and anything else is a URL handed
   * straight to PixiJS's loader, which is what the debug override uses to point a key at a
   * file that is not there.
   */
  readonly source: string;
}

/**
 * A horizontal strip of equal-sized frames, read left to right.
 *
 * A strip rather than an atlas file: it is the format a single-character sprite sheet almost
 * always arrives in, it needs no metadata sidecar, and it can be sliced with one rectangle.
 * A packed atlas is a Phase 5 problem and inventing its format now would be guessing.
 */
export interface SequenceSpec extends ArtPlacement {
  readonly kind: "sequence";
  readonly source: string;
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly frameCount: number;
  /** Milliseconds per frame, on the presentation clock. Never on the simulation tick. */
  readonly frameMs: number;
  /** A looping sequence wraps; a one-shot holds its last frame. */
  readonly loop: boolean;
}

export type AppearanceSpec = SingleFrameSpec | SequenceSpec;

// --- Placement ---------------------------------------------------------------

/** The anchor used when a spec does not name one: the centre of the frame. */
export const DEFAULT_ANCHOR = { x: 0.5, y: 0.5 } as const;

/**
 * Where the image is pinned to the entity, normalised to the frame.
 *
 * Returns a fresh object rather than the shared default, because a PixiJS anchor is a live
 * point: a caller that wrote to the result would otherwise corrupt the default for every
 * other unit on the field, and the symptom would be one unit's sprite drifting while the
 * rest stayed put — a bug with no obvious connection to its cause.
 */
export function anchorOf(spec: AppearanceSpec): { readonly x: number; readonly y: number } {
  const anchor = spec.anchor;
  return anchor ? { x: anchor.x, y: anchor.y } : { ...DEFAULT_ANCHOR };
}

/**
 * The height to draw at, in world units.
 *
 * Falls back to the image's own height, which makes the resulting scale exactly 1 — the
 * behaviour every spec had before this field existed. A non-positive or non-finite height is
 * treated as absent rather than honoured: honouring it would scale the sprite away to
 * nothing, and a unit that vanishes is the failure mode this module exists to make
 * impossible.
 */
export function artHeight(spec: AppearanceSpec, naturalHeight: number): number {
  const height = spec.height;
  if (height === undefined || !Number.isFinite(height) || height <= 0) {
    return naturalHeight;
  }
  return height;
}

/** Whether the image has to be flipped when the unit points left on screen. */
export function mirrorsFacing(spec: AppearanceSpec): boolean {
  return spec.facing === "mirror";
}

/**
 * Everything a key can draw.
 *
 * `attack` exists because a telegraph is the one place where the art carries gameplay
 * information: the renderer already brightens the facing marker during `windup`, and a unit
 * whose sprite visibly changes while winding up is the same idea done properly. It is
 * optional, so a key with one image stays a one-line entry.
 */
export interface AppearanceEntry {
  readonly base: AppearanceSpec;
  readonly attack?: AppearanceSpec;
}

/**
 * The registry.
 *
 * Two entries, one per side, and both are head-on poses rather than directional art. That is
 * a deliberate limit of this first art pass, not an oversight: the pack these came from ships
 * one view per character, and building a four-way facing table around art that cannot express
 * one would be a data model written for a file that does not exist.
 *
 * The anchor and the height are the two numbers that matter, and both were measured from the
 * files rather than chosen by eye:
 *
 *   - **The feet sit on the bottom edge of the frame.** Every pose in the pack has an opaque
 *     bounding box that ends at the last row, so `y: 1` puts the unit's projected position
 *     exactly under its boots and stops a 128-pixel figure from hovering.
 *   - **The height is in world units, not pixels.** A unit's collider is about 26 units
 *     across; art left at its native 128 pixels would stand five times the arena's idea of a
 *     person. 48 units draws a figure roughly one and a half colliders tall, which is what
 *     reads as a body standing on a tile rather than as a portrait pasted over one.
 *
 * `attack` is mirrored and `base` is not. The strike pose is drawn facing right, so flipping
 * it when the unit points left is what makes a wind-up read as aimed at the target rather
 * than away from it. The idle pose is symmetric, where the flip would cost a branch and
 * change no pixel.
 */
const registry: Record<string, AppearanceEntry> = {
  "toon-robot": {
    base: {
      kind: "single",
      source: "asset:robot-idle",
      anchor: { x: 0.5, y: 1 },
      height: 48
    },
    attack: {
      kind: "single",
      source: "asset:robot-attack",
      anchor: { x: 0.5, y: 1 },
      height: 48,
      facing: "mirror"
    }
  },
  "toon-zombie": {
    base: {
      kind: "single",
      source: "asset:zombie-idle",
      anchor: { x: 0.5, y: 1 },
      height: 48
    },
    attack: {
      kind: "single",
      source: "asset:zombie-attack",
      anchor: { x: 0.5, y: 1 },
      height: 48,
      facing: "mirror"
    }
  }
};

export const APPEARANCE_REGISTRY: Readonly<Record<string, AppearanceEntry>> = registry;

/**
 * Rewrites one registry entry, or removes it when handed `null`.
 *
 * Diagnostic only, and wired to a debug hook rather than to any control. It exists because
 * the one thing a head-less test cannot check is what ends up on the screen: pointing a real
 * key at a file that is not there and requiring the failure to be *visible* is a pixel
 * assertion, and it needs a way in. Nothing in the UI calls this, and the hook that exposes
 * it is only installed when the page is loaded with `?debug=1`.
 */
export function overrideAppearance(key: string, entry: AppearanceEntry | null): void {
  if (entry) {
    registry[key] = entry;
  } else {
    delete registry[key];
  }
}

/** Every source the registry references, deduplicated, in a stable order. */
export function registrySources(
  source: Readonly<Record<string, AppearanceEntry>> = APPEARANCE_REGISTRY
): readonly string[] {
  const seen = new Set<string>();
  for (const entry of Object.values(source)) {
    seen.add(entry.base.source);
    if (entry.attack) {
      seen.add(entry.attack.source);
    }
  }
  return [...seen];
}

// --- Load state -------------------------------------------------------------

export interface AppearanceStatus {
  readonly state: "pending" | "ready" | "failed";
  /** Present when `state` is `failed`. Shown to a human, so it has to say something. */
  readonly reason?: string;
}

/**
 * What the atlas knows about a source.
 *
 * Passed in as a function rather than a value so this module stays pure while still
 * answering per-source: a key's `base` and `attack` may come from different files, and a
 * failed attack sheet must not stop the idle frame from drawing.
 */
export type AppearanceStatusLookup = (source: string) => AppearanceStatus;

// --- The decision -----------------------------------------------------------

export type DrawPlan =
  /** No art is authored for this key. The procedural drawing is the rendering, not a fallback. */
  | { readonly kind: "procedural"; readonly key: string }
  /** Draw `spec`, at `frame`. */
  | { readonly kind: "art"; readonly key: string; readonly spec: AppearanceSpec; readonly frame: number }
  /**
   * Art is authored but not drawable.
   *
   * Deliberately a distinct plan: the renderer draws something that cannot be mistaken for
   * the procedural body, so "the file did not load" is visible on screen instead of being
   * absorbed into a plausible-looking frame.
   *
   * `source` is carried so the renderer can ask the atlas to (re)try it. Without that, a key
   * registered after startup — or a source that was not in the registry when `preload` ran —
   * would sit at "加载中" for the rest of the session with nothing to point at.
   */
  | { readonly kind: "placeholder"; readonly key: string; readonly source: string; readonly reason: string };

/** How far apart identical units are put on the animation clock, in milliseconds. */
export const PHASE_STEP_MS = 137;

/**
 * A per-entity offset so a row of identical units does not march in lockstep.
 *
 * Derived from the entity id rather than drawn from the RNG, for the same reason mechanism
 * cadence is derived from spawn position: consuming a random number here would make the
 * presentation layer shift the simulation's random stream, and a render-only concern must
 * never be able to do that.
 */
export function phaseOffsetMs(entityId: number): number {
  return Math.abs(Math.trunc(entityId)) * PHASE_STEP_MS;
}

/**
 * Which frame a spec is showing at `elapsedMs`.
 *
 * Guarded on every degenerate input rather than trusting the caller: `NaN` propagates through
 * `%` without throwing and lands as an invalid texture rectangle, which renders as a blank or
 * garbled sprite with nothing in the console to point at.
 */
export function frameAt(spec: AppearanceSpec, elapsedMs: number): number {
  if (spec.kind !== "sequence") {
    return 0;
  }
  const count = Math.max(Math.floor(spec.frameCount), 1);
  if (count <= 1 || !(spec.frameMs > 0)) {
    return 0;
  }
  const time = Number.isFinite(elapsedMs) ? Math.max(elapsedMs, 0) : 0;
  const index = Math.floor(time / spec.frameMs);
  return spec.loop ? index % count : Math.min(index, count - 1);
}

/**
 * What the renderer should draw for one entity, right now.
 *
 * The single decision point. Everything above it is data; everything below it is drawing.
 * One rule, deliberately: a key the registry does not know is *procedural*, which is the
 * correct rendering for every entity in this build. There is no "registered but unknown"
 * case to guard against — the atlas only ever learns about sources this registry named.
 */
export function planAppearance(
  key: string,
  windingUp: boolean,
  elapsedMs: number,
  lookup: AppearanceStatusLookup
): DrawPlan {
  const entry = APPEARANCE_REGISTRY[key];
  if (!entry) {
    return { kind: "procedural", key };
  }

  const spec = windingUp && entry.attack ? entry.attack : entry.base;
  const status = lookup(spec.source);

  if (status.state === "pending") {
    return { kind: "placeholder", key, source: spec.source, reason: "外观加载中" };
  }
  if (status.state === "failed") {
    return { kind: "placeholder", key, source: spec.source, reason: status.reason ?? "外观加载失败" };
  }

  return { kind: "art", key, spec, frame: frameAt(spec, elapsedMs) };
}

// --- The failure marker -----------------------------------------------------

/**
 * Magenta, because nothing else in the arena is.
 *
 * Shared with the smoke test so its pixel scan cannot drift from what is actually drawn —
 * a test that hard-codes its own copy of the colour passes forever after the renderer
 * changes it.
 */
export const PLACEHOLDER_COLOR = 0xff2fd0;

/** How many dashes each side of the marker box is broken into. */
export const PLACEHOLDER_DASHES_PER_SIDE = 3;

// --- Self-check -------------------------------------------------------------

/**
 * Self-check for the registry.
 *
 * Returns problems rather than throwing, so a bad entry is reported in the same vocabulary as
 * the content validator — which is where it is called from, because this registry *is*
 * content. A sequence with a zero frame count or a zero frame size divides into a zero-width
 * texture rectangle and draws nothing at all: no error, no sprite, and the unit simply
 * vanishes. Nothing else in the system would ever report that.
 */
export function findAppearanceProblems(
  source: Readonly<Record<string, AppearanceEntry>> = APPEARANCE_REGISTRY
): readonly string[] {
  const problems: string[] = [];

  for (const [key, entry] of Object.entries(source)) {
    for (const [slot, spec] of [
      ["base", entry.base],
      ["attack", entry.attack]
    ] as const) {
      if (!spec) {
        continue;
      }
      const at = `${key}.${slot}`;
      if (spec.source.trim().length === 0) {
        problems.push(`${at} 的 source 为空`);
      }
      if (spec.anchor) {
        const { x, y } = spec.anchor;
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
          problems.push(`${at} 的 anchor 必须落在 0..1`);
        }
      }
      if (spec.height !== undefined && !(Number.isFinite(spec.height) && spec.height > 0)) {
        problems.push(`${at} 的 height 必须是正数`);
      }
      // Widened before the comparison. The type already forbids other values, so a direct
      // check would be unreachable as far as the compiler is concerned — and this validator's
      // whole job is the case the compiler never sees: an entry that arrived as JSON.
      const facing: string | undefined = spec.facing;
      if (facing !== undefined && facing !== "none" && facing !== "mirror") {
        problems.push(`${at} 的 facing 必须是 "none" 或 "mirror"`);
      }
      if (spec.kind === "sequence") {
        if (!Number.isInteger(spec.frameCount) || spec.frameCount < 1) {
          problems.push(`${at} 的 frameCount 必须是 >= 1 的整数`);
        }
        if (!(spec.frameWidth > 0) || !(spec.frameHeight > 0)) {
          problems.push(`${at} 的帧尺寸必须为正`);
        }
        if (!(spec.frameMs > 0)) {
          problems.push(`${at} 的 frameMs 必须为正`);
        }
      }
    }
  }

  return problems;
}
