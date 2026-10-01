import { Application, Container, Graphics } from "pixi.js";
import type { WorldSnapshot } from "../simulation/types.ts";
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

/**
 * PixiJS battlefield.
 *
 * Presentation only: it reads a snapshot and never decides hits or damage from pixel
 * positions. World units are mapped to screen space by a single container scale, so
 * the simulation stays resolution-independent.
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

  const sprites = new Map<number, Graphics>();
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
          sprite = new Graphics();
          sprites.set(entity.id, sprite);
          layer.addChild(sprite);
        }

        const target = entity.transform.position;
        const last = previous.get(entity.id);
        const x = last ? last.x + (target.x - last.x) * alpha : target.x;
        const y = last ? last.y + (target.y - last.y) * alpha : target.y;

        sprite.clear();
        sprite.circle(x, y, entity.collider.radius);
        sprite.fill(factionColor(entity.faction));
        sprite.stroke({ width: 2, color: 0x0a0d14 });
      }

      for (const [id, sprite] of sprites) {
        if (!seen.has(id)) {
          sprite.destroy();
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
