import { Application, Container, Graphics } from "pixi.js";
import type { Entity, WorldSnapshot } from "../simulation/types.ts";
import { factionColor } from "./palette.ts";

export interface BattlefieldBounds {
  readonly width: number;
  readonly height: number;
}

export interface Battlefield {
  /** Draws a snapshot, interpolating from the previous one by `alpha`. */
  render(snapshot: WorldSnapshot, alpha: number): void;
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

  // A subtle arena outline, so the playfield is legible against the app background.
  const frame = new Graphics();
  frame.rect(0, 0, bounds.width, bounds.height).stroke({ width: 2, color: 0x3a4152 });
  layer.addChild(frame);

  const sprites = new Map<number, UnitSprite>();
  const previous = new Map<number, ScreenPoint>();

  const fit = (): void => {
    const scale = Math.min(app.screen.width / bounds.width, app.screen.height / bounds.height);
    layer.scale.set(scale > 0 ? scale : 1);
  };
  fit();
  app.renderer.on("resize", fit);

  return {
    render(snapshot: WorldSnapshot, alpha: number): void {
      const seen = new Set<number>();

      for (const entity of snapshot.entities) {
        seen.add(entity.id);

        let sprite = sprites.get(entity.id);
        if (!sprite) {
          sprite = { gfx: new Graphics() };
          sprites.set(entity.id, sprite);
          layer.addChild(sprite.gfx);
        }

        const target = entity.transform.position;
        const last = previous.get(entity.id);
        const x = last ? last.x + (target.x - last.x) * alpha : target.x;
        const y = last ? last.y + (target.y - last.y) * alpha : target.y;

        drawEntity(sprite.gfx, entity, x, y);
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
