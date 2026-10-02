import type { Graphics } from "pixi.js";

/**
 * Editor decorations drawn over the battlefield.
 *
 * These are the only thing the editor adds to the renderer. Everything else the player sees
 * while laying out a deployment is the real renderer drawing a real `WorldSnapshot` of the
 * draft — the same code path a running battle uses. That is deliberate: a separate editor
 * preview is a second implementation of "where is this unit", and the day the two disagree
 * the player finds out by losing a fight they thought they had set up.
 *
 * Markers are therefore not a preview. They are an overlay that says "this one is selected"
 * and "this one will be rejected", which is information the simulation cannot express.
 */

export type PlacementMarkerKind =
  /** The placement the inspector is bound to. */
  | "selected"
  /** A placement `validateDraft` rejects. */
  | "invalid";

export interface PlacementMarker {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly kind: PlacementMarkerKind;
}

interface MarkerStyle {
  readonly color: number;
  readonly width: number;
  readonly alpha: number;
}

/**
 * Both markers are rings rather than filled discs.
 *
 * A filled highlight would hide the unit's own colour and facing marker, which are the two
 * things a player is checking while placing it. The red ring is also dashed, so the two are
 * still distinguishable when a selected placement is also invalid — which is the state the
 * player spends the most time in while fixing a layout.
 */
const MARKER_STYLE: Readonly<Record<PlacementMarkerKind, MarkerStyle>> = {
  selected: { color: 0xffe9a8, width: 3, alpha: 0.95 },
  invalid: { color: 0xe0554b, width: 3, alpha: 0.95 }
};

const RING_PADDING = 5;
const DASH_COUNT = 12;
const DASH_FILL = 0.55;

/** Draws every marker into one Graphics, clearing whatever was there before. */
export function drawPlacementMarkers(gfx: Graphics, markers: readonly PlacementMarker[]): void {
  gfx.clear();

  for (const marker of markers) {
    const style = MARKER_STYLE[marker.kind];
    const radius = Math.max(marker.radius + RING_PADDING, 8);

    if (marker.kind === "invalid") {
      drawDashedRing(gfx, marker.x, marker.y, radius, style);
    } else {
      gfx.circle(marker.x, marker.y, radius);
      gfx.stroke({ width: style.width, color: style.color, alpha: style.alpha });
    }
  }
}

/**
 * A dashed ring, built from straight segments.
 *
 * PixiJS has no dash support, and an arc-based approximation has to fight the path
 * continuation that turns consecutive arcs into one continuous outline. Short chords are
 * both simpler and cheaper: at twelve segments the flat sides are not visible at any zoom
 * this arena is drawn at.
 */
function drawDashedRing(
  gfx: Graphics,
  cx: number,
  cy: number,
  radius: number,
  style: MarkerStyle
): void {
  const arc = (Math.PI * 2) / DASH_COUNT;
  const span = arc * DASH_FILL;

  for (let i = 0; i < DASH_COUNT; i += 1) {
    const from = i * arc;
    const to = from + span;
    gfx.moveTo(cx + Math.cos(from) * radius, cy + Math.sin(from) * radius);
    gfx.lineTo(cx + Math.cos(to) * radius, cy + Math.sin(to) * radius);
  }

  gfx.stroke({ width: style.width, color: style.color, alpha: style.alpha });
}
