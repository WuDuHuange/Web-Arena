import { useCallback, useEffect, useRef, useState } from "react";
import { exportDeployment } from "../persistence/snapshot.ts";
import { createBattlefield } from "../render/battlefield.ts";
import type { Battlefield } from "../render/battlefield.ts";
import { Simulation } from "../simulation/index.ts";
import type { BattleSetup } from "../simulation/index.ts";
import { greyboxSetup } from "../simulation/spawn.ts";
import { compressionSetup, cornerSetup, pressureSetup, tunnellingSetup } from "../simulation/pressure.ts";

type Phase = "editing" | "running" | "paused";

interface Readout {
  tick: number;
  entities: number;
  droppedMs: number;
}

/** 60 Hz authoritative step. Render rate is free to differ. */
const FIXED_STEP_MS = 1000 / 60;

/**
 * Resolves the deployment for this session.
 *
 * The greybox scene is the default. A `?scene=` query parameter swaps in one of the Phase 1
 * pressure scenes so the same build can be measured in a real browser without a rebuild.
 */
function resolveSetup(): { setup: BattleSetup; scene: string } {
  const requested = new URLSearchParams(window.location.search).get("scene") ?? "greybox";
  const heavy = { fixedStepMs: FIXED_STEP_MS, units: 100, props: 20 };

  switch (requested) {
    case "pressure":
      return { setup: pressureSetup(heavy), scene: "pressure" };
    case "compression":
      return { setup: compressionSetup(heavy), scene: "compression" };
    case "corner":
      return { setup: cornerSetup(heavy), scene: "corner" };
    case "tunnelling":
      return { setup: tunnellingSetup(heavy), scene: "tunnelling" };
    default:
      return { setup: greyboxSetup(FIXED_STEP_MS), scene: "greybox" };
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
  const [phase, setPhase] = useState<Phase>("editing");
  const [scene] = useState<string>(() => resolveSetup().scene);
  const [readout, setReadout] = useState<Readout>({ tick: 0, entities: 0, droppedMs: 0 });

  const applyPhase = useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
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

    const setup = resolveSetup().setup;
    simulationRef.current = new Simulation(setup);

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
        }
        battlefieldRef.current?.render(simulation.snapshot(), simulation.alpha);
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
      setReadout({
        tick: simulation.tick,
        entities: simulation.snapshot().entities.length,
        droppedMs: Math.round(simulation.droppedMs)
      });
    }, 250);

    return () => {
      disposed = true;
      window.clearInterval(poll);
      window.cancelAnimationFrame(frame);
      battlefieldRef.current?.destroy();
      battlefieldRef.current = null;
      simulationRef.current = null;
      delete (window as unknown as { __arenaBench?: unknown }).__arenaBench;
    };
  }, [applyPhase]);

  const handleReset = useCallback(() => {
    const setup = resolveSetup().setup;
    const simulation = new Simulation(setup);
    simulationRef.current = simulation;
    setReadout({ tick: 0, entities: simulation.snapshot().entities.length, droppedMs: 0 });
    applyPhase("editing");
  }, [applyPhase]);

  const handleExport = useCallback(() => {
    const blob = new Blob([exportDeployment(resolveSetup().setup)], { type: "application/json" });
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
        <span className="app__badge">架构骨架 · 灰盒</span>
        <span className="app__badge">场景：{scene}</span>
      </header>

      <main className="app__main">
        <div className="app__stage" ref={hostRef} />

        <aside className="app__panel">
          <section className="panel__block">
            <h2>会话</h2>
            <p className="panel__phase">{phaseLabel(phase)}</p>
            <div className="panel__buttons">
              <button type="button" onClick={() => applyPhase("running")} disabled={phase === "running"}>
                运行
              </button>
              <button type="button" onClick={() => applyPhase("paused")} disabled={phase !== "running"}>
                暂停
              </button>
              <button type="button" onClick={handleReset}>
                重置
              </button>
            </div>
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
            </dl>
          </section>

          <section className="panel__block">
            <h2>布阵</h2>
            <button type="button" onClick={handleExport}>
              导出布阵 JSON
            </button>
          </section>

          <p className="panel__note">
            编辑、寻敌、技能与伤害尚未实现。本骨架只验证固定步长时钟、物理适配与渲染分层。
          </p>
        </aside>
      </main>
    </div>
  );
}

function phaseLabel(phase: Phase): string {
  switch (phase) {
    case "editing":
      return "编辑中";
    case "running":
      return "运行中";
    case "paused":
      return "已暂停";
  }
}
