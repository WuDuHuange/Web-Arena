/**
 * Domain vocabulary shared across the simulation core.
 *
 * Nothing in this file may reference the DOM, React, PixiJS or audio. The core is
 * expected to run head-less, including inside `node --test`.
 */

export type EntityId = number;

export type Faction = "red" | "blue" | "neutral";

export type EntityKind = "unit" | "prop" | "projectile";

export interface MutableVec2 {
  x: number;
  y: number;
}

/**
 * Placement in continuous world units. Deliberately abstract: never screen pixels,
 * so zoom, window size and DPI cannot change collision results.
 */
export interface Transform {
  position: MutableVec2;
  /**
   * Unit heading in radians. Stored rather than derived, because a stationary unit has
   * no velocity to infer a heading from and cone/line abilities still need one.
   */
  facing: number;
}

/** Linear motion intent. The physics adapter is the only writer of resolved values. */
export interface Motion {
  velocity: MutableVec2;
}

/** Hard-body footprint. Kept independent from the sprite size on purpose. */
export interface Collider {
  radius: number;
  mass: number;
  /** Static bodies never move but still block. */
  fixed: boolean;
}

export interface Health {
  current: number;
  max: number;
  /** Set when the entity has been reduced to zero. Kept as data, not by deletion. */
  dead?: boolean;
}

export interface RenderRef {
  /** Appearance key resolved by the renderer. The core never loads assets. */
  appearance: string;
}

/**
 * Combat state for an entity that can fight.
 *
 * Kept separate from Health so props and projectiles can carry health without needing a
 * targeting or ability system.
 *
 * Timing is expressed in whole ticks, never milliseconds, so a frame-rate drop cannot
 * change skill cadence. One ability runs at a time; the phase machine is:
 *
 *   cooldown -> windup -> active -> cooldown
 *
 * `phaseTicksLeft` counts down within the current phase, which keeps a single timing
 * authority instead of three counters that can drift out of sync.
 */
export interface Combat {
  /** Character this entity fights as. Resolves against the content library. */
  characterId: string;
  /** Index into the character's ability list, so rotation is a plain integer. */
  abilityIndex: number;
  phase: "windup" | "active" | "cooldown";
  /** Ticks remaining in the current phase. */
  phaseTicksLeft: number;
  /**
   * Whether the active frame has already applied damage.
   *
   * Without this guard a multi-tick active window would apply damage on every tick it
   * overlaps the same target, which is almost never the intent.
   */
  applied: boolean;
  /** How far this entity looks for a target. */
  aggroRange: number;
  /** Movement intent resolved by the AI system, in world units per second. */
  desiredVelocity: MutableVec2;
}

/**
 * An authored effect definition.
 *
 * Lives here rather than in the effects system for the same reason `AbilitySpec` lives
 * here: the content library and the runtime must share one shape, or they drift.
 */
export interface BuffSpec {
  readonly id: string;
  readonly name: string;
  readonly durationTicks: number;
  /** How many times this may stack. 1 means a re-application only refreshes it. */
  readonly maxStacks: number;
  readonly moveSpeed?: number;
  readonly damageOut?: number;
  readonly damageIn?: number;
  readonly attackRate?: number;
  /** Buff ids removed when this one lands. Mutual exclusion, declared rather than implied. */
  readonly excludes?: readonly string[];
}

/** A live effect on an entity. Mutable: it counts down and stacks. */
export interface BuffInstance {
  readonly id: string;
  /** Who applied it. Kept for attribution even though nothing reads it yet. */
  readonly sourceId: EntityId;
  ticksLeft: number;
  stacks: number;
}

/** What an ability does to whatever it hits, beyond damage. */
export interface BuffApplication {
  readonly buffId: string;
}

/**
 * Composition over inheritance: every entity carries the same small set of
 * components and differs by data, not by class.
 */
export interface Entity {
  id: EntityId;
  kind: EntityKind;
  faction: Faction;
  /** Declarative tags. A capability system decides what each tag actually means. */
  tags: readonly string[];
  transform: Transform;
  motion: Motion;
  collider: Collider;
  health: Health;
  render: RenderRef;
  /** Absent on anything that cannot fight: props, and later, plain projectiles. */
  combat?: Combat;
  /**
   * Present on field objects that do something when stepped on or when time passes.
   *
   * A prop with behaviour and no `mechanism` would be a trigger that never fires, which
   * is exactly the silent failure Phase 3 exists to rule out, so the two travel together.
   */
  behavior?: PropBehavior;
  mechanism?: Mechanism;
  /** Present on anything an emitter fired. */
  projectile?: Projectile;
  /**
   * Present on anything without an AI that still needs to keep moving: projectiles, and
   * anything a spring or a blast has thrown. See `PersistentVelocity`.
   */
  persistentVelocity?: PersistentVelocity;
  /**
   * Active timed effects. Absent rather than empty for most entities, so the modifier
   * lookup can take a fast path.
   */
  buffs?: BuffInstance[];
}

/**
 * Hit geometry, in world units.
 *
 * `range` is measured from the caster's edge, and `halfAngle` is the cone's half-width in
 * radians. These are the parameters a pure geometric test needs; nothing here depends on
 * the physics engine or on sprites.
 */
export interface AbilityGeometry {
  readonly kind: "melee" | "cone" | "line" | "circle";
  /** Reach of the attack, in world units. For `circle` this is the effect radius. */
  readonly range: number;
  /** Cone half-width in radians. Only meaningful for `kind: "cone"`. */
  readonly halfAngle?: number;
  /**
   * For `kind: "line"`: how wide the sweeping line is. A line attack is modelled as a
   * thick segment so a fast-moving target is still caught.
   */
  readonly width?: number;
  /**
   * For `kind: "circle"`: the effect is centred on the caster. When false it is centred
   * on the current target instead, which is how an aimed AoE is expressed.
   */
  readonly centredOnCaster?: boolean;
}

/**
 * A single ability, fully described by data.
 *
 * The split is deliberate: geometry decides *where* it hits, timing decides *when*, and
 * damage decides *how much*. A new character that reuses an existing combination needs
 * only new data; a genuinely new mechanic needs a new primitive in the resolver.
 */
export interface AbilitySpec {
  readonly id: string;
  readonly name: string;
  readonly geometry: AbilityGeometry;
  /** Ticks between committing to the attack and the damaging frame landing. */
  readonly windupTicks: number;
  /** Ticks the damaging frame is active for. */
  readonly activeTicks: number;
  /** Ticks of recovery after the active frame, before the next attack may begin. */
  readonly cooldownTicks: number;
  /** Damage applied on the active frame, before any mitigation. */
  readonly damage: number;
  /**
   * Whether the active frame hits every valid target in the geometry or stops after the
   * first. Single-target is what makes a melee strike feel like a duel rather than a
   * blender.
   */
  readonly maxTargets: number;
  /**
   * Multiplier applied to the caster's facing while casting. 0 means the caster keeps its
   * heading, 1 means it turns to face the target. Read as a data-driven knob so a wide
   * arc can be forgiving and a narrow line can demand accuracy.
   */
  readonly turnToTarget: number;
  /**
   * Effect applied to everything this ability hits, in addition to damage.
   *
   * Riding on the ability rather than on the character means "this attack slows" is a
   * property of the attack, which is what makes a rotation of several abilities able to
   * carry different effects without any per-character branching.
   */
  readonly appliesBuff?: BuffApplication;
}

/**
 * How a field object behaves. Purely data: the behaviour system switches on `kind` and
 * reads the numbers it needs, so adding a variant is a config change.
 *
 * The field is deliberately flat rather than a discriminated union. A union would be
 * type-safer, but it would also force the content library to carry the full shape of
 * every variant it is not using, and the validator — not the type system — is what
 * actually guards authored data. One optional-laden record keeps the library readable.
 */
export interface PropBehavior {
  readonly kind: PropTrigger;
  /** Radius of the effect, in world units. For a solid prop this is the body itself. */
  readonly radius: number;
  /** Damage per application. Zero for anything harmless. */
  readonly damage: number;
  /**
   * Ticks between damage applications.
   *
   * This is the field-object equivalent of the combat `applied` guard. A `stepCombat`
   * active window needs one flag because it lasts a few ticks; an aura lasts forever, so
   * it needs an explicit cadence instead. Without it, standing in lava for one second
   * deals 60 applications.
   */
  readonly intervalTicks: number;
  /** Ticks a triggered mechanism stays spent before it can fire again. */
  readonly cooldownTicks: number;
  /** Speed applied, in world units per second. Push strength for springs and blasts. */
  readonly force: number;
  /** Heading the force is applied along. Falls back to the prop's own facing. */
  readonly forceFacing?: number;
  /** Reach of an emitter's projectile, or of a trigger's proximity check. */
  readonly reach: number;
  /** Speed of an emitted projectile, in world units per second. */
  readonly projectileSpeed?: number;
  /** How far a blast or a projectile can chain to another mechanism. */
  readonly chainRadius?: number;
  /** Only substances that hurt are hostile; a conveyor cares about nobody's faction. */
  readonly affects: "all" | "hostile" | "none";
}

/** Field-object mechanism families. Mirrors the content layer's trigger vocabulary. */
export type PropTrigger =
  | "aura"
  | "conveyor"
  | "spring"
  | "explosive"
  | "spike"
  | "turret"
  | "shrine";

/** Ticks until a projectile expires. See `Projectile`. */
export interface Projectile {
  /** Damage on impact. */
  readonly damage: number;
  /** Ticks of life remaining. Counts down; a shot that reaches zero is removed. */
  ticksLeft: number;
  /** The mechanism that fired it, for attribution in diagnostics. */
  readonly sourceId: number;
}

/**
 * A velocity the entity carries itself, independent of any AI.
 *
 * `Motion.velocity` is the resolved value the physics engine actually integrates, and it is
 * rewritten from scratch every tick. That means an entity with no AI — a projectile, or a
 * unit standing on a spring — would have its velocity reset to zero on the very next tick
 * and stop dead the instant after it was launched.
 *
 * This is the base those entities are rebuilt from. It exists so an impulse survives more
 * than one tick without the overlay that produced it being re-applied, which is the
 * difference between a launch and an infinite thrust.
 */
export interface PersistentVelocity {
  x: number;
  y: number;
}

/** Read-only projection of the world, safe to hand to the renderer or diagnostics. */
export interface WorldSnapshot {
  readonly tick: number;
  readonly entities: readonly Entity[];
}

/**
 * Runtime state for a mechanism.
 *
 * Kept separate from `PropBehavior` because behaviour is authored content and this is
 * simulation state: resetting a battle must rebuild one and not touch the other.
 */
export interface Mechanism {
  /** Ticks until this mechanism may fire again. Counts down, clamped at zero. */
  cooldownTicksLeft: number;
  /** Ticks until the next periodic application, for continuous sources. */
  intervalTicksLeft: number;
  /** Set once a one-shot mechanism has fired and cannot fire again. */
  spent?: boolean;
  /** Set while a trigger is currently overlapping something it already reacted to. */
  latched?: boolean;
}

/** One placement entry of a deployment. */
export interface SpawnDef {
  readonly kind: EntityKind;
  readonly faction: Faction;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly mass: number;
  readonly hp: number;
  /** Initial linear velocity, in world units per second. */
  readonly vx?: number;
  readonly vy?: number;
  /** Initial heading in radians. Defaults to pointing at the opposing side. */
  readonly facing?: number;
  readonly tags?: readonly string[];
  readonly appearance?: string;
  /** Effects the entity starts the battle with, already resolved to live instances. */
  readonly buffs?: readonly BuffInstance[];
  /**
   * Character this spawn fights as. When present the entity gets a `combat` component
   * built from that character's ability list. Absent means a non-combatant.
   */
  readonly characterId?: string;
  /**
   * Mechanism this prop carries. Same reasoning as `characterId`: passed in rather than
   * looked up, so the core needs no content registry and a test can hand it a stub.
   */
  readonly behavior?: PropBehavior;
}

/** Immutable starting point of a battle. Resetting restores exactly this. */
export interface BattleSetup {
  readonly seed: number;
  /** Authoritative step length in milliseconds. Render rate never feeds back into it. */
  readonly fixedStepMs: number;
  readonly bounds: { readonly width: number; readonly height: number };
  readonly spawns: readonly SpawnDef[];
  /**
   * Ability definitions referenced by `characterId`.
   *
   * Passed in rather than imported so the simulation core stays free of any global
   * content registry: a test can hand it a two-ability stub, and head-less runs need no
   * asset pipeline.
   */
  readonly abilities: readonly AbilitySpec[];
  /**
   * Effect definitions the battle may apply, by id.
   *
   * Passed in for the same reason `abilities` is: the core resolves a buff id through what
   * it was handed, never through a global registry, so a test can supply two effects and
   * a head-less run needs no content pipeline.
   */
  readonly buffs?: readonly BuffSpec[];
  /**
   * Per-character combat stats the core needs to simulate a unit.
   *
   * A trimmed projection of the content library rather than the whole `CharacterDef`:
   * presentation fields like cost and appearance have no business in the simulation.
   */
  readonly characters?: readonly CombatProfile[];
}

/** Simulation-relevant slice of a character definition. */
export interface CombatProfile {
  readonly id: string;
  readonly abilityIds: readonly string[];
  /** Movement speed in world units per second while closing on a target. */
  readonly speed: number;
  /** How far this character looks for a target. */
  readonly aggroRange: number;
  /**
   * Declarative tags the character fights with.
   *
   * Carried on the profile rather than read from the content library so the core keeps its
   * "no global registry" property: a test can hand it a unit with any tag it likes.
   */
  readonly tags?: readonly string[];
}
