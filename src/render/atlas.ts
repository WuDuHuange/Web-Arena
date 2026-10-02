import { Assets, Rectangle, Texture } from "pixi.js";
import { APPEARANCE_REGISTRY, registrySources } from "../content/appearance.ts";
import type { AppearanceSpec, AppearanceStatus } from "../content/appearance.ts";

/**
 * Texture loading and slicing for appearance keys.
 *
 * The only impure half of the appearance layer. Everything it *decides* — which state a key
 * is in and what to draw for it — lives in `content/appearance.ts` as a pure function, so
 * this file is deliberately thin: fetch a texture, cache it, answer questions about it. That
 * split is what lets the decision table be tested under `node --test` with no browser at all.
 *
 * Loads never reject. A missing file is an expected outcome with a user-visible consequence,
 * not an exception, and a rejected promise here would take down the render loop for one
 * absent sprite.
 */

/** Sources under this scheme are generated from a canvas and ship no bytes. */
const BUILTIN_PREFIX = "builtin:";

interface SourceState {
  status: AppearanceStatus;
  texture?: Texture;
}

export interface AppearanceAtlas {
  /** What is known about a source. Never throws; unknown sources are `pending`. */
  status(source: string): AppearanceStatus;
  /** The full-size texture for a source, once it is ready. */
  texture(source: string): Texture | undefined;
  /**
   * The sub-texture for one frame of a strip, cached by source and index.
   *
   * Cached because the alternative is a new `Texture` per entity per rendered frame — at 120
   * entities and 60 FPS that is 7200 objects a second, all of them retained by the renderer's
   * texture bookkeeping.
   */
  frame(source: string, frame: number, frameWidth: number, frameHeight: number): Texture | undefined;
  /** Every registry key with its current state, for the panel. */
  report(): readonly AppearanceReportRow[];
  /**
   * Starts a load for a source that has not been attempted yet.
   *
   * Safe to call every frame, which is the point: the renderer calls it whenever it resolves
   * a key to a source the atlas has not seen. Without it, a key registered after `preload`
   * ran — or added by the debug override — would report "加载中" forever, which is a state
   * that looks exactly like a slow disk and is actually a dead end.
   */
  ensure(source: string): void;
  /** Starts every load the registry needs. Resolves when they have all settled. */
  preload(): Promise<void>;
  destroy(): void;
}

export interface AppearanceReportRow {
  readonly key: string;
  readonly state: AppearanceStatus["state"];
  /** Human-readable, and empty unless `state` is `failed`. */
  readonly reason: string;
}

export function createAppearanceAtlas(): AppearanceAtlas {
  const sources = new Map<string, SourceState>();
  const frames = new Map<string, Texture>();
  const inflight = new Map<string, Promise<void>>();

  const stateOf = (source: string): SourceState => {
    let state = sources.get(source);
    if (!state) {
      state = { status: { state: "pending" } };
      sources.set(source, state);
    }
    return state;
  };

  const statusOf = (source: string): AppearanceStatus =>
    sources.get(source)?.status ?? { state: "pending" };

  /**
   * Generates a fixture texture with a 2D canvas.
   *
   * Two fixtures exist and both are temporary: they ship no bytes and carry no licence, and
   * they are here for exactly one reason. An adapter whose success path never runs is an
   * adapter nobody has tested, and the alternative — shipping the code and hoping the first
   * real asset works — is how a pipeline reaches the art phase broken.
   */
  const generate = (source: string): Texture => {
    if (source === "builtin:demo-walk") {
      // Six frames of a 32x32 strip: a bar rotating around the cell, so a stalled animation
      // is visible as a frozen bar rather than as an ambiguous blob.
      return fromCanvas(32 * 6, 32, (ctx) => {
        for (let i = 0; i < 6; i += 1) {
          const cx = i * 32 + 16;
          const cy = 16;
          ctx.save();
          ctx.translate(cx, cy);
          ctx.rotate((i / 6) * Math.PI * 2);
          ctx.fillStyle = "#2ee6c8";
          ctx.fillRect(-2, -11, 4, 22);
          ctx.restore();
          ctx.beginPath();
          ctx.arc(cx, cy, 4, 0, Math.PI * 2);
          ctx.fillStyle = "#0f6f61";
          ctx.fill();
        }
      });
    }

    if (source === "builtin:demo-attack") {
      return fromCanvas(32, 32, (ctx) => {
        ctx.beginPath();
        ctx.arc(16, 16, 13, 0, Math.PI * 2);
        ctx.strokeStyle = "#ffd166";
        ctx.lineWidth = 4;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(16, 16, 5, 0, Math.PI * 2);
        ctx.fillStyle = "#fff3c4";
        ctx.fill();
      });
    }

    throw new Error(`未知的内置外观：${source}`);
  };

  const load = async (source: string): Promise<void> => {
    const state = stateOf(source);
    // Already settled. A failed source is not retried on every frame: the failure is shown
    // to the operator, and a retry loop would turn one missing file into a request storm.
    if (state.status.state !== "pending") {
      return;
    }
    try {
      const texture = source.startsWith(BUILTIN_PREFIX)
        ? generate(source)
        : ((await Assets.load(source)) as Texture);
      state.texture = texture;
      state.status = { state: "ready" };
    } catch (error) {
      state.status = {
        state: "failed",
        reason: error instanceof Error ? error.message : String(error)
      };
    }
  };

  const ensure = (source: string): void => {
    if (statusOf(source).state !== "pending" || inflight.has(source)) {
      return;
    }
    const promise = load(source).finally(() => inflight.delete(source));
    inflight.set(source, promise);
  };

  return {
    status: statusOf,

    texture(source: string): Texture | undefined {
      return sources.get(source)?.texture;
    },

    frame(source: string, frame: number, frameWidth: number, frameHeight: number): Texture | undefined {
      const base = sources.get(source)?.texture;
      if (!base) {
        return undefined;
      }
      const key = `${source}#${frame}`;
      const cached = frames.get(key);
      if (cached) {
        return cached;
      }
      const texture = new Texture({
        source: base.source,
        frame: new Rectangle(frame * frameWidth, 0, frameWidth, frameHeight)
      });
      frames.set(key, texture);
      return texture;
    },

    report(): readonly AppearanceReportRow[] {
      return Object.entries(APPEARANCE_REGISTRY).map(([key, entry]) => {
        // A key reports the worst state of its slots: a broken attack sheet is still something
        // an operator needs to see, even though the idle frame keeps drawing.
        const states = [entry.base, entry.attack]
          .filter((spec): spec is AppearanceSpec => spec !== undefined)
          .map((spec) => statusOf(spec.source));

        const failed = states.find((s) => s.state === "failed");
        if (failed) {
          return { key, state: "failed" as const, reason: failed.reason ?? "" };
        }
        if (states.some((s) => s.state === "pending")) {
          return { key, state: "pending" as const, reason: "" };
        }
        return { key, state: "ready" as const, reason: "" };
      });
    },

    ensure,

    async preload(): Promise<void> {
      for (const source of registrySources()) {
        ensure(source);
      }
      await Promise.all([...inflight.values()]);
    },

    destroy(): void {
      // Frames first, and without their source: they share the base texture's source, so
      // destroying it from a frame would leave the base pointing at a freed GPU handle.
      for (const texture of frames.values()) {
        texture.destroy();
      }
      frames.clear();
      for (const state of sources.values()) {
        state.texture?.destroy(true);
      }
      sources.clear();
      inflight.clear();
    }
  };
}

/** Draws into an offscreen canvas and hands the result to Pixi as a texture. */
function fromCanvas(width: number, height: number, paint: (ctx: CanvasRenderingContext2D) => void): Texture {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("无法创建 2D 画布上下文");
  }
  paint(ctx);
  return Texture.from(canvas);
}
