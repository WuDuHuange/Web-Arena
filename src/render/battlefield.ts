import { Application, Assets, Container, Graphics, Matrix, Point, Sprite, Texture } from "pixi.js";
import { GROUND_TEXTURE_URL } from "../assets/index.ts";
import { anchorOf, artHeight, mirrorsFacing, planAppearance, phaseOffsetMs } from "../content/appearance.ts";
import type { DrawPlan } from "../content/appearance.ts";
import type { Entity, WorldSnapshot } from "../simulation/types.ts";
import { createAppearanceAtlas } from "./atlas.ts";
import type { AppearanceReportRow } from "./atlas.ts";
import { GROUND_CELL_UNITS, GROUND_TINT, groundCells } from "./ground.ts";
import { factionColor } from "./palette.ts";
import { drawAppearancePlaceholder } from "./placeholder.ts";
import { drawPlacementMarkers } from "./placement.ts";
import type { PlacementMarker } from "./placement.ts";
import { createProjector } from "./projection.ts";
import type { ProjectionKind, Projector } from "./projection.ts";
import { drawProp, drawProjectile } from "./props.ts";

export interface BattlefieldBounds {
  readonly width: number;
  readonly height: number;
}

export interface BattlefieldOptions {
  /**
   * Which projection to draw with. Defaults to `flat`, which is the renderer this project
   * shipped and the one every existing verification run measures.
   */
  readonly projection?: ProjectionKind;
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

/**
 * Per-entity drawables, split by whether they lie on the ground or stand up from it.
 *
 * That split is what makes 2.5D affordable. Everything in `ground` is drawn in plain world
 * coordinates into a container carrying the projection matrix, so it projects for free and
 * a circular trap field becomes a correctly-shaped ellipse without `props.ts` knowing that
 * isometric exists. Everything in `chrome` and `view` stands perpendicular to the floor and
 * is therefore *positioned* by the projection but drawn without it.
 *
 * In flat mode both graphics live in the same container, in the same order, as the single
 * graphics they replace — so the shipped view is unchanged rather than merely similar.
 */
interface EntitySprite {
  /** Ground-plane graphics: trap fields, unit footprints. World coordinates. */
  readonly ground: Graphics;
  /** Upright graphics: facing marker, health bar, projectile dot. Projected coordinates. */
  readonly chrome: Graphics;
  /**
   * The bitmap, when there is one.
   *
   * Added *before* the graphics so the facing marker and the health bar stay legible on top
   * of the art. Those two are the only things on screen that carry information a static
   * image cannot: which way the unit is pointing, and how much health it has left.
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
export async function createBattlefield(
  host: HTMLElement,
  bounds: BattlefieldBounds,
  options: BattlefieldOptions = {}
): Promise<Battlefield> {
  const app = new Application();
  await app.init({
    background: 0x1b1f2a,
    antialias: true,
    resizeTo: host
  });
  host.appendChild(app.canvas);

  const projector: Projector = createProjector(options.projection ?? "flat", {
    width: bounds.width,
    height: bounds.height
  });

  const layer = new Container();
  app.stage.addChild(layer);

  /**
   * The scene graph, in two halves.
   *
   * `groundLayer` carries the projection matrix, so anything drawn inside it in world
   * coordinates comes out projected. It holds the arena outline, the props, and — in the
   * isometric view — the unit footprints, all of which lie on the floor.
   *
   * Everything above it is a billboard: positioned at a projected point, drawn at full size
   * and square to the camera. Units, projectiles and editor markers live there.
   *
   * Bottom to top the order is still scenery, units, effects, markers, for the same reason
   * as before: a lava pool must never cover the units standing in it, or the fight becomes
   * unreadable exactly where it is most interesting.
   */
  const groundLayer = new Container();
  const propLayer = new Container();
  const bodyLayer = new Container();
  const unitLayer = new Container();
  const fxLayer = new Container();
  const markerLayer = new Container();
  groundLayer.addChild(propLayer, bodyLayer);
  layer.addChild(groundLayer, unitLayer, fxLayer, markerLayer);

  if (projector.kind !== "flat") {
    // The adapter between the projection's plain six numbers and Pixi's matrix type. It
    // lives here rather than in `projection.ts` because that module deliberately imports
    // nothing — the same reason `content/appearance.ts` does — and this is the one place
    // that needs both sides.
    const { a, b, c, d, tx, ty } = projector.matrix();
    const matrix = new Matrix(a, b, c, d, tx, ty);
    groundLayer.setFromMatrix(matrix);
    markerLayer.setFromMatrix(matrix);
  }

  /**
   * Depth sorting, only where the projection asks for it.
   *
   * The flat renderer draws in creation order and its output is verified against that, so
   * switching sorting on there would be a behaviour change hiding inside a view flag. Under
   * isometric the ground matrix has already broken creation order, and the painter's key has
   * to come from the same coordinates the projection used.
   */
  for (const container of [propLayer, bodyLayer, unitLayer, fxLayer]) {
    container.sortableChildren = projector.sortable;
  }

  /**
   * The floor, beneath the outline.
   *
   * Added at index 0, with the outline moved above it. The order matters: now that there is
   * a material down, the outline is the only thing still saying where the playable area
   * ends, so it has to survive being painted over.
   *
   * Started rather than awaited, for the same reason the appearance atlas is. A battlefield
   * that blocks its first frame on a texture download stays black, and "the floor has not
   * arrived yet" is a state the screen can already show — the arena background — rather than
   * one that needs a loading screen in front of it.
   *
   * One sprite per cell rather than a single `TilingSprite`: they all share one texture, so
   * Pixi batches them into one draw call anyway, and a cell is something a later phase can
   * give a terrain type to. The count is `groundCells`, which is pure and tested.
   */
  const tileLayer = new Container();
  tileLayer.sortableChildren = false;
  groundLayer.addChildAt(tileLayer, 0);

  let groundDestroyed = false;
  void Assets.load<Texture>(GROUND_TEXTURE_URL)
    .then((texture) => {
      if (groundDestroyed) {
        // The battlefield was torn down while the texture was in flight. Adding sprites now
        // would put them into a destroyed stage.
        return;
      }
      for (const cell of groundCells(bounds.width, bounds.height)) {
        const tile = new Sprite(texture);
        // Scale rather than `width`/`height`, because a mirrored cell needs a negative
        // scale, and setting `width` would overwrite it with a positive number.
        const scale = GROUND_CELL_UNITS / texture.width;
        tile.scale.set(cell.flipX ? -scale : scale, cell.flipY ? -scale : scale);
        // A negative scale draws away from the origin, so a flipped cell has to be anchored
        // on its far corner to still cover the same square of floor.
        tile.position.set(
          cell.flipX ? cell.x + GROUND_CELL_UNITS : cell.x,
          cell.flipY ? cell.y + GROUND_CELL_UNITS : cell.y
        );
        tile.tint = GROUND_TINT;
        tileLayer.addChild(tile);
      }
    })
    .catch((error: unknown) => {
      // Loud, and then the floor is simply absent. The arena still runs, because a missing
      // texture is not a reason to refuse to simulate a battle — and the diagnostic panel is
      // where a reader goes looking for why the ground is not there.
      console.error("地面材质加载失败", error);
    });

  // A subtle arena outline, so the playfield is legible against the app background. Drawn in
  // world coordinates inside the ground layer, so in the isometric view it becomes the
  // diamond the floor actually is, rather than a rectangle painted over it.
  const frame = new Graphics();
  frame.rect(0, 0, bounds.width, bounds.height).stroke({ width: 2, color: 0x3a4152 });
  groundLayer.addChildAt(frame, 1);

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

  const sprites = new Map<number, EntitySprite>();
  const previous = new Map<number, ScreenPoint>();

  let markers: readonly PlacementMarker[] = [];
  let handlers: PointerHandlers | null = null;

  const extent = projector.projectedExtent();
  const fit = (): void => {
    const scale = Math.min(app.screen.width / extent.width, app.screen.height / extent.height);
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
   *
   * The final `unproject` is what keeps the editor usable in the isometric view. `layer`
   * holds the fit scale but not the projection, so `toLocal` lands in projected units — the
   * same space the sprites are positioned in — and the projection's inverse is the last step
   * back to the world coordinates the simulation and the draft speak.
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
    const projected = layer.toLocal(local);
    return projector.unproject(projected.x, projected.y);
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
   * Where an entity's two halves are attached.
   *
   * A unit's footprint belongs on the floor and its marker does not, so in the isometric
   * view they part company — the footprint joins the projected ground layer and the marker
   * stays on the billboard. In flat mode both resolve to the same container they always did,
   * and the flat renderer's child order is unchanged down to the insertion sequence.
   *
   * Resolved once, when the sprite is created: an entity's role never changes mid-battle,
   * and a trap that migrated into the unit layer would end up drawn over the very units
   * standing in it.
   */
  const groundParentFor = (entity: Entity): Container => {
    if (entity.behavior) {
      return propLayer;
    }
    if (entity.projectile) {
      // A shot's ground graphics is never drawn; it stays with the shot so the flat view's
      // child order is the one it has always had.
      return fxLayer;
    }
    // Only a unit's footprint belongs on the projected floor.
    return projector.sortable ? bodyLayer : unitLayer;
  };

  const chromeParentFor = (entity: Entity): Container => {
    if (entity.behavior) {
      return propLayer;
    }
    return entity.projectile ? fxLayer : unitLayer;
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
  const drawUnit = (
    sprite: EntitySprite,
    entity: Entity,
    world: ScreenPoint,
    projected: ScreenPoint,
    elapsedMs: number
  ): void => {
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

        // The three numbers that put a bitmap *on* the floor rather than over it.
        //
        // The anchor comes from the art: a portrait is pinned by its feet, and this pack's
        // feet are on the bottom edge of the frame, so `y: 1` lands the boots on the unit's
        // projected position instead of floating it half its own height up the screen.
        //
        // The scale converts the spec's world-unit height into texture pixels. Without it a
        // 128-pixel figure would be drawn 128 world units tall — five times the arena's idea
        // of a person, which is the same mistake as no scale at all, only louder.
        //
        // The mirror is the one that depends on the view rather than on the art, so the sign
        // is asked of the projection rather than guessed from the world angle. A pose drawn
        // facing right has to be flipped when its unit walks left, or the wind-up reads as
        // aimed away from the target it is winding up against.
        const anchor = anchorOf(plan.spec);
        const scale = artHeight(plan.spec, texture.height) / texture.height;
        const mirrored =
          mirrorsFacing(plan.spec) && projector.horizontalSign(entity.transform.facing) < 0;

        sprite.view.anchor.set(anchor.x, anchor.y);
        sprite.view.scale.set(mirrored ? -scale : scale, scale);
        sprite.view.position.set(projected.x, projected.y);
        sprite.view.visible = true;

        // A dead unit keeps its sprite and goes grey, exactly as the grey box does. Dropping
        // the art instead would make a corpse pop back to a procedural circle.
        const dying = entity.health.dead === true;
        sprite.view.tint = dying ? DEAD_TINT : 0xffffff;
        sprite.view.alpha = dying ? 0.45 : 1;

        // Art replaces the body and nothing else. The marker and the bar are drawn on top.
        sprite.ground.clear();
        sprite.chrome.clear();
        drawChrome(sprite.chrome, entity, projected.x, projected.y);
        return;
      }
      // `ready` with no texture is a wiring bug, and the one thing it must not do is fall
      // through to the grey box, which would hide it.
      sprite.view.visible = false;
      sprite.ground.clear();
      drawAppearancePlaceholder(sprite.ground, world.x, world.y, entity.collider.radius);
      sprite.chrome.clear();
      drawChrome(sprite.chrome, entity, projected.x, projected.y);
      return;
    }

    sprite.view.visible = false;

    if (plan.kind === "placeholder") {
      sprite.ground.clear();
      drawAppearancePlaceholder(sprite.ground, world.x, world.y, entity.collider.radius);
      sprite.chrome.clear();
      drawChrome(sprite.chrome, entity, projected.x, projected.y);
      return;
    }

    // The footprint goes on the floor, in world units, and projects with it. The marker and
    // the bar are drawn where the projection put the unit, at full size.
    sprite.ground.clear();
    drawBody(sprite.ground, entity, world.x, world.y);
    sprite.chrome.clear();
    drawChrome(sprite.chrome, entity, projected.x, projected.y);
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
          const ground = new Graphics();
          const chrome = new Graphics();
          sprite = { ground, chrome, view, textureKey: "" };
          sprites.set(entity.id, sprite);
          // View under the two graphics, so the facing marker and health bar stay on top of
          // art. When both halves share a parent — every entity in flat mode, and every prop
          // in the isometric view — they are added as one run per entity, so the layer's
          // child order, and therefore the pixels, match the single graphics they replace.
          // Only a unit in the isometric view splits, and then the footprint joins the
          // projected floor while the billboard stays square to the camera.
          const groundParent = groundParentFor(entity);
          const chromeParent = chromeParentFor(entity);
          if (groundParent === chromeParent) {
            groundParent.addChild(view, ground, chrome);
          } else {
            groundParent.addChild(ground);
            chromeParent.addChild(view, chrome);
          }
        }

        const target = entity.transform.position;
        const last = previous.get(entity.id);
        const world = {
          x: last ? last.x + (target.x - last.x) * alpha : target.x,
          y: last ? last.y + (target.y - last.y) * alpha : target.y
        };
        const projected = projector.project(world.x, world.y);

        if (projector.sortable) {
          // Same key on both halves, or a unit's marker would sort against a different
          // depth than its own footprint and drift off it as the arena fills up.
          const depth = projector.depth(world.x, world.y);
          sprite.ground.zIndex = depth;
          sprite.chrome.zIndex = depth;
          sprite.view.zIndex = depth;
        }

        if (entity.behavior) {
          // Props deliberately do not go through the appearance layer, and the reason is not
          // that it was easier. A prop's drawing *is* its mechanic readout: the translucent
          // field is the effect radius, the inner disc is the collider, and the pulse is the
          // cadence counter the damage tick actually reads. Substituting a bitmap would delete
          // gameplay information rather than change a costume. When prop art arrives it has to
          // be composited with the procedural field, which is a design task, not a lookup —
          // and `tests/appearance.test.mjs` fails the moment a prop key gets registered before
          // that work is done.
          //
          // Drawn in world coordinates into the projected ground layer, which is why an
          // isometric lava pool is the right shape without `props.ts` changing.
          drawProp(sprite.ground, entity, world.x, world.y, seconds);
          sprite.chrome.clear();
          sprite.view.visible = false;
        } else if (entity.projectile) {
          // Same reasoning: an emitter's shot is a bright dot whose size is its hitbox. It
          // flies above the floor, so it is a billboard like the unit that fired it.
          sprite.ground.clear();
          sprite.chrome.clear();
          drawProjectile(sprite.chrome, entity, projected.x, projected.y);
          sprite.view.visible = false;
        } else {
          drawUnit(sprite, entity, world, projected, elapsedMs);
        }
      }

      for (const [id, sprite] of sprites) {
        if (!seen.has(id)) {
          sprite.ground.destroy();
          sprite.chrome.destroy();
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
      // can never be left one frame stale relative to the layout they are annotating. They
      // are ground decorations — rings around a placement — so their layer carries the same
      // projection matrix the floor does, and they are drawn in world coordinates.
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
      groundDestroyed = true;
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
 * Drawn in projected coordinates rather than world ones: these stand up from the floor, so
 * they must be placed where the projection put the unit but keep their true size and shape.
 * Pushing them through the ground matrix would squash a health bar into the floor, which is
 * both wrong and immediately visible.
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
