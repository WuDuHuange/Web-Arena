import { Application, Container, Graphics, Point, Sprite } from "pixi.js";
import { planAppearance, phaseOffsetMs } from "../content/appearance.ts";
import type { DrawPlan } from "../content/appearance.ts";
import type { Entity, WorldSnapshot } from "../simulation/types.ts";
import { createAppearanceAtlas } from "./atlas.ts";
import type { AppearanceReportRow } from "./atlas.ts";
import { factionColor } from "./palette.ts";
import { drawAppearancePlaceholder } from "./placeholder.ts";
import { drawPlacementMarkers } from "./placement.ts";
import type { PlacementMarker } from "./placement.ts";
import { drawProp, drawProjectile } from "./props.ts";

export interface BattlefieldBounds {
  readonly width: number;
  readonly height: number;
}

/** A point in world units, as opposed to the screen pixels a pointer event arrives in. */
export interface WorldPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * Pointer callbacks, already converted to world units.
 *
 * Conversion happens inside the battlefield because it is the only thing that knows the
 * container transform. Handing the editor raw client coordinates would put the fit
 * calculation in two places, and the two would drift the first time the arena is letterboxed.
 */
export interface PointerHandlers {
  down(point: WorldPoint): void;
  move(point: WorldPoint): void;
  up(point: WorldPoint): void;
}

export interface Battlefield {
  /**
   * Draws a snapshot, interpolating from the previous one by `alpha`.
   *
   * `elapsedMs` is a presentation clock for decoration only — trap pulses, belt chevrons.
   * Nothing animated from it can influence the simulation, which is why it is safe for it
   * to be frame-rate dependent when the tick is not.
   */
  render(snapshot: WorldSnapshot, alpha: number, elapsedMs?: number): void;
  /** Replaces the editor decorations drawn over the battlefield. */
  setMarkers(markers: readonly PlacementMarker[]): void;
  /**
   * The live state of every appearance key, for the asset panel.
   *
   * Exposed through the battlefield rather than handed to the app as a second object, so
   * there is exactly one atlas and the panel cannot report on a different one from the one
   * the renderer is drawing with.
   */
  appearance(): readonly AppearanceReportRow[];
  /** Installs pointer callbacks, or `null` to ignore pointer input. */
  setPointerHandlers(handlers: PointerHandlers | null): void;
  /**
   * Forgets the interpolation history without rebuilding the sprites.
   *
   * The editor rebuilds the whole world from the draft on every drag, and entity ids are
   * handed out from zero again — so the previous frame's positions belong to a different
   * layout. Without this, a dragged unit is drawn interpolating from where the *old* unit
   * with the same id stood, and trails the cursor by a frame.
   */
  resetInterpolation(): void;
  destroy(): void;
}

interface ScreenPoint {
  x: number;
  y: number;
}

/** Per-entity drawable: the procedural body plus, when a key resolves to art, a bitmap. */
interface UnitSprite {
  /** Body, facing marker and health bar. Everything the renderer computes. */
  readonly gfx: Graphics;
  /**
   * The bitmap, when there is one.
   *
   * A child of the same container and added *before* `gfx`, so the facing marker and the
   * health bar stay legible on top of the art. Those two are the only things on screen that
   * carry information a static image cannot: which way the unit is pointing, and how much
   * health it has left.
   */
  readonly view: Sprite;
  /** Which texture `view` currently holds, so an unchanged frame is not re-assigned. */
  textureKey: string;
}

const HEALTH_BAR_WIDTH = 26;
const HEALTH_BAR_HEIGHT = 3;
const HEALTH_BAR_OFFSET = 7;
const DEAD_COLOR = 0x2a2f3a;
/** Tint for a bitmap of a dead unit. Multiplied into the art, so it reads as the same shape gone grey. */
const DEAD_TINT = 0x6a7080;

/**
 * PixiJS battlefield.
 *
 * Presentation only: it reads a snapshot and never decides hits or damage from pixel
 * positions. World units are mapped to screen space by a single container scale, so
 * the simulation stays resolution-independent.
 *
 * The facing marker is not decoration. A cone or line attack is only legible if you can
 * see which way the caster is pointing, and the same goes for a health bar: without one,
 * a battle looks like units milling about rather than a fight with a score.
 */
export async function createBattlefield(host: HTMLElement, bounds: BattlefieldBounds): Promise<Battlefield> {
  const app = new Application();
  await app.init({
    background: 0x1b1f2a,
    antialias: true,
    resizeTo: host
  });
  host.appendChild(app.canvas);

  const layer = new Container();
  app.stage.addChild(layer);

  // Four layers, bottom to top: scenery, units, effects, then editor markers. A lava pool
  // must never cover the units standing in it, or the fight becomes unreadable exactly
  // where it is most interesting; the markers go above everything because their whole job is
  // to be visible on top of whatever they are marking.
  const propLayer = new Container();
  const unitLayer = new Container();
  const fxLayer = new Container();
  const markerLayer = new Container();
  layer.addChild(propLayer, unitLayer, fxLayer, markerLayer);

  // A subtle arena outline, so the playfield is legible against the app background.
  const frame = new Graphics();
  frame.rect(0, 0, bounds.width, bounds.height).stroke({ width: 2, color: 0x3a4152 });
  layer.addChildAt(frame, 0);

  const markerGfx = new Graphics();
  markerLayer.addChild(markerGfx);

  /**
   * The appearance layer's impure half.
   *
   * Started here rather than awaited: a battlefield that waits for every sprite sheet before
   * its first frame is a battlefield that stays black while the art loads, and the whole
   * point of the three-state decision is that "still loading" is something the screen can
   * show. `ensure` in the render loop covers anything `preload` did not name.
   */
  const atlas = createAppearanceAtlas();
  void atlas.preload();

  const sprites = new Map<number, UnitSprite>();
  const previous = new Map<number, ScreenPoint>();

  let markers: readonly PlacementMarker[] = [];
  let handlers: PointerHandlers | null = null;

  const fit = (): void => {
    const scale = Math.min(app.screen.width / bounds.width, app.screen.height / bounds.height);
    layer.scale.set(scale > 0 ? scale : 1);
  };
  fit();
  app.renderer.on("resize", fit);

  /**
   * Screen pixels to world units.
   *
   * The canvas is sized by `resizeTo: host`, so its CSS box and `app.screen` are the same
   * size in the normal case — but `resolution` and `autoDensity` can make the backing store
   * differ, and the ratio is two divisions. Scaling by it costs nothing and removes a whole
   * class of "clicks land slightly off" bug that only shows up on a high-DPI display.
   */
  const toWorld = (clientX: number, clientY: number): WorldPoint => {
    const rect = app.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return { x: 0, y: 0 };
    }
    const local = new Point(
      ((clientX - rect.left) / rect.width) * app.screen.width,
      ((clientY - rect.top) / rect.height) * app.screen.height
    );
    const world = layer.toLocal(local);
    return { x: world.x, y: world.y };
  };

  /**
   * Pointer handling uses DOM listeners on the canvas rather than Pixi's event system.
   *
   * The editor needs the pointer even when it is over empty floor, and it needs to keep
   * receiving moves after the cursor leaves the canvas mid-drag. Both are one line with a
   * DOM listener plus `setPointerCapture`, and both need a hit area the size of the arena
   * plus event-mode bookkeeping with the Pixi route. The listeners are attached once and
   * read the current handler, so installing and removing them does not churn the DOM.
   */
  const canvas = app.canvas;
  let captured = false;

  const onPointerDown = (event: PointerEvent): void => {
    if (!handlers) {
      return;
    }
    // Capture is what keeps a drag alive when the cursor leaves the canvas, but it throws
    // if the pointer is already gone — a fast click, or a synthetic event. Losing capture is
    // a degraded drag; throwing here would lose the whole gesture.
    try {
      canvas.setPointerCapture(event.pointerId);
      captured = true;
    } catch {
      captured = false;
    }
    handlers.down(toWorld(event.clientX, event.clientY));
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!handlers) {
      return;
    }
    handlers.move(toWorld(event.clientX, event.clientY));
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (!handlers) {
      return;
    }
    if (captured) {
      try {
        canvas.releasePointerCapture(event.pointerId);
      } catch {
        // Already released; nothing to undo.
      }
      captured = false;
    }
    handlers.up(toWorld(event.clientX, event.clientY));
  };

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);

  /**
   * Which draw layer an entity belongs to.
   *
   * Resolved once, when its sprite is created: an entity's role never changes mid-battle,
   * and a trap that migrated into the unit layer would end up drawn over the very units
   * standing in it.
   */
  const layerFor = (entity: Entity): Container => {
    if (entity.behavior) {
      return propLayer;
    }
    if (entity.projectile) {
      return fxLayer;
    }
    return unitLayer;
  };

  /**
   * Draws one unit: its art if it has any, otherwise the grey box.
   *
   * The three outcomes are kept visibly distinct on purpose, because that is the whole
   * contract. `procedural` means no art was authored and the grey box is the intended
   * rendering. `art` means a bitmap was authored and loaded. `placeholder` means a bitmap was
   * authored and is *not* drawable — loading, or failed — and it must not be possible to
   * confuse that with the first case, or a broken asset ships looking like a finished one.
   */
  const drawUnit = (sprite: UnitSprite, entity: Entity, x: number, y: number, elapsedMs: number): void => {
    const plan: DrawPlan = planAppearance(
      entity.render.appearance,
      entity.combat?.phase === "windup",
      // Staggered by id so a rank of identical units does not animate in lockstep. The id is
      // the only per-entity number available here that is not part of the simulation state.
      elapsedMs + phaseOffsetMs(entity.id),
      atlas.status
    );

    if (plan.kind === "placeholder") {
      // Asked for again on every frame rather than only at startup. A source that is not in
      // the registry's list — because the entry was added later, or by the debug override —
      // would otherwise sit at "加载中" with nothing ever starting the load.
      atlas.ensure(plan.source);
    }

    if (plan.kind === "art") {
      const texture =
        plan.spec.kind === "sequence"
          ? atlas.frame(plan.spec.source, plan.frame, plan.spec.frameWidth, plan.spec.frameHeight)
          : atlas.texture(plan.spec.source);

      if (texture) {
        const textureKey = `${plan.spec.source}#${plan.frame}`;
        if (sprite.textureKey !== textureKey) {
          sprite.view.texture = texture;
          sprite.textureKey = textureKey;
        }
        sprite.view.position.set(x, y);
        sprite.view.visible = true;

        // A dead unit keeps its sprite and goes grey, exactly as the grey box does. Dropping
        // the art instead would make a corpse pop back to a procedural circle.
        const dying = entity.health.dead === true;
        sprite.view.tint = dying ? DEAD_TINT : 0xffffff;
        sprite.view.alpha = dying ? 0.45 : 1;

        // Art replaces the body and nothing else. The marker and the bar are drawn on top.
        sprite.gfx.clear();
        drawChrome(sprite.gfx, entity, x, y);
        return;
      }
      // `ready` with no texture is a wiring bug, and the one thing it must not do is fall
      // through to the grey box, which would hide it.
      sprite.view.visible = false;
      drawAppearancePlaceholder(sprite.gfx, x, y, entity.collider.radius);
      drawChrome(sprite.gfx, entity, x, y);
      return;
    }

    sprite.view.visible = false;

    if (plan.kind === "placeholder") {
      drawAppearancePlaceholder(sprite.gfx, x, y, entity.collider.radius);
      drawChrome(sprite.gfx, entity, x, y);
      return;
    }

    drawEntity(sprite.gfx, entity, x, y);
  };

  return {
    render(snapshot: WorldSnapshot, alpha: number, elapsedMs = 0): void {
      const seen = new Set<number>();
      const seconds = elapsedMs / 1000;

      for (const entity of snapshot.entities) {
        seen.add(entity.id);

        let sprite = sprites.get(entity.id);
        if (!sprite) {
          const view = new Sprite();
          view.anchor.set(0.5);
          view.visible = false;
          const gfx = new Graphics();
          sprite = { gfx, view, textureKey: "" };
          sprites.set(entity.id, sprite);
          // View under graphics, so the facing marker and health bar stay on top of art.
          layerFor(entity).addChild(view, gfx);
        }

        const target = entity.transform.position;
        const last = previous.get(entity.id);
        const x = last ? last.x + (target.x - last.x) * alpha : target.x;
        const y = last ? last.y + (target.y - last.y) * alpha : target.y;

        if (entity.behavior) {
          // Props deliberately do not go through the appearance layer, and the reason is not
          // that it was easier. A prop's drawing *is* its mechanic readout: the translucent
          // field is the effect radius, the inner disc is the collider, and the pulse is the
          // cadence counter the damage tick actually reads. Substituting a bitmap would delete
          // gameplay information rather than change a costume. When prop art arrives it has to
          // be composited with the procedural field, which is a design task, not a lookup —
          // and `tests/appearance.test.mjs` fails the moment a prop key gets registered before
          // that work is done.
          drawProp(sprite.gfx, entity, x, y, seconds);
          sprite.view.visible = false;
        } else if (entity.projectile) {
          // Same reasoning: an emitter's shot is a bright dot whose size is its hitbox.
          drawProjectile(sprite.gfx, entity, x, y);
          sprite.view.visible = false;
        } else {
          drawUnit(sprite, entity, x, y, elapsedMs);
        }
      }

      for (const [id, sprite] of sprites) {
        if (!seen.has(id)) {
          sprite.gfx.destroy();
          // `texture: false` — the atlas owns every texture here, and a sprite that freed its
          // own would leave the cache handing out a destroyed handle to the next unit.
          sprite.view.destroy({ texture: false, textureSource: false });
          sprites.delete(id);
          previous.delete(id);
        }
      }

      for (const entity of snapshot.entities) {
        previous.set(entity.id, { x: entity.transform.position.x, y: entity.transform.position.y });
      }

      // Markers are redrawn after the entity pass rather than in their own step, so they
      // can never be left one frame stale relative to the layout they are annotating.
      drawPlacementMarkers(markerGfx, markers);
    },

    setMarkers(next: readonly PlacementMarker[]): void {
      markers = next;
    },

    appearance(): readonly AppearanceReportRow[] {
      return atlas.report();
    },

    setPointerHandlers(next: PointerHandlers | null): void {
      handlers = next;
      canvas.style.cursor = next ? "crosshair" : "default";
    },

    resetInterpolation(): void {
      previous.clear();
    },

    destroy(): void {
      app.renderer.off("resize", fit);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      handlers = null;
      atlas.destroy();
      app.destroy(true, { children: true });
    }
  };
}

/**
 * Draws one entity as a grey box: body, facing marker, and a health bar when it can fight.
 *
 * Everything is redrawn from scratch each frame. With a few hundred entities this is
 * still comfortably within budget, and it avoids a cache-invalidation bug class that is
 * far more expensive to debug than the fill rate it saves.
 *
 * Used only when a key resolves to `procedural`. When it resolves to art, the body is the
 * bitmap and `drawChrome` is called on its own — the two halves are split for exactly that
 * reason, so a unit with a sprite still shows its heading and its remaining health.
 */
function drawEntity(gfx: Graphics, entity: Entity, x: number, y: number): void {
  gfx.clear();
  drawBody(gfx, entity, x, y);
  drawChrome(gfx, entity, x, y);
}

/** The grey-box body: a filled circle in the faction colour, desaturated once it is dead. */
function drawBody(gfx: Graphics, entity: Entity, x: number, y: number): void {
  const radius = entity.collider.radius;
  // Dead bodies are drawn desaturated rather than skipped, so a body visibly stops
  // fighting instead of silently vanishing mid-frame.
  const dying = entity.health.dead === true;

  gfx.circle(x, y, radius);
  gfx.fill(dying ? DEAD_COLOR : factionColor(entity.faction));
  gfx.stroke({ width: 2, color: 0x0a0d14 });
}

/**
 * Facing marker and health bar — the two things a bitmap cannot carry.
 *
 * Assumes the caller has already cleared the graphics, because the caller may have put a
 * placeholder or a sprite there instead of a body.
 */
function drawChrome(gfx: Graphics, entity: Entity, x: number, y: number): void {
  if (!entity.combat) {
    return;
  }

  const radius = entity.collider.radius;
  const dying = entity.health.dead === true;

  if (!dying) {
    // Facing marker: a short spike from the edge, brightened while winding up so the
    // telegraph is visible and the attack direction is unambiguous.
    const casting = entity.combat.phase === "windup";
    const markerColor = casting ? 0xffe9a8 : 0xe8edf7;
    const inner = radius * 0.55;
    const outer = radius + (casting ? 9 : 6);

    gfx.moveTo(x + Math.cos(entity.transform.facing) * inner, y + Math.sin(entity.transform.facing) * inner);
    gfx.lineTo(x + Math.cos(entity.transform.facing) * outer, y + Math.sin(entity.transform.facing) * outer);
    gfx.stroke({ width: casting ? 3 : 2, color: markerColor });
  }

  drawHealthBar(gfx, entity, x, y, radius);
}

function drawHealthBar(gfx: Graphics, entity: Entity, x: number, y: number, radius: number): void {
  const max = Math.max(entity.health.max, 1);
  const ratio = Math.max(Math.min(entity.health.current / max, 1), 0);
  const barX = x - HEALTH_BAR_WIDTH / 2;
  const barY = y - radius - HEALTH_BAR_OFFSET;

  gfx.rect(barX, barY, HEALTH_BAR_WIDTH, HEALTH_BAR_HEIGHT);
  gfx.fill(0x11141c);

  if (ratio > 0) {
    gfx.rect(barX, barY, HEALTH_BAR_WIDTH * ratio, HEALTH_BAR_HEIGHT);
    gfx.fill(ratio > 0.5 ? 0x63c07a : ratio > 0.25 ? 0xd8b45a : 0xd05a4e);
  }
}
