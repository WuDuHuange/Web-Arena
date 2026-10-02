import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CONTENT_LIBRARY, TAG_LABELS } from "../content/library.ts";
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
import type { Battlefield } from "../render/battlefield.ts";
import type { PlacementMarker } from "../render/placement.ts";
import { createCueDetector } from "../audio/detect.ts";
import type { CueDetector } from "../audio/detect.ts";
import { createAudioEngine } from "../audio/synth.ts";
import type { AudioEngine } from "../audio/synth.ts";
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
  const setupRef = useRef<BattleSetup | null>(null);
  const audioRef = useRef<AudioEngine | null>(null);
  const cuesRef = useRef<CueDetector | null>(null);
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
  const [helpOpen, setHelpOpen] = useState(() => !readHelpSeen());
  const [importIssues, setImportIssues] = useState<readonly string[]>([]);
  const [importSummary, setImportSummary] = useState<DeploymentSummary | null>(null);
  /** Flips once the WebGL battlefield exists, so effects can wait for it. */
  const [battlefieldReady, setBattlefieldReady] = useState(false);
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
    phaseRef.current = next;
    setPhase(next);
  }, []);

  // --- The draft is the layout -------------------------------------------------

  const issues: readonly DraftIssue[] = useMemo(
    () => validateDraft(draft, bounds, DRAFT_CATALOG),
    [draft, bounds]
  );
  const errors = useMemo(() => issues.filter((issue) => issue.level === "error"), [issues]);
  const readiness = useMemo(() => draftReadiness(draft), [draft]);
  const canStart = readiness.ready && errors.length === 0;

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
          simulation.advance(delta);
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
    }, 250);

    return () => {
      disposed = true;
      window.clearInterval(poll);
      window.cancelAnimationFrame(frame);
      simulationRef.current = null;
      audioRef.current?.destroy();
      audioRef.current = null;
      cuesRef.current = null;
      delete (window as unknown as { __arenaBench?: unknown }).__arenaBench;
    };
  }, [applyPhase]);

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

    void createBattlefield(host, bounds).then((battlefield) => {
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
    applyPhase("running");
  }, [buildSetup, applyPhase]);

  const handleToggleMute = useCallback(() => {
    setMuted((previous) => {
      const next = !previous;
      audioRef.current?.setMuted(next);
      return next;
    });
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
    <div className="app">
      <header className="app__header">
        <h1>Project Arena</h1>
        <span className="app__badge">对战闭环</span>
        <span className="app__badge">场景：{scene}</span>
        <button type="button" className="app__help" onClick={() => setHelpOpen(true)}>
          说明
        </button>
      </header>

      <main className="app__main">
        <div className="app__stage" ref={hostRef} />

        <aside className="app__panel">
          <section className="panel__block">
            <h2>会话</h2>
            <p className="panel__phase">{phaseLabel(phase)}</p>
            <div className="panel__buttons">
              <button
                type="button"
                onClick={handleStart}
                disabled={phase !== "editing" || !canStart}
                title={canStart ? undefined : readiness.reason || "布阵有未解决的问题"}
              >
                开战
              </button>
              <button type="button" onClick={() => applyPhase("paused")} disabled={phase !== "running"}>
                暂停
              </button>
              <button type="button" onClick={handleReset}>
                重置
              </button>
              <button type="button" onClick={handleToggleMute}>
                {muted ? "音效：关" : "音效：开"}
              </button>
            </div>
          </section>

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

          <section className="panel__block">
            <h2>兵装</h2>
            <ul className="panel__roster">
              {CONTENT_LIBRARY.characters.map((character) => (
                <li key={character.id}>
                  <span className={`roster__dot roster__dot--${character.id.split(".")[0]}`} />
                  {character.name}
                  {/* Tags sit next to the name rather than behind a tooltip: three of the
                      eight units carry one, and a player who never learns which three are
                      armoured has no way to read the battle. */}
                  {(character.tags ?? []).map((tag) => (
                    <span className="roster__tag" key={tag}>
                      {TAG_LABELS[tag] ?? tag}
                    </span>
                  ))}
                  <span className="roster__cost">{character.cost}</span>
                </li>
              ))}
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

          <ContentIssues
            result={VALIDATION}
            characters={CONTENT_LIBRARY.characters.length}
            abilities={CONTENT_LIBRARY.abilities.length}
            props={CONTENT_LIBRARY.props.length}
          />

          <CreditsPanel />

          <p className="panel__note">
            近战、扇形、穿透直线与圆形范围已接入；七类机关（熔岩、传送带、弹簧、炸药桶、地刺、炮台、祭坛）可仿真，表现与音效均为程序生成。Tag 与 Buff
            由能力表解释，布阵可在战场上直接拖拽编辑。
          </p>
        </aside>
      </main>

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
