import { useCallback, useEffect, useRef, useState } from "react";
import { CONTENT_LIBRARY } from "../content/library.ts";
import { validateContent } from "../content/validate.ts";
import { defaultMatchup, mechanismMatchup, squadMatchup, stressMatchup } from "../content/deployment.ts";
import { exportDeployment } from "../persistence/snapshot.ts";
import { parseDeployment, summariseDeployment } from "../persistence/deployment-io.ts";
import type { DeploymentSummary } from "../persistence/deployment-io.ts";
import { createBattlefield } from "../render/battlefield.ts";
import type { Battlefield } from "../render/battlefield.ts";
import { createCueDetector } from "../audio/detect.ts";
import type { CueDetector } from "../audio/detect.ts";
import { createAudioEngine } from "../audio/synth.ts";
import type { AudioEngine } from "../audio/synth.ts";
import { Simulation } from "../simulation/index.ts";
import type { BattleSetup } from "../simulation/index.ts";
import { ContentIssues } from "./ContentIssues.tsx";
import { CreditsPanel } from "./CreditsPanel.tsx";
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
}

/** 60 Hz authoritative step. Render rate is free to differ. */
const FIXED_STEP_MS = 1000 / 60;

/**
 * Which deployment this session fights.
 *
 * `?scene=battle` is the default: one of each archetype per side. `squad` fields three
 * copies of each, which is the crowded case worth benchmarking. `mechanism` drops both
 * squads onto a floor full of traps, which is the scene that exercises the field layer.
 * `stress` is the architecture's stated ceiling: 100 units plus 20 traps.
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
 */
export function App() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const simulationRef = useRef<Simulation | null>(null);
  const battlefieldRef = useRef<Battlefield | null>(null);
  const phaseRef = useRef<Phase>("editing");
  const setupRef = useRef<BattleSetup>(defaultMatchup(FIXED_STEP_MS));
  const audioRef = useRef<AudioEngine | null>(null);
  const cuesRef = useRef<CueDetector | null>(null);

  const [phase, setPhase] = useState<Phase>("editing");
  const [scene] = useState<string>(() => resolveSetup().scene);
  const [muted, setMuted] = useState(false);
  const [helpOpen, setHelpOpen] = useState(() => !readHelpSeen());
  const [importIssues, setImportIssues] = useState<readonly string[]>([]);
  const [importSummary, setImportSummary] = useState<DeploymentSummary | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [readout, setReadout] = useState<Readout>({
    tick: 0,
    entities: 0,
    droppedMs: 0,
    redAlive: 0,
    blueAlive: 0,
    mechanismDamage: 0
  });

  const applyPhase = useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    // The library was validated once at module load. It is logged here as well as shown in
    // the panel, because a head-less run has no panel and a CI log is where it gets read.
    if (!VALIDATION.ok) {
      console.error("content library is invalid", VALIDATION.issues);
    }

    const { setup } = resolveSetup();
    setupRef.current = setup;

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

    simulationRef.current = new Simulation(setup);
    // Populate the panel immediately, so the first quarter second does not read as an
    // empty arena.
    setReadout(readSummary(simulationRef.current));

    // Audio is built eagerly but stays silent until a gesture unlocks the context, and it
    // degrades to a no-op engine if the browser has no WebAudio at all. Nothing in the
    // battle path checks whether sound succeeded.
    const audio = createAudioEngine();
    const cues = createCueDetector();
    audioRef.current = audio;
    cuesRef.current = cues;

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
          for (const event of cues.detect(snapshot)) {
            audio.play(event.cue, event.intensity);
          }
          if (simulation.decided) {
            // Freeze on the result rather than letting the last survivor keep walking.
            applyPhase("decided");
          }
        }
        battlefieldRef.current?.render(simulation.snapshot(), simulation.alpha, now);
      }

      frame = window.requestAnimationFrame(loop);
    };

    void createBattlefield(host, setup.bounds).then((battlefield) => {
      if (disposed) {
        battlefield.destroy();
        return;
      }
      battlefieldRef.current = battlefield;
      frame = window.requestAnimationFrame(loop);
    });

    const poll = window.setInterval(() => {
      const simulation = simulationRef.current;
      if (!simulation) {
        return;
      }
      setReadout(readSummary(simulation));
    }, 250);

    return () => {
      disposed = true;
      window.clearInterval(poll);
      window.cancelAnimationFrame(frame);
      battlefieldRef.current?.destroy();
      battlefieldRef.current = null;
      simulationRef.current = null;
      audioRef.current?.destroy();
      audioRef.current = null;
      cuesRef.current = null;
      delete (window as unknown as { __arenaBench?: unknown }).__arenaBench;
    };
  }, [applyPhase]);

  /**
   * Starts a battle.
   *
   * This doubles as the gesture that unlocks WebAudio — browsers refuse to start an
   * AudioContext without one — so the engine is resumed here rather than at construction.
   */
  const handleStart = useCallback(() => {
    audioRef.current?.resume();
    applyPhase("running");
  }, [applyPhase]);

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
   * Resets to whichever deployment is currently loaded, not to the scene default. After an
   * import, "reset" has to mean "back to the imported lineup"; re-resolving the scene here
   * would make the import evaporate the first time the button is pressed.
   */
  const handleReset = useCallback(() => {
    const setup = setupRef.current;
    const simulation = new Simulation(setup);
    simulationRef.current = simulation;
    // Entity ids are handed out from zero again, so stale cue state would report phantom
    // damage on the first frames of the new battle.
    cuesRef.current?.reset();
    setReadout(readSummary(simulation));
    applyPhase("editing");
  }, [applyPhase]);

  /**
   * Loads a deployment from a file the user picked.
   *
   * The file is untrusted input — it may have been hand-edited — so it is parsed and
   * validated before anything is built from it. A rejected file leaves the current battle
   * untouched rather than replacing it with a broken field.
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
          setupRef.current = setup;
          const simulation = new Simulation(setup);
          simulationRef.current = simulation;
          cuesRef.current?.reset();
          setImportIssues([]);
          setImportSummary(summariseDeployment(setup));
          setReadout(readSummary(simulation));
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
    const blob = new Blob([exportDeployment(setupRef.current)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "deployment.json";
    link.click();
    URL.revokeObjectURL(url);
  }, []);

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
                disabled={phase === "running" || phase === "decided"}
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

          <section className="panel__block">
            <h2>战况</h2>
            <dl className="panel__readout">
              <dt>红方存活</dt>
              <dd className="panel__readout--red">{readout.redAlive}</dd>
              <dt>蓝方存活</dt>
              <dd className="panel__readout--blue">{readout.blueAlive}</dd>
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
                  <span className="roster__cost">{character.cost}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className="panel__block">
            <h2>布阵</h2>
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
            近战、扇形、穿透直线与圆形范围已接入；七类机关（熔岩、传送带、弹簧、炸药桶、地刺、炮台、神龛）可仿真，表现与音效均为程序生成。Buff 与布阵编辑器尚未实现。
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
    mechanismDamage: Math.round(simulation.mechanismDamage)
  };
}
