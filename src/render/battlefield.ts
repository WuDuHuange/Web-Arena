import { Application, Container, Graphics } from "pixi.js";
import type { Entity, WorldSnapshot } from "../simulation/types.ts";
import { factionColor } from "./palette.ts";
import { drawProp, drawProjectile } from "./props.ts";

export interface BattlefieldBounds {
  readonly width: number;
  readonly height: number;
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

  // Three layers, bottom to top: scenery, then units, then effects. A lava pool must never
  // cover the units standing in it, or the fight becomes unreadable exactly where it is
  // most interesting.
  const propLayer = new Container();
  const unitLayer = new Container();
  const fxLayer = new Container();
  layer.addChild(propLayer, unitLayer, fxLayer);

  // A subtle arena outline, so the playfield is legible against the app background.
  const frame = new Graphics();
  frame.rect(0, 0, bounds.width, bounds.height).stroke({ width: 2, color: 0x3a4152 });
  layer.addChildAt(frame, 0);

  const sprites = new Map<number, UnitSprite>();
  const previous = new Map<number, ScreenPoint>();

  const fit = (): void => {
    const scale = Math.min(app.screen.width / bounds.width, app.screen.height / bounds.height);
    layer.scale.set(scale > 0 ? scale : 1);
  };
  fit();
  app.renderer.on("resize", fit);

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
    },

    destroy(): void {
      app.renderer.off("resize", fit);
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
