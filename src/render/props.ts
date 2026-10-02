import type { Graphics } from "pixi.js";
import type { Entity, PropTrigger } from "../simulation/types.ts";

/**
 * Procedural rendering for field mechanisms.
 *
 * Everything here is drawn with primitives, so the whole trap layer costs zero asset
 * bytes and carries zero licensing risk. Animation is driven by a render clock, never by
 * the simulation tick: a trap that pulses slightly faster on a 144 Hz display changes
 * nothing about when it deals damage.
 *
 * Two radii matter and both are drawn, because they are different numbers:
 *
 * - `collider.radius` is the solid body. It is deliberately small for a floor trap, since
 *   a lava pool is not a wall and should not shove units out of itself.
 * - `behavior.radius` is the area that actually reacts. A lava pool with a 54-unit effect
 *   radius and a 10-unit body is unreadable if you only draw the body, so the effect area
 *   is always shown as a translucent field.
 */

export interface PropPalette {
  readonly base: number;
  readonly glow: number;
  readonly edge: number;
}

/**
 * Exported so the in-app legend can show the same colours the battlefield draws with.
 *
 * A legend maintained separately from the renderer is a legend that eventually lies. This
 * one cannot drift, because there is only one table.
 */
export const PROP_PALETTE: Record<PropTrigger, PropPalette> = {
  aura: { base: 0x5c2118, glow: 0xff7a3c, edge: 0x9a3a24 },
  conveyor: { base: 0x28313f, glow: 0x7fd4e8, edge: 0x46536b },
  spring: { base: 0x33402c, glow: 0xb8e06a, edge: 0x5b7149 },
  explosive: { base: 0x4a3520, glow: 0xffb648, edge: 0x86643a },
  spike: { base: 0x363b46, glow: 0xc9d3e3, edge: 0x5b6474 },
  turret: { base: 0x2b3646, glow: 0x64b5f6, edge: 0x4a5e75 },
  shrine: { base: 0x352a46, glow: 0xc792ea, edge: 0x5a4a70 }
};

const SCORCH = 0x14171e;
const PROJECTILE_CORE = 0xfff6e0;
const PROJECTILE_GLOW = 0xffd98a;

/** Draws one field mechanism, including its effect footprint. */
export function drawProp(gfx: Graphics, entity: Entity, x: number, y: number, seconds: number): void {
  const behavior = entity.behavior;
  if (!behavior) {
    return;
  }

  gfx.clear();

  const palette = PROP_PALETTE[behavior.kind];
  const radius = Math.max(behavior.radius, 1);
  const body = Math.max(entity.collider.radius, 1);

  switch (behavior.kind) {
    case "aura":
      drawAura(gfx, entity, x, y, radius, body, palette, seconds);
      break;
    case "conveyor":
      drawConveyor(gfx, entity, x, y, radius, body, palette, seconds);
      break;
    case "spring":
      drawSpring(gfx, entity, x, y, radius, body, palette);
      break;
    case "explosive":
      drawExplosive(gfx, entity, x, y, radius, body, palette, seconds);
      break;
    case "spike":
      drawSpike(gfx, entity, x, y, radius, body, palette);
      break;
    case "turret":
      drawTurret(gfx, entity, x, y, radius, body, palette);
      break;
    case "shrine":
      drawShrine(gfx, entity, x, y, radius, body, palette, seconds);
      break;
  }
}

/** Draws a shot in flight. Emitter shots are warm and bright so they read as hostile. */
export function drawProjectile(gfx: Graphics, entity: Entity, x: number, y: number): void {
  gfx.clear();
  const radius = Math.max(entity.collider.radius, 2);

  gfx.circle(x, y, radius * 2.4);
  gfx.fill({ color: PROJECTILE_GLOW, alpha: 0.16 });
  gfx.circle(x, y, radius);
  gfx.fill(PROJECTILE_GLOW);
  gfx.circle(x, y, radius * 0.45);
  gfx.fill(PROJECTILE_CORE);
}

/**
 * How far through its cadence a periodic mechanism is, in 0..1.
 *
 * Reading the live counter rather than the clock is the whole point: the visual charge-up
 * and the tick that actually deals damage stay in step even if the frame rate is awful.
 */
function cadence(entity: Entity, intervalTicks: number): number {
  if (intervalTicks <= 0) {
    return 0;
  }
  const left = entity.mechanism?.intervalTicksLeft ?? 0;
  return clamp01(1 - left / intervalTicks);
}

function cooldown(entity: Entity, cooldownTicks: number): number {
  if (cooldownTicks <= 0) {
    return 0;
  }
  const left = entity.mechanism?.cooldownTicksLeft ?? 0;
  return clamp01(left / cooldownTicks);
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Lava and other standing hazards: a pulsing pool that flares just before it ticks. */
function drawAura(
  gfx: Graphics,
  entity: Entity,
  x: number,
  y: number,
  radius: number,
  body: number,
  palette: PropPalette,
  seconds: number
): void {
  const charge = cadence(entity, entity.behavior?.intervalTicks ?? 0);
  const pulse = 0.5 + 0.5 * Math.sin(seconds * 2.2);

  gfx.circle(x, y, radius);
  gfx.fill({ color: palette.base, alpha: 0.3 });

  // An outer ring that brightens as the next damage tick approaches. This is the telegraph.
  gfx.circle(x, y, radius);
  gfx.stroke({ width: 2 + charge * 2, color: palette.glow, alpha: 0.3 + 0.5 * charge });

  // Molten blotches, so the pool does not read as a flat disc.
  const inner = radius * (0.45 + 0.08 * pulse);
  gfx.circle(x - radius * 0.18, y + radius * 0.12, inner * 0.55);
  gfx.fill({ color: palette.glow, alpha: 0.12 + 0.16 * charge });
  gfx.circle(x + radius * 0.22, y - radius * 0.16, inner * 0.4);
  gfx.fill({ color: palette.glow, alpha: 0.1 + 0.12 * charge });

  gfx.circle(x, y, body);
  gfx.fill(palette.base);
  gfx.stroke({ width: 1.5, color: palette.edge });
}

/** A belt: chevrons roll along the push direction so the shove is legible at a glance. */
function drawConveyor(
  gfx: Graphics,
  entity: Entity,
  x: number,
  y: number,
  radius: number,
  body: number,
  palette: PropPalette,
  seconds: number
): void {
  const facing = entity.transform.facing;
  const dx = Math.cos(facing);
  const dy = Math.sin(facing);
  const half = radius;

  gfx.moveTo(x - dx * half, y - dy * half);
  gfx.lineTo(x + dx * half, y + dy * half);
  gfx.stroke({ width: body * 2.2, color: palette.base, alpha: 0.55 });

  gfx.moveTo(x - dx * half, y - dy * half);
  gfx.lineTo(x + dx * half, y + dy * half);
  gfx.stroke({ width: body * 2.2, color: palette.edge, alpha: 0.5 });

  // Chevrons travel with the belt. The phase comes from the clock, so a paused simulation
  // still shows which way the belt would push.
  const spacing = Math.max(radius / 3, 14);
  const roll = (seconds * radius * 1.6) % spacing;
  for (let d = -half + roll; d < half; d += spacing) {
    const cx = x + dx * d;
    const cy = y + dy * d;
    const wing = Math.min(body * 0.9, spacing * 0.35);
    // Two strokes forming a ">" pointing along the direction of travel.
    gfx.moveTo(cx - dx * wing * 0.6 - dy * wing, cy - dy * wing * 0.6 + dx * wing);
    gfx.lineTo(cx + dx * wing * 0.7, cy + dy * wing * 0.7);
    gfx.lineTo(cx - dx * wing * 0.6 + dy * wing, cy - dy * wing * 0.6 - dx * wing);
    gfx.stroke({ width: 2, color: palette.glow, alpha: 0.55 });
  }

  gfx.circle(x, y, body);
  gfx.fill({ color: palette.base, alpha: 0.9 });
  gfx.stroke({ width: 1.5, color: palette.edge });
}

/** A pad that visibly compresses when it has just thrown something. */
function drawSpring(
  gfx: Graphics,
  entity: Entity,
  x: number,
  y: number,
  radius: number,
  body: number,
  palette: PropPalette
): void {
  const behavior = entity.behavior;
  const squash = cooldown(entity, behavior?.cooldownTicks ?? 0);

  gfx.circle(x, y, radius);
  gfx.fill({ color: palette.base, alpha: 0.28 });
  gfx.circle(x, y, radius);
  gfx.stroke({ width: 2, color: palette.edge, alpha: 0.7 });

  // Coils: they pull inward while the pad is depressed and spring back out afterwards.
  for (let i = 0; i < 3; i += 1) {
    const ring = radius * (0.34 + i * 0.22) * (1 - 0.3 * squash);
    gfx.circle(x, y, ring);
    gfx.stroke({ width: 2, color: palette.glow, alpha: 0.35 + i * 0.18 });
  }

  gfx.circle(x, y, body * (1 - 0.35 * squash));
  gfx.fill(palette.edge);
  gfx.stroke({ width: 1.5, color: palette.glow, alpha: 0.9 });
}

/** A barrel with a blinking fuse; once it has blown it leaves a scorch mark. */
function drawExplosive(
  gfx: Graphics,
  entity: Entity,
  x: number,
  y: number,
  radius: number,
  body: number,
  palette: PropPalette,
  seconds: number
): void {
  if (entity.mechanism?.spent) {
    // A spent barrel is not removed from the world, so it must look spent rather than
    // look like a live one that failed to fire.
    gfx.circle(x, y, radius * 0.85);
    gfx.fill({ color: SCORCH, alpha: 0.45 });
    for (let i = 0; i < 8; i += 1) {
      const angle = (i * Math.PI) / 4;
      gfx.moveTo(x + Math.cos(angle) * radius * 0.28, y + Math.sin(angle) * radius * 0.28);
      gfx.lineTo(x + Math.cos(angle) * radius * 0.8, y + Math.sin(angle) * radius * 0.8);
    }
    gfx.stroke({ width: 2, color: 0x2a2f3a, alpha: 0.75 });
    gfx.circle(x, y, body * 0.6);
    gfx.fill({ color: 0x1b1f28, alpha: 0.8 });
    return;
  }

  gfx.circle(x, y, radius);
  gfx.fill({ color: palette.base, alpha: 0.24 });
  gfx.circle(x, y, radius);
  gfx.stroke({ width: 2, color: palette.edge, alpha: 0.6 });

  gfx.circle(x, y, body);
  gfx.fill(palette.base);
  gfx.stroke({ width: 2, color: palette.edge });

  // Blinking fuse. The blink is the tell that this thing is live ordnance.
  const blink = 0.5 + 0.5 * Math.sin(seconds * 6.5);
  gfx.circle(x, y, body * 0.45);
  gfx.fill({ color: palette.glow, alpha: 0.25 + 0.65 * blink });
}

/** Floor spikes: they stay extended while reacting, then retract over their cooldown. */
function drawSpike(
  gfx: Graphics,
  entity: Entity,
  x: number,
  y: number,
  radius: number,
  body: number,
  palette: PropPalette
): void {
  const behavior = entity.behavior;
  const extended = entity.mechanism?.latched ? 1 : cooldown(entity, behavior?.cooldownTicks ?? 0);

  gfx.circle(x, y, radius);
  gfx.fill({ color: palette.base, alpha: 0.2 });
  gfx.circle(x, y, radius);
  gfx.stroke({ width: 2, color: palette.edge, alpha: 0.45 + 0.4 * extended });

  const spokes = 8;
  const inner = radius * 0.22;
  const outer = radius * (0.35 + 0.6 * extended);
  for (let i = 0; i < spokes; i += 1) {
    const angle = (i * Math.PI * 2) / spokes;
    const half = 0.16;
    gfx.poly([
      x + Math.cos(angle - half) * inner, y + Math.sin(angle - half) * inner,
      x + Math.cos(angle) * outer, y + Math.sin(angle) * outer,
      x + Math.cos(angle + half) * inner, y + Math.sin(angle + half) * inner
    ]);
    gfx.fill({ color: palette.glow, alpha: 0.3 + 0.55 * extended });
  }

  gfx.circle(x, y, body);
  gfx.fill(palette.base);
  gfx.stroke({ width: 1.5, color: palette.edge });
}

/** A turret: fixed base, barrel along its facing, muzzle glow that charges before firing. */
function drawTurret(
  gfx: Graphics,
  entity: Entity,
  x: number,
  y: number,
  radius: number,
  body: number,
  palette: PropPalette
): void {
  const behavior = entity.behavior;
  const charge = cadence(entity, behavior?.intervalTicks ?? 0);
  const facing = entity.transform.facing;
  const dx = Math.cos(facing);
  const dy = Math.sin(facing);

  // The reach is shown faintly: a turret that can shoot across the arena must look like it.
  gfx.moveTo(x, y);
  gfx.lineTo(x + dx * radius, y + dy * radius);
  gfx.stroke({ width: 2, color: palette.glow, alpha: 0.12 + 0.2 * charge });

  gfx.circle(x, y, body * 1.35);
  gfx.fill(palette.base);
  gfx.stroke({ width: 2, color: palette.edge });

  gfx.moveTo(x, y);
  gfx.lineTo(x + dx * radius * 0.92, y + dy * radius * 0.92);
  gfx.stroke({ width: body * 0.85, color: palette.edge });
  gfx.moveTo(x, y);
  gfx.lineTo(x + dx * radius * 0.92, y + dy * radius * 0.92);
  gfx.stroke({ width: body * 0.45, color: palette.base });

  const muzzleX = x + dx * radius * 0.92;
  const muzzleY = y + dy * radius * 0.92;
  gfx.circle(muzzleX, muzzleY, 2 + body * 0.5 * charge);
  gfx.fill({ color: palette.glow, alpha: 0.35 + 0.6 * charge });
}

/** A shrine: a slow breathing halo around a diamond, no moving parts. */
function drawShrine(
  gfx: Graphics,
  entity: Entity,
  x: number,
  y: number,
  radius: number,
  body: number,
  palette: PropPalette,
  seconds: number
): void {
  const behavior = entity.behavior;
  const charge = cadence(entity, behavior?.intervalTicks ?? 0);
  const breath = 0.5 + 0.5 * Math.sin(seconds * 1.5);

  gfx.circle(x, y, radius * (0.72 + 0.1 * breath));
  gfx.fill({ color: palette.base, alpha: 0.18 });
  gfx.circle(x, y, radius);
  gfx.stroke({ width: 2, color: palette.glow, alpha: 0.25 + 0.4 * charge });

  const size = body * 1.7;
  gfx.poly([x, y - size, x + size, y, x, y + size, x - size, y]);
  gfx.fill(palette.base);
  gfx.stroke({ width: 2, color: palette.glow, alpha: 0.75 });

  gfx.circle(x, y, body * 0.4);
  gfx.fill({ color: palette.glow, alpha: 0.4 + 0.5 * charge });
}
