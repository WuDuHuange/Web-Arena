export { Battle, cadenceTicks } from "./battle.ts";
export type { TickOutcome } from "./battle.ts";
export { stepCombat, selectAbility, stopDistanceFor } from "./combat.ts";
export type { CombatStepResult, DamageEvent } from "./combat.ts";
export { FixedStepClock } from "./clock.ts";
export type { ClockOptions } from "./clock.ts";
export {
  NEUTRAL_MODIFIER,
  TAG_RULES,
  applyBuff,
  hasTag,
  ignoresGroundHazards,
  modifiersOf,
  stepBuffs
} from "./effects.ts";
export type { BuffCatalog, StatModifier, TagRule } from "./effects.ts";
export {
  angleDelta,
  distance,
  headingTo,
  hitsCone,
  hitsLine,
  hitsMelee,
  hitsArea,
  hitsTarget,
  normalizeAngle,
  turnToward
} from "./geometry.ts";
export type { CircleTarget } from "./geometry.ts";
export { edgeDistance, findNearestTarget, isHostile, resolveFacing, resolveMovementIntent } from "./ai.ts";
export { createRng } from "./rng.ts";
export type { Rng } from "./rng.ts";
export {
  blast,
  chainTargets,
  mechanismAffects,
  overlapsMechanism,
  segmentHitsCircle,
  stepMechanisms,
  stepProjectiles
} from "./mechanisms.ts";
export type {
  MechanismDamage,
  MechanismTickResult,
  ProjectileRequest,
  VelocityOverlay
} from "./mechanisms.ts";
export { GREYBOX_BOUNDS, createWorldFromSetup, greyboxSetup } from "./spawn.ts";
export {
  PRESSURE_BOUNDS,
  compressionSetup,
  cornerSetup,
  pressureSetup,
  tunnellingSetup
} from "./pressure.ts";
export type { PressureOptions, SceneOffset } from "./pressure.ts";
export { Simulation } from "./simulation.ts";
export type { SimulationOptions } from "./simulation.ts";
export type {
  AbilityGeometry,
  AbilitySpec,
  BattleSetup,
  BuffApplication,
  BuffInstance,
  BuffSpec,
  Collider,
  Combat,
  CombatProfile,
  Entity,
  EntityId,
  EntityKind,
  Faction,
  Health,
  Mechanism,
  Motion,
  MutableVec2,
  Projectile,
  PropBehavior,
  PropTrigger,
  RenderRef,
  SpawnDef,
  Transform,
  WorldSnapshot
} from "./types.ts";
export { World } from "./world.ts";
