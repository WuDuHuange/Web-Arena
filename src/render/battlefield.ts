import { Application, Container, Graphics, Point } from "pixi.js";
import type { Entity, WorldSnapshot } from "../simulation/types.ts";
import { factionColor } from "./palette.ts";
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

/** Per-entity drawable, kept as one Graphics so a unit is a single draw call. */
interface UnitSprite {
  readonly gfx: Graphics;
}

const HEALTH_BAR_WIDTH = 26;
const HEALTH_BAR_HEIGHT = 3;
const HEALTH_BAR_OFFSET = 7;
const DEAD_COLOR = 0x2a2f3a;

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

  return {
    render(snapshot: WorldSnapshot, alpha: number, elapsedMs = 0): void {
      const seen = new Set<number>();
      const seconds = elapsedMs / 1000;

      for (const entity of snapshot.entities) {
        seen.add(entity.id);

        let sprite = sprites.get(entity.id);
        if (!sprite) {
          sprite = { gfx: new Graphics() };
          sprites.set(entity.id, sprite);
          layerFor(entity).addChild(sprite.gfx);
        }

        const target = entity.transform.position;
        const last = previous.get(entity.id);
        const x = last ? last.x + (target.x - last.x) * alpha : target.x;
        const y = last ? last.y + (target.y - last.y) * alpha : target.y;

        if (entity.behavior) {
          drawProp(sprite.gfx, entity, x, y, seconds);
        } else if (entity.projectile) {
          drawProjectile(sprite.gfx, entity, x, y);
        } else {
          drawEntity(sprite.gfx, entity, x, y);
        }
      }

      for (const [id, sprite] of sprites) {
        if (!seen.has(id)) {
          sprite.gfx.destroy();
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
      app.destroy(true, { children: true });
    }
  };
}

/**
 * Draws one entity: body, facing marker, and a health bar when it can fight.
 *
 * Everything is redrawn from scratch each frame. With a few hundred entities this is
 * still comfortably within budget, and it avoids a cache-invalidation bug class that is
 * far more expensive to debug than the fill rate it saves.
 */
function drawEntity(gfx: Graphics, entity: Entity, x: number, y: number): void {
  gfx.clear();

  const radius = entity.collider.radius;
  const base = factionColor(entity.faction);

  // Dead bodies are drawn desaturated rather than skipped, so a body visibly stops
  // fighting instead of silently vanishing mid-frame.
  const dying = entity.health.dead === true;
  const fill = dying ? DEAD_COLOR : base;

  gfx.circle(x, y, radius);
  gfx.fill(fill);
  gfx.stroke({ width: 2, color: 0x0a0d14 });

  if (entity.combat && !dying) {
    // Facing marker: a short spike from the edge, brightened while winding up so the
    // telegraph is visible and the attack direction is unambiguous.
    const casting = entity.combat.phase === "windup";
    const markerColor = casting ? 0xffe9a8 : 0xe8edf7;
    const inner = radius * 0.55;
    const outer = radius + (casting ? 9 : 6);

    gfx.moveTo(x + Math.cos(entity.transform.facing) * inner, y + Math.sin(entity.transform.facing) * inner);
    gfx.lineTo(x + Math.cos(entity.transform.facing) * outer, y + Math.sin(entity.transform.facing) * outer);
    gfx.stroke({ width: casting ? 3 : 2, color: markerColor });

    drawHealthBar(gfx, entity, x, y, radius);
  } else if (entity.combat && dying) {
    drawHealthBar(gfx, entity, x, y, radius);
  }
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
