import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  APPEARANCE_REGISTRY,
  findAppearanceProblems,
  overrideAppearance
} from "../content/appearance.ts";
import type { AppearanceEntry } from "../content/appearance.ts";
import { CONTENT_LIBRARY, PROP_LIBRARY, TAG_LABELS } from "../content/library.ts";
import { validateContent } from "../content/validate.ts";
import {
  DRAFT_CATALOG,
  PROP_ID_OF_BEHAVIOR,
  defaultMatchup,
  draftToSetup,
  mechanismMatchup,
  squadMatchup,
  stressMatchup
} from "../content/deployment.ts";
import {
  EMPTY_DRAFT,
  addProp,
  addUnit,
  draftFromSetup,
  draftReadiness,
  findPlacement,
  hitTestDraft,
  issuesByKey,
  movePlacement,
  removePlacement,
  rotatePlacement,
  summariseDraft,
  validateDraft
} from "../editor/draft.ts";
import type { DeploymentDraft, DraftBounds, DraftIssue } from "../editor/draft.ts";
import { exportDeployment } from "../persistence/snapshot.ts";
import { parseDeployment, summariseDeployment } from "../persistence/deployment-io.ts";
import type { DeploymentSummary } from "../persistence/deployment-io.ts";
import { createBattlefield } from "../render/battlefield.ts";
import { projectionKindFrom } from "../render/projection.ts";
import type { ProjectionKind } from "../render/projection.ts";
import { onVisibility } from "./attention.ts";
import type { AttentionState } from "./attention.ts";
import type { Battlefield } from "../render/battlefield.ts";
import type { AppearanceReportRow } from "../render/atlas.ts";
import type { PlacementMarker } from "../render/placement.ts";
import { createCueDetector } from "../audio/detect.ts";
import type { CueDetector } from "../audio/detect.ts";
import { createAudioEngine } from "../audio/synth.ts";
import type { AudioEngine } from "../audio/synth.ts";
import { createMusicChannel, shouldPlayMusic } from "../audio/music.ts";
import type { MusicChannel } from "../audio/music.ts";
import { BGM_URL } from "../assets/index.ts";
import { Simulation } from "../simulation/index.ts";
import type { BattleSetup, Faction } from "../simulation/index.ts";
import { ContentIssues } from "./ContentIssues.tsx";
import { CreditsPanel } from "./CreditsPanel.tsx";
import { DeploymentEditor } from "./DeploymentEditor.tsx";
import { HelpOverlay } from "./HelpOverlay.tsx";

/**
 * Content validation, run once at module load.
 *
 * The library is static data, so this cannot change while the app is running. Computing it
 * here rather than inside the effect keeps the result stable across re-renders and lets the
 * panel render it on the very first paint.
 */
const VALIDATION = validateContent(CONTENT_LIBRARY);

/**
 * Registry self-check, run once at module load for the same reason the library validation is.
 *
 * Reported separately from `VALIDATION` rather than folded into it: `VALIDATION` answers "can
 * this content be fought", and this answers "can this content be *drawn*. Folding them would
 * make one boolean stand for two questions, and the panel would then have no way to say which
 * one failed.
 */
const APPEARANCE_PROBLEMS = findAppearanceProblems();

/** Panel wording for the three load states. */
const APPEARANCE_STATE_LABEL: Record<AppearanceReportRow["state"], string> = {
  pending: "加载中",
  ready: "已就绪",
  failed: "加载失败"
};

/** Marks the help overlay as read, so it only auto-opens once. */
const HELP_SEEN_KEY = "project-arena.help.seen.v1";

/** Browser storage throws in private modes; a missing key is the safe fallback. */
function readHelpSeen(): boolean {
  try {
    return window.localStorage.getItem(HELP_SEEN_KEY) !== null;
  } catch {
    return false;
  }
}

function writeHelpSeen(): void {
  try {
    window.localStorage.setItem(HELP_SEEN_KEY, "1");
  } catch {
    // Not being able to remember is not a reason to fail the interaction.
  }
}

type Phase = "editing" | "running" | "paused" | "decided";

interface Readout {
  tick: number;
  entities: number;
  droppedMs: number;
  redAlive: number;
  blueAlive: number;
  mechanismDamage: number;
  /**
   * Live effect instances across the whole field.
   *
   * Counted rather than listed: the panel is a status readout, not a combat log, and what
   * a watcher needs to know is "is anything happening". Without this the effect system is
   * invisible — a slow changes how fast a unit walks, which is real but easy to miss, and
   * a number that only ever reads 0 looks identical to a system that is switched off.
   */
  activeEffects: number;
}

/** 60 Hz authoritative step. Render rate is free to differ. */
const FIXED_STEP_MS = 1000 / 60;

/**
 * Playback rates, as a multiplier on the frame delta the clock is fed.
 *
 * Capped at 4× because `Simulation` clamps catch-up at 8 steps per `advance` call: at 60 FPS
 * a 4× rate asks for four steps a frame, comfortably inside the clamp, while 8× would ask
 * for exactly the limit and start silently discarding simulated time the moment a frame ran
 * long. The clamp is not raised to make room — it is what stops a backgrounded tab from
 * replaying a backlog, and trading that away for a faster fast-forward is a bad deal.
 *
 * Slowing down is the point of the list as much as speeding up: a mechanism that fires for
 * three ticks is invisible at 60 Hz and obvious at 0.25×.
 */
const SPEEDS = [0.25, 0.5, 1, 2, 4] as const;

/** One arrow-key nudge, and the fine step with Shift held. */
const NUDGE_COARSE = 8;
const NUDGE_FINE = 1;

/** One turn of the facing control, in radians. Matches the panel's ↺ / ↻ buttons. */
const TURN = Math.PI / 12;

/**
 * Which deployment this session starts with.
 *
 * `?scene=battle` is the default: one of each archetype per side. `squad` fields three
 * copies of each, which is the crowded case worth benchmarking. `mechanism` drops both
 * squads onto a floor full of traps, which is the scene that exercises the field layer.
 * `stress` is the architecture's stated ceiling: 100 units plus 20 traps.
 *
 * The scene only chooses the *starting* draft. From the first drag onwards the layout is the
 * player's, which is what makes "clear the field and build one from nothing" the same
 * workflow as "adjust the default".
 */
function resolveSetup(): { setup: BattleSetup; scene: string } {
  const requested = new URLSearchParams(window.location.search).get("scene") ?? "battle";
  switch (requested) {
    case "squad":
      return { setup: squadMatchup(FIXED_STEP_MS, 3), scene: "squad" };
    case "mechanism":
      return { setup: mechanismMatchup(FIXED_STEP_MS), scene: "mechanism" };
    case "stress":
      return { setup: stressMatchup(FIXED_STEP_MS), scene: "stress" };
    default:
      return { setup: defaultMatchup(FIXED_STEP_MS), scene: "battle" };
  }
}

/**
 * Which projection the battlefield draws with.
 *
 * A modifier rather than another scene, because the interesting question is not "what does
 * the isometric view look like" but "what does *this* fight look like in it". Any scene can
 * be opened either way by changing one query parameter, which is what makes the two views
 * comparable at all.
 *
 * Read once at module load. The renderer rebuilds on arena bounds, not on this, so a value
 * that changed mid-session would be applied to nothing.
 */
const VIEW: ProjectionKind = projectionKindFrom(
  new URLSearchParams(window.location.search).get("view")
);

/**
 * Application shell.
 *
 * It owns session state and the render loop, and it reads low-frequency summaries from
 * the simulation. It never reaches into entities to mutate battle state directly.
 *
 * The deployment is a draft the player edits, and the world is rebuilt from that draft. There
 * is deliberately no second copy of the layout: the preview on screen while laying out is a
 * real `WorldSnapshot` of a real `Simulation` built from the draft, which is the only way to
 * make "what I arranged" and "what fights" the same thing rather than two things that agree
 * until the day they do not.
 */
export function App() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const simulationRef = useRef<Simulation | null>(null);
  const battlefieldRef = useRef<Battlefield | null>(null);
  const phaseRef = useRef<Phase>("editing");
  /**
   * Whether the current pause was imposed by a hidden page rather than asked for by the user.
   *
   * A ref rather than state because nothing renders it: it exists only so the return-from-
   * hidden transition can tell "our pause" from "the operator's pause". Keeping it out of the
   * render path also means the visibility listener never has to be reinstalled.
   */
  const autoPausedRef = useRef(false);
  const setupRef = useRef<BattleSetup | null>(null);
  const audioRef = useRef<AudioEngine | null>(null);
  const cuesRef = useRef<CueDetector | null>(null);
  const musicRef = useRef<MusicChannel | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  /**
   * The setup the draft was derived from.
   *
   * A `BattleSetup` carries more than placements — abilities, buffs, the character
   * projection, a seed — and the editor models none of them. Keeping the original around
   * means rebuilding from the draft cannot quietly drop them.
   */
  const templateRef = useRef<BattleSetup | null>(null);

  /**
   * The draft as the pointer handlers see it.
   *
   * The handlers are installed once per phase and must not close over a draft that has since
   * changed, or a drag would move a placement that is no longer there. Reading through a ref
   * also keeps the handlers from being reinstalled on every pointermove.
   */
  const draftRef = useRef<DeploymentDraft>(EMPTY_DRAFT);
  const dragRef = useRef<{ key: string; offsetX: number; offsetY: number } | null>(null);

  const [initial] = useState(() => resolveSetup());
  const [phase, setPhase] = useState<Phase>("editing");
  const [scene] = useState(initial.scene);
  const [bounds, setBounds] = useState<DraftBounds>(initial.setup.bounds);
  const [draft, setDraft] = useState<DeploymentDraft>(() =>
    draftFromSetup(initial.setup, PROP_ID_OF_BEHAVIOR)
  );
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  /**
   * Playback rate, and the ref the render loop reads.
   *
   * The loop is installed once, so it cannot close over a `speed` that changes later. The
   * ref is what lets the buttons take effect without tearing down the animation frame, and
   * writing both in one place is what keeps the two from drifting apart.
   */
  const [speed, setSpeed] = useState<number>(1);
  const speedRef = useRef(1);
  const [helpOpen, setHelpOpen] = useState(() => !readHelpSeen());
  /**
   * Whether the deployment drawer is showing.
   *
   * Open by default. The drawer is the sandbox's whole point — laying out a field is the
   * activity, not a setting — so hiding it behind a click would trade the product for the
   * impression of one. It floats and it collapses in one click; that is the game-feel half.
   */
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [importIssues, setImportIssues] = useState<readonly string[]>([]);
  const [importSummary, setImportSummary] = useState<DeploymentSummary | null>(null);
  /** Flips once the WebGL battlefield exists, so effects can wait for it. */
  const [battlefieldReady, setBattlefieldReady] = useState(false);
  /**
   * Live appearance state, read back from the renderer's own atlas.
   *
   * Deliberately not a second source of truth: the panel asks the battlefield what it is
   * drawing with, so a report of "已就绪" and a grey box on screen cannot both be true.
   */
  const [appearance, setAppearance] = useState<readonly AppearanceReportRow[]>([]);
  const [readout, setReadout] = useState<Readout>({
    tick: 0,
    entities: 0,
    droppedMs: 0,
    redAlive: 0,
    blueAlive: 0,
    mechanismDamage: 0,
    activeEffects: 0
  });

  const applyPhase = useCallback((next: Phase) => {
    // Every explicit transition clears the automatic mark. A phase the user asked for is never
    // an automatic pause, and the mark's only job is to let a return undo *our* pause — so an
    // operator pressing 暂停 and then switching tabs must come back to a battle still paused.
    autoPausedRef.current = false;
    phaseRef.current = next;
    setPhase(next);
  }, []);

  /**
   * Applies a decision from the attention policy, which owns the automatic mark.
   *
   * Separate from `applyPhase` precisely because that one clears the mark: routing an
   * automatic pause through it would erase the fact that makes a return able to undo it.
   */
  const applyAttention = useCallback((next: AttentionState) => {
    autoPausedRef.current = next.autoPaused;
    phaseRef.current = next.phase;
    setPhase(next.phase);
  }, []);

  // --- The draft is the layout -------------------------------------------------

  const issues: readonly DraftIssue[] = useMemo(
    () => validateDraft(draft, bounds, DRAFT_CATALOG),
    [draft, bounds]
  );
  const errors = useMemo(() => issues.filter((issue) => issue.level === "error"), [issues]);
  const readiness = useMemo(() => draftReadiness(draft), [draft]);
  const canStart = readiness.ready && errors.length === 0;
  const appearanceTally = useMemo(
    () => ({
      ready: appearance.filter((row) => row.state === "ready").length,
      pending: appearance.filter((row) => row.state === "pending").length,
      failed: appearance.filter((row) => row.state === "failed").length
    }),
    [appearance]
  );
  /**
   * Read from the registry rather than from the report, so "no keys registered" and "the
   * renderer has not reported yet" stay distinguishable. They both render as zero rows and
   * mean opposite things.
   */
  const registryKeyCount = Object.keys(APPEARANCE_REGISTRY).length;

  /**
   * Builds the battle the current draft describes.
   *
   * One function for the preview, the start button and the reset button, so the three can
   * never disagree about what the field contains.
   */
  const buildSetup = useCallback(
    (): BattleSetup =>
      draftToSetup(draft, {
        fixedStepMs: FIXED_STEP_MS,
        bounds,
        template: templateRef.current ?? undefined
      }),
    [draft, bounds]
  );

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  /**
   * Rebuilds the world from the draft, while laying out.
   *
   * Only in the 待命 phase: once a battle has started the world is the thing being watched,
   * and replacing it under the renderer would restart the fight the player is looking at.
   */
  useEffect(() => {
    if (phaseRef.current !== "editing") {
      return;
    }
    const setup = buildSetup();
    setupRef.current = setup;
    const simulation = new Simulation(setup);
    simulationRef.current = simulation;
    // Entity ids restart at zero, so stale cue state would report phantom damage on the
    // first frames of the new layout.
    cuesRef.current?.reset();
    battlefieldRef.current?.resetInterpolation();
    setReadout(readSummary(simulation));
  }, [buildSetup]);

  // --- Render loop and audio ---------------------------------------------------

  useEffect(() => {
    if (!VALIDATION.ok) {
      // Logged as well as shown in the panel: a head-less run has no panel, and a CI log is
      // where it gets read.
      console.error("content library is invalid", VALIDATION.issues);
    }

    let disposed = false;
    let frame = 0;
    let lastTime = 0;

    /**
     * Frame-time sampler.
     *
     * The architecture document promises 60 FPS at 100 units plus 20 props. That is a
     * measurement, not a claim, so the loop records real frame intervals and exposes a
     * small hook for scripts/benchmark.mjs to read. Sampling is off unless started, so
     * a normal session pays nothing.
     */
    const bench = {
      active: false,
      samples: [] as number[],
      startedAt: 0,
      start(): void {
        this.samples = [];
        this.startedAt = performance.now();
        this.active = true;
        // A benchmark is only meaningful while the simulation is actually running.
        applyPhase("running");
      },
      stop(): {
        frames: number;
        seconds: number;
        fps: number;
        avgMs: number;
        p50Ms: number;
        p95Ms: number;
        p99Ms: number;
        maxMs: number;
      } {
        this.active = false;
        const sorted = [...this.samples].sort((a, b) => a - b);
        const pick = (q: number): number => {
          if (sorted.length === 0) {
            return 0;
          }
          const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
          return sorted[idx] ?? sorted[sorted.length - 1] ?? 0;
        };
        const total = this.samples.reduce((acc, v) => acc + v, 0);
        const elapsed = (performance.now() - this.startedAt) / 1000;
        return {
          frames: this.samples.length,
          seconds: Number(elapsed.toFixed(2)),
          fps: Number((this.samples.length / Math.max(elapsed, 1e-6)).toFixed(1)),
          avgMs: Number((total / Math.max(this.samples.length, 1)).toFixed(3)),
          p50Ms: Number(pick(0.5).toFixed(3)),
          p95Ms: Number(pick(0.95).toFixed(3)),
          p99Ms: Number(pick(0.99).toFixed(3)),
          maxMs: Number((sorted.at(-1) ?? 0).toFixed(3))
        };
      }
    };
    (window as unknown as { __arenaBench?: typeof bench }).__arenaBench = bench;

    // Audio is built eagerly but stays silent until a gesture unlocks the context, and it
    // degrades to a no-op engine if the browser has no WebAudio at all. Nothing in the
    // battle path checks whether sound succeeded.
    audioRef.current = createAudioEngine();
    cuesRef.current = createCueDetector();
    // The music channel is built here but deliberately not started: starting is a gesture,
    // and 开战 is the gesture. See `handleStart`.
    musicRef.current = createMusicChannel({ url: BGM_URL });

    const loop = (now: number): void => {
      if (disposed) {
        return;
      }
      const delta = lastTime === 0 ? 0 : now - lastTime;
      lastTime = now;
      if (bench.active && delta > 0) {
        bench.samples.push(delta);
      }

      const simulation = simulationRef.current;
      if (simulation) {
        if (phaseRef.current === "running") {
          // The rate scales the *elapsed time* fed to the clock, never the step size: the
          // simulation still advances in whole fixed steps, so 0.25x and 4x produce the same
          // tick sequence as 1x, just spread across a different amount of wall-clock time.
          // Scaling the step size instead would change skill timing and damage numbers, which
          // is precisely what the fixed step exists to prevent.
          simulation.advance(delta * speedRef.current);
          const snapshot = simulation.snapshot();
          // Cues are derived from the snapshot, never emitted by the simulation, so a
          // dropped or duplicated frame can only affect sound — never battle state.
          for (const event of cuesRef.current?.detect(snapshot) ?? []) {
            audioRef.current?.play(event.cue, event.intensity);
          }
          if (simulation.decided) {
            // Freeze on the result rather than letting the last survivor keep walking.
            applyPhase("decided");
          }
        }
        // Rendered in every phase, including 待命: while laying out, this is the preview, and
        // it is the same call the running battle makes.
        battlefieldRef.current?.render(simulation.snapshot(), simulation.alpha, now);
      }

      frame = window.requestAnimationFrame(loop);
    };
    frame = window.requestAnimationFrame(loop);

    const poll = window.setInterval(() => {
      const simulation = simulationRef.current;
      if (simulation) {
        setReadout(readSummary(simulation));
      }
      setAppearance(battlefieldRef.current?.appearance() ?? []);
    }, 250);

    /**
     * Debug hook for `scripts/verify-appearance.mjs`, installed only under `?debug=1`.
     *
     * The three appearance states are decided in a pure function that the head-less tests
     * cover completely, and what they cannot cover is the last step: whether the pixels on
     * the canvas actually differ between them. That is the assertion this hook exists to
     * make possible — point a real key at a file that is not there, and require the failure
     * to be visible. Gated rather than always-on, because a shipped page should not carry a
     * handle that lets anything on it rewrite the asset table.
     */
    const debug = new URLSearchParams(window.location.search).get("debug") === "1";
    if (debug) {
      (window as unknown as { __arenaAppearance?: unknown }).__arenaAppearance = {
        registry: (): unknown => JSON.parse(JSON.stringify(APPEARANCE_REGISTRY)),
        override: (key: string, entry: AppearanceEntry | null): void => overrideAppearance(key, entry),
        report: (): readonly AppearanceReportRow[] => battlefieldRef.current?.appearance() ?? [],
        // Where each unit is and which key it draws with, so the smoke test can say *which*
        // unit it is looking at rather than hard-coding arena coordinates that a scene edit
        // would silently invalidate.
        units: (): readonly unknown[] =>
          simulationRef.current
            ?.snapshot()
            .entities.filter((entity) => !entity.behavior && !entity.projectile)
            .map((entity) => ({
              id: entity.id,
              appearance: entity.render.appearance,
              x: entity.transform.position.x,
              y: entity.transform.position.y,
              radius: entity.collider.radius
            })) ?? []
      };

      /**
       * Music probe, for the same reason the appearance one exists: "the track plays" is not
       * something a unit test can assert, and a silent arena has three different causes —
       * no audio element, a blocked autoplay, a file that never loaded — that look identical
       * from the outside. `readyState` and `errorCode` are what tell them apart.
       */
      (window as unknown as { __arenaMusic?: unknown }).__arenaMusic = {
        state: (): unknown => ({
          available: musicRef.current?.available ?? false,
          playing: musicRef.current?.playing ?? false,
          muted: musicRef.current?.muted ?? false,
          source: musicRef.current?.source ?? "",
          ...(musicRef.current?.diagnostics() ?? { readyState: 0, errorCode: null, volume: 0 })
        })
      };
    }

    return () => {
      disposed = true;
      window.clearInterval(poll);
      window.cancelAnimationFrame(frame);
      simulationRef.current = null;
      audioRef.current?.destroy();
      audioRef.current = null;
      cuesRef.current = null;
      musicRef.current?.destroy();
      musicRef.current = null;
      delete (window as unknown as { __arenaBench?: unknown }).__arenaBench;
      if (debug) {
        delete (window as unknown as { __arenaAppearance?: unknown }).__arenaAppearance;
        delete (window as unknown as { __arenaMusic?: unknown }).__arenaMusic;
      }
    };
  }, [applyPhase]);

  /**
   * Music follows the phase.
   *
   * `handleStart` calls `play()` inside the click, because a gesture is the one thing the
   * browser insists on. This effect is the other half of the policy: it stops the track on
   * 重置, and it is what keeps 暂停 and 已分胜负 audible rather than going quiet the moment a
   * battle is interrupted or decided. Both calls are idempotent, so the overlap on 开战 costs
   * nothing.
   */
  useEffect(() => {
    const music = musicRef.current;
    if (!music) {
      return;
    }
    if (shouldPlayMusic(phase)) {
      music.play();
    } else {
      music.stop();
    }
  }, [phase]);

  /**
   * A hidden page pauses the fight; looking at it again resumes.
   *
   * The architecture asks for this in §2.2 — "页面失焦默认暂停" — for the reason the same line
   * gives: a page nobody is rendering must not accumulate time. `?scene=stress` exists to show
   * what a backgrounded tab would otherwise be asked to do.
   *
   * The policy lives in `attention.ts` because that is the half worth testing without a
   * browser; this effect is only the wiring. It reads the refs at event time rather than
   * closing over the phase, so the listener is installed once and never reinstalled — which
   * matters here more than usual, because reinstalling a listener that is currently firing is
   * a good way to lose the event that mattered.
   */
  useEffect(() => {
    const onVisibilityChange = (): void => {
      const next = onVisibility(
        { phase: phaseRef.current, autoPaused: autoPausedRef.current },
        document.visibilityState === "visible"
      );
      // Identity is not the test — the policy returns the argument unchanged when there is
      // nothing to do, but the caller should not have to know that.
      if (next.phase === phaseRef.current && next.autoPaused === autoPausedRef.current) {
        return;
      }
      applyAttention(next);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [applyAttention]);

  /**
   * The battlefield is rebuilt when the arena changes size.
   *
   * An imported deployment may declare different bounds, and the fit transform is computed
   * from them at construction. Keeping the old battlefield would draw a 1200-wide arena
   * through a 960-wide transform: everything present, everything in the wrong place.
   */
  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }
    let disposed = false;
    setBattlefieldReady(false);

    void createBattlefield(host, bounds, { projection: VIEW }).then((battlefield) => {
      if (disposed) {
        battlefield.destroy();
        return;
      }
      battlefieldRef.current = battlefield;
      setBattlefieldReady(true);
    });

    return () => {
      disposed = true;
      battlefieldRef.current?.destroy();
      battlefieldRef.current = null;
      setBattlefieldReady(false);
    };
  }, [bounds]);

  // --- Pointer input ----------------------------------------------------------

  /**
   * Drag-to-place.
   *
   * Installed only while laying out, so a click during a battle cannot move a unit that the
   * simulation has already moved. The offset between the cursor and the body is preserved, so
   * grabbing a unit by its edge does not snap its centre under the pointer.
   */
  useEffect(() => {
    const battlefield = battlefieldRef.current;
    if (!battlefield) {
      return;
    }

    if (phase !== "editing") {
      battlefield.setPointerHandlers(null);
      return;
    }

    battlefield.setPointerHandlers({
      down(point) {
        const current = draftRef.current;
        const key = hitTestDraft(current, DRAFT_CATALOG, point.x, point.y);
        setSelectedKey(key ?? null);
        if (!key) {
          dragRef.current = null;
          return;
        }
        const placed = findPlacement(current, key);
        dragRef.current = placed
          ? { key, offsetX: point.x - placed.x, offsetY: point.y - placed.y }
          : null;
      },
      move(point) {
        const drag = dragRef.current;
        if (!drag) {
          return;
        }
        setDraft((current) =>
          movePlacement(
            current,
            drag.key,
            point.x - drag.offsetX,
            point.y - drag.offsetY,
            bounds,
            DRAFT_CATALOG
          )
        );
      },
      up() {
        dragRef.current = null;
      }
    });

    return () => {
      battlefield.setPointerHandlers(null);
    };
  }, [phase, bounds, battlefieldReady]);

  /** Selection and validity rings, drawn over the real preview. */
  useEffect(() => {
    const battlefield = battlefieldRef.current;
    if (!battlefield) {
      return;
    }
    if (phase !== "editing") {
      battlefield.setMarkers([]);
      return;
    }

    const byKey = issuesByKey(issues);
    const markers: PlacementMarker[] = [];

    for (const unit of draft.units) {
      const radius = DRAFT_CATALOG.unitRadius(unit.characterId) ?? 8;
      const kind = byKey.has(unit.key)
        ? "invalid"
        : unit.key === selectedKey
          ? "selected"
          : null;
      if (kind) {
        markers.push({ x: unit.x, y: unit.y, radius, kind });
      }
    }

    for (const prop of draft.props) {
      const kind = byKey.has(prop.key)
        ? "invalid"
        : prop.key === selectedKey
          ? "selected"
          : null;
      if (kind) {
        // Outlined at the effect radius, not the collider radius: the ring then traces the
        // footprint the renderer already draws, so it reads as "this pool" rather than as a
        // small circle floating in the middle of one.
        markers.push({
          x: prop.x,
          y: prop.y,
          radius: DRAFT_CATALOG.propEffectRadius(prop.propId) ?? 12,
          kind
        });
      }
    }

    battlefield.setMarkers(markers);
  }, [draft, selectedKey, issues, phase, battlefieldReady]);

  // --- Editing commands -------------------------------------------------------

  const handleAddUnit = useCallback(
    (characterId: string, faction: Faction) => {
      const result = addUnit(draft, characterId, faction, bounds, DRAFT_CATALOG);
      setDraft(result.draft);
      setSelectedKey(result.key || null);
    },
    [draft, bounds]
  );

  const handleAddProp = useCallback(
    (propId: string) => {
      const result = addProp(draft, propId, bounds, DRAFT_CATALOG);
      setDraft(result.draft);
      setSelectedKey(result.key || null);
    },
    [draft, bounds]
  );

  const handleRemove = useCallback(
    (key: string) => {
      setDraft((current) => removePlacement(current, key));
      setSelectedKey((current) => (current === key ? null : current));
    },
    []
  );

  const handleRotate = useCallback((key: string, delta: number) => {
    setDraft((current) => rotatePlacement(current, key, delta));
  }, []);

  const handleNudge = useCallback(
    (key: string, dx: number, dy: number) => {
      setDraft((current) => {
        const placed = findPlacement(current, key);
        if (!placed) {
          return current;
        }
        return movePlacement(current, key, placed.x + dx, placed.y + dy, bounds, DRAFT_CATALOG);
      });
    },
    [bounds]
  );

  const handleClear = useCallback(() => {
    setDraft(EMPTY_DRAFT);
    setSelectedKey(null);
  }, []);

  const handleRestoreScene = useCallback(() => {
    const { setup } = resolveSetup();
    templateRef.current = setup;
    setBounds(setup.bounds);
    setDraft(draftFromSetup(setup, PROP_ID_OF_BEHAVIOR));
    setSelectedKey(null);
    setImportIssues([]);
    setImportSummary(null);
    applyPhase("editing");
  }, [applyPhase]);

  /**
   * Keyboard editing.
   *
   * Arrow keys move by a whole world unit rather than by a screen pixel, so a nudge lands in
   * the same place whatever the window is doing — the same reason the draft stores world
   * coordinates in the first place.
   */
  useEffect(() => {
    if (phase !== "editing" || !selectedKey) {
      return;
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        handleRemove(selectedKey);
        return;
      }
      if (event.key === "Escape") {
        setSelectedKey(null);
        return;
      }
      if (event.key === "q" || event.key === "Q") {
        handleRotate(selectedKey, -TURN);
        return;
      }
      if (event.key === "e" || event.key === "E") {
        handleRotate(selectedKey, TURN);
        return;
      }

      const step = event.shiftKey ? NUDGE_FINE : NUDGE_COARSE;
      const deltas: Record<string, readonly [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step]
      };
      const delta = deltas[event.key];
      if (!delta) {
        return;
      }
      // Otherwise the arrow keys scroll the page out from under the arena.
      event.preventDefault();
      handleNudge(selectedKey, delta[0], delta[1]);
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, selectedKey, handleRemove, handleRotate, handleNudge]);

  // --- Session ----------------------------------------------------------------

  /**
   * Starts a battle.
   *
   * This doubles as the gesture that unlocks WebAudio — browsers refuse to start an
   * AudioContext without one — so the engine is resumed here rather than at construction.
   *
   * The world is rebuilt from the draft at this moment rather than reusing the preview's,
   * so the fight starts from exactly the layout that was on screen when the button was
   * pressed, whatever the last edit was and whenever it landed.
   */
  const handleStart = useCallback(() => {
    if (phaseRef.current !== "editing") {
      return;
    }
    const setup = buildSetup();
    setupRef.current = setup;
    const simulation = new Simulation(setup);
    simulationRef.current = simulation;
    cuesRef.current?.reset();
    battlefieldRef.current?.resetInterpolation();
    setReadout(readSummary(simulation));
    audioRef.current?.resume();
    // Inside the click, not from an effect: this is the gesture the browser requires before
    // it will let a track start. The phase effect below is the other half of the policy.
    musicRef.current?.play();
    applyPhase("running");
  }, [buildSetup, applyPhase]);

  const handleToggleMute = useCallback(() => {
    setMuted((previous) => {
      const next = !previous;
      audioRef.current?.setMuted(next);
      // Mute is a gain of zero, so the track keeps its place in the loop and unmuting
      // rejoins it rather than restarting the fight music from the top.
      musicRef.current?.setMuted(next);
      return next;
    });
  }, []);

  /**
   * Advances a paused battle by exactly one tick.
   *
   * Only from 暂停: a running battle is already advancing, and a decided one has nothing
   * left to advance. The readout is refreshed here rather than left to the 250 ms poll, so
   * the tick counter moves on the same click as the picture does.
   */
  const handleStepOnce = useCallback(() => {
    if (phaseRef.current !== "paused") {
      return;
    }
    const simulation = simulationRef.current;
    if (!simulation) {
      return;
    }
    simulation.stepManually();
    setReadout(readSummary(simulation));
  }, []);

  /** Writes the ref and the state together, so the loop and the buttons cannot disagree. */
  const handleChangeSpeed = useCallback((next: number) => {
    speedRef.current = next;
    setSpeed(next);
  }, []);

  /**
   * Restores the field to its starting state.
   *
   * Resets to the draft currently loaded, not to the scene default. After an import, "reset"
   * has to mean "back to the imported lineup"; re-resolving the scene here would make the
   * import evaporate the first time the button is pressed.
   */
  const handleReset = useCallback(() => {
    const setup = buildSetup();
    setupRef.current = setup;
    const simulation = new Simulation(setup);
    simulationRef.current = simulation;
    // Entity ids are handed out from zero again, so stale cue state would report phantom
    // damage on the first frames of the new battle.
    cuesRef.current?.reset();
    battlefieldRef.current?.resetInterpolation();
    setReadout(readSummary(simulation));
    applyPhase("editing");
  }, [buildSetup, applyPhase]);

  /**
   * Loads a deployment from a file the user picked.
   *
   * The file is untrusted input — it may have been hand-edited — so it is parsed and
   * validated before anything is built from it. A rejected file leaves the current battle
   * untouched rather than replacing it with a broken field.
   *
   * It becomes the draft as well as the setup, so the imported layout can be edited rather
   * than only watched. The imported setup is kept as the template, so anything the editor
   * does not model survives the first drag.
   */
  const handleDeploymentFile = useCallback(
    (file: File) => {
      void file
        .text()
        .then((text) => {
          const result = parseDeployment(text);
          if (!result.ok || !result.setup) {
            setImportIssues(result.issues);
            setImportSummary(null);
            return;
          }
          const setup = result.setup;
          templateRef.current = setup;
          setBounds(setup.bounds);
          setDraft(draftFromSetup(setup, PROP_ID_OF_BEHAVIOR));
          setSelectedKey(null);
          setImportIssues([]);
          setImportSummary(summariseDeployment(setup));
          applyPhase("editing");
        })
        .catch(() => {
          setImportIssues(["读取文件失败"]);
          setImportSummary(null);
        });
    },
    [applyPhase]
  );

  const handleExport = useCallback(() => {
    const setup = setupRef.current ?? buildSetup();
    const blob = new Blob([exportDeployment(setup)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "deployment.json";
    link.click();
    URL.revokeObjectURL(url);
  }, [buildSetup]);

  return (
    <div className="app" data-drawer={drawerOpen ? "open" : "closed"}>
      {/*
        The canvas is the page. Everything below floats over it, in rank order: what a
        watcher needs while a fight runs, then the sandbox controls, then the diagnostics.
      */}
      <div className="app__stage" ref={hostRef} />

      {/* Player layer — identity and the two controls that are never phase-dependent. */}
      <div className="hud hud--top">
        <div className="hud__cluster">
          <h1 className="hud__title">Project Arena</h1>
          {/*
            Two badges are always present. That is not decoration: the smoke test refuses to
            run on a page with fewer than two, because "the header rendered" is the cheapest
            way to tell a mounted app from a blank one.
          */}
          <span className="app__badge">沙盒</span>
          <span className="app__badge">场景：{scene}</span>
          {VIEW === "iso" && <span className="app__badge">视图：等距 2.5D（实验）</span>}
        </div>
        <div className="hud__cluster">
          <button
            type="button"
            className="hud__pill"
            aria-pressed={drawerOpen}
            onClick={() => setDrawerOpen((open) => !open)}
          >
            {drawerOpen ? "收起布阵" : "布阵"}
          </button>
          <button type="button" className="hud__pill" onClick={handleToggleMute}>
            {muted ? "声音：关" : "声音：开"}
          </button>
          <button type="button" className="hud__pill" onClick={() => setHelpOpen(true)}>
            说明
          </button>

          {/*
            Attribution, in the chrome rather than only inside the diagnostics drawer.

            The floor is CC0 and owes nothing, but the music is CC BY 4.0, which requires the
            credit to sit somewhere a visitor reaches without opening a panel. It is the last
            item of the top-right cluster — the utility row — for a layout reason rather than
            a stylistic one: the play bar is centred on the stage, so a pill parked in a
            bottom corner collides with the transport at around 1280 px, and the bottom-left
            column collides with it too. Both were measured, not guessed. A flex row that
            wraps is the one place in this chrome where nothing can be overlapped.

            The full record — title, author, licence link, acquisition date — is in the
            素材署名 block. This line is a pointer to it, not a replacement for it.
          */}
          <p className="hud__credit">音乐：魔王魂「8bit27」· CC BY 4.0</p>
        </div>
      </div>

      {/*
        Player layer — the transport.

        Phase, the five transport buttons and the rate live in one strip rather than in a
        sidebar block, because they are the only controls a watcher touches once a battle is
        running and they should never be a scroll away from the fight.
      */}
      <div className="hud hud--bottom">
        <div className="hud__playbar">
          <p className="panel__phase">{phaseLabel(phase)}</p>
          <div className="panel__buttons">
            <button
              type="button"
              className="panel__start"
              onClick={handleStart}
              disabled={phase !== "editing" || !canStart}
              title={canStart ? undefined : readiness.reason || "布阵有未解决的问题"}
            >
              开战
            </button>
            <button
              type="button"
              onClick={() => applyPhase(phase === "paused" ? "running" : "paused")}
              disabled={phase !== "running" && phase !== "paused"}
            >
              {phase === "paused" ? "继续" : "暂停"}
            </button>
            <button
              type="button"
              onClick={handleStepOnce}
              disabled={phase !== "paused"}
              title="推进一个 tick —— 60 Hz 下的 1/60 秒"
            >
              单步
            </button>
            <button type="button" onClick={handleReset}>
              重置
            </button>
          </div>
          {/*
            Playback rate. Available in every phase, not just while running: it is a setting
            for the next run as much as a control for this one, and a disabled control that
            silently changes nothing is worse than an enabled one.
          */}
          <div className="panel__speed" role="group" aria-label="播放速度">
            {SPEEDS.map((value) => (
              <button
                key={value}
                type="button"
                className={value === speed ? "is-active" : undefined}
                aria-pressed={value === speed}
                onClick={() => handleChangeSpeed(value)}
              >
                {value}×
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Player layer — the score, and below it the diagnostic layer. */}
      <div className="hud hud--left">
        <details className="hud__diag">
          <summary>诊断</summary>
          <div className="hud__diag-body">
            <section className="panel__block">
              <h2>战况</h2>
              <dl className="panel__readout">
                <dt>红方存活</dt>
                <dd className="panel__readout--red">{readout.redAlive}</dd>
                <dt>蓝方存活</dt>
                <dd className="panel__readout--blue">{readout.blueAlive}</dd>
                <dt>生效中效果</dt>
                <dd>{readout.activeEffects}</dd>
              </dl>
            </section>

            <section className="panel__block">
              <h2>诊断</h2>
              <dl className="panel__readout">
                <dt>Tick</dt>
                <dd>{readout.tick}</dd>
                <dt>实体</dt>
                <dd>{readout.entities}</dd>
                <dt>丢弃模拟时间</dt>
                <dd>{readout.droppedMs} ms</dd>
                <dt>机关伤害</dt>
                <dd>{readout.mechanismDamage}</dd>
              </dl>
            </section>

            <ContentIssues
              result={VALIDATION}
              characters={CONTENT_LIBRARY.characters.length}
              abilities={CONTENT_LIBRARY.abilities.length}
              props={CONTENT_LIBRARY.props.length}
            />

            <section className="panel__block">
              <h2>外观</h2>
              {APPEARANCE_PROBLEMS.length > 0 ? (
                <ul className="panel__issues">
                  {APPEARANCE_PROBLEMS.map((problem, index) => (
                    <li key={index}>
                      <span>{problem}</span>
                    </li>
                  ))}
                </ul>
              ) : null}

              {registryKeyCount === 0 ? (
                // Distinguished from "the battlefield is not up yet": both show no rows, and
                // they mean opposite things — one is a normal empty registry, the other is a
                // renderer that has not started.
                <p className="panel__note">注册表为空：当前全部图形由程序绘制，没有需要加载的素材。</p>
              ) : appearance.length === 0 ? (
                <p className="panel__note">外观层尚未就绪（战场还没建起来）。</p>
              ) : (
                <>
                  <p className={appearanceTally.failed > 0 ? "panel__alert" : "panel__ok"}>
                    <span
                      className={`panel__dot panel__dot--${appearanceTally.failed > 0 ? "warn" : "ok"}`}
                    />
                    注册表 {appearance.length} 键 · 就绪 {appearanceTally.ready} · 加载中{" "}
                    {appearanceTally.pending} · 失败 {appearanceTally.failed}
                  </p>
                  <ul className="panel__appearances">
                    {appearance.map((row) => (
                      <li key={row.key} className="panel__appearance-row">
                        <code>{row.key}</code>
                        <span className={`appearance__state appearance__state--${row.state}`}>
                          {APPEARANCE_STATE_LABEL[row.state]}
                        </span>
                        {row.reason ? (
                          <span className="appearance__reason">{row.reason}</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {/* The three states are spelled out because the difference between them is the
                  whole contract, and it is not visible in a screenshot: "no art" and "art that
                  failed to load" only look different because the renderer makes them differ. */}
              <p className="panel__note">
                键不在注册表里 = 没有素材，程序绘制，这是正常状态。表里有键但图没出来 =
                加载中或加载失败，战场上画成洋红虚线框——与程序绘制的圆身一眼可分，不会静默降级成「看起来正常的灰盒」。
                注册表在 <code>src/content/appearance.ts</code>。
              </p>
            </section>

            <CreditsPanel />

            <p className="panel__note">
              近战、扇形、穿透直线与圆形范围已接入；{PROP_LIBRARY.length} 类机关（
              {PROP_LIBRARY.map((prop) => prop.name).join("、")}
              ）可仿真。Tag 与 Buff 由能力表解释，布阵可在战场上直接拖拽编辑。
            </p>
          </div>
        </details>

        <div className="hud__score">
          <span className="hud__score-item hud__score-item--red">
            红 <b>{readout.redAlive}</b>
          </span>
          <span className="hud__score-sep">/</span>
          <span className="hud__score-item hud__score-item--blue">
            蓝 <b>{readout.blueAlive}</b>
          </span>
        </div>
      </div>

      {/* Sandbox layer — the deployment drawer. */}
      <aside className="app__panel" aria-label="布阵">
        <div className="drawer__head">
          <h2>布阵</h2>
          <button type="button" className="hud__pill" onClick={() => setDrawerOpen(false)}>
            收起
          </button>
        </div>
        <div className="drawer__body">
          <DeploymentEditor
            draft={draft}
            bounds={bounds}
            issues={issues}
            selectedKey={selectedKey}
            ready={readiness}
            locked={phase !== "editing"}
            onAddUnit={handleAddUnit}
            onAddProp={handleAddProp}
            onRemove={handleRemove}
            onRotate={handleRotate}
            onClear={handleClear}
            onRestore={handleRestoreScene}
          />

          <section className="panel__block">
            <h2>兵装</h2>
            <ul className="panel__roster">
              {CONTENT_LIBRARY.characters.map((character) => {
                // The ability is the unit's attack method, and it is the half of the pair a
                // player cannot guess from the name -- 腐爪 says "zombie", 撕咬 says what it
                // does. The first id in the rotation is the whole rotation today.
                const ability = CONTENT_LIBRARY.abilities.find(
                  (a) => a.id === character.abilityIds[0]
                );
                return (
                  <li key={character.id}>
                    <span className={`roster__dot roster__dot--${character.id.split(".")[0]}`} />
                    <span className="roster__main">
                      <span className="roster__head">
                        <span className="roster__name">{character.name}</span>
                        {/* Tags sit next to the name rather than behind a tooltip: three of
                            the eight units carry one, and a player who never learns which
                            three are armoured has no way to read the battle. */}
                        {(character.tags ?? []).map((tag) => (
                          <span className="roster__tag" key={tag}>
                            {TAG_LABELS[tag] ?? tag}
                          </span>
                        ))}
                        <span className="roster__cost">{character.cost}</span>
                      </span>
                      <span className="roster__blurb">
                        <span className="roster__ability">{ability?.name ?? "—"}</span>
                        {character.blurb}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>

          <section className="panel__block">
            <h2>布阵文件</h2>
            <div className="panel__buttons">
              <button type="button" onClick={handleExport}>
                导出 JSON
              </button>
              <button type="button" onClick={() => fileInputRef.current?.click()}>
                导入 JSON
              </button>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                // Clear the value first, or picking the same file twice in a row fires no
                // change event the second time and the import appears to do nothing.
                event.target.value = "";
                if (file) {
                  handleDeploymentFile(file);
                }
              }}
            />
            <p className="editor__summary">{summariseDraft(draft)}</p>
            {importSummary ? (
              <p className="panel__ok">
                <span className="panel__dot panel__dot--ok" />
                已载入 · {importSummary.units} 单位 / {importSummary.props} 机关 · {importSummary.bounds}
              </p>
            ) : null}
            {importIssues.length > 0 ? (
              <>
                <p className="panel__alert">
                  <span className="panel__dot panel__dot--warn" />
                  布阵文件被拒绝，当前战场未改动
                </p>
                <ul className="panel__issues">
                  {importIssues.map((issue, index) => (
                    <li key={index}>
                      <span>{issue}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </section>
        </div>
      </aside>

      {helpOpen ? (
        <HelpOverlay
          fixedStepMs={FIXED_STEP_MS}
          onClose={() => {
            setHelpOpen(false);
            writeHelpSeen();
          }}
          onDismissForever={() => {
            setHelpOpen(false);
            writeHelpSeen();
          }}
        />
      ) : null}
    </div>
  );
}

function phaseLabel(phase: Phase): string {
  switch (phase) {
    case "editing":
      return "待命";
    case "running":
      return "交战中";
    case "paused":
      return "已暂停";
    case "decided":
      return "已分胜负";
  }
}

/**
 * Reads the low-frequency summary the panel shows.
 *
 * Shared by the poll, the reset handler and the initial mount so the three can never
 * disagree. Without the mount call the panel reads all zeroes for the first quarter
 * second, which looks like an empty arena rather than a field waiting to start.
 */
function readSummary(simulation: Simulation): Readout {
  const entities = simulation.snapshot().entities;
  return {
    tick: simulation.tick,
    entities: entities.length,
    droppedMs: Math.round(simulation.droppedMs),
    redAlive: entities.filter((e) => e.combat && e.faction === "red").length,
    blueAlive: entities.filter((e) => e.combat && e.faction === "blue").length,
    mechanismDamage: Math.round(simulation.mechanismDamage),
    activeEffects: entities.reduce((total, e) => total + (e.buffs?.length ?? 0), 0)
  };
}
