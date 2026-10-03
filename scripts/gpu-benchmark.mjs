/**
 * Real-GPU frame rate measurement.
 *
 * Why this is a separate script: head-less Chrome renders through SwiftShader, a software
 * rasteriser, and its frame times are dominated by the environment rather than by the
 * scene. Measured that way, both the trap-free and the trap-heavy scene pinned at a p95 of
 * exactly 30.4 ms — a vsync beat, not a workload. Those numbers cannot answer the question
 * the architecture document actually asks ("does this hold 60 FPS at 100 units + 20 props").
 *
 * This launches a VISIBLE Chrome window so the measurement goes through the real GPU. A
 * window will open on screen and will close when the run finishes.
 *
 * Usage:
 *   npm run bench:gpu
 *   BENCH_SCENES="stress" BENCH_SECONDS=8 npm run bench:gpu
 *
 * While it runs, do not start anything else heavy — the point is a clean measurement.
 *
 * ---
 *
 * Why Node rather than the bash script this replaces. `npm run` on Windows goes through
 * cmd.exe, and cmd has no `bash` on PATH even on a machine with Git Bash installed — the
 * script simply never started. The alternatives were to hunt for bash.exe by absolute path
 * (which differs per install) or to stop needing it. Node is already the one runtime this
 * project cannot do without, and it removes a whole class of bugs on the way:
 *
 *   - `path.resolve()` returns a native path, so the profile lands at
 *     `C:\course_task\projectArena\.bench-chrome-gpu` and never at `C:\c\...`. The old
 *     script needed `cygpath` for exactly this, and silently leaked 68 MB per run when it
 *     was missing.
 *   - `SECONDS` is a bash special variable. `SECONDS=8 npm run bench:gpu` set the
 *     environment, then bash reset it to 0 on startup, so the old script measured for
 *     zero seconds and reported whatever the hook had collected. Node has no such trap;
 *     `BENCH_SECONDS` is read once and means what it says.
 *   - The scene list no longer depends on word splitting surviving a quoting layer.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PORT = Number(process.env.BENCH_PORT ?? 9333);
const PREVIEW_PORT = Number(process.env.BENCH_PREVIEW_PORT ?? 4173);
const SECONDS_PER_SCENE = Number(process.env.BENCH_SECONDS ?? process.env.SECONDS ?? 8);
const SCENES = (process.env.BENCH_SCENES ?? process.env.SCENES ?? "battle mechanism stress")
  .split(/[\s,]+/)
  .filter(Boolean);
const PROFILE_DIR = process.env.BENCH_PROFILE_DIR ?? ".bench-chrome-gpu";

if (!Number.isFinite(SECONDS_PER_SCENE) || SECONDS_PER_SCENE <= 0) {
  console.error(`BENCH_SECONDS 必须是正数，收到 ${SECONDS_PER_SCENE}。`);
  process.exit(2);
}
if (SCENES.length === 0) {
  console.error("BENCH_SCENES 为空，没有场景可测。");
  process.exit(2);
}

function findChrome() {
  const candidates = [
    process.env.CHROME,
    ...(process.platform === "win32"
      ? [
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
          process.env.LOCALAPPDATA
            ? path.join(process.env.LOCALAPPDATA, "Google\\Chrome\\Application\\chrome.exe")
            : null
        ]
      : []),
    ...(process.platform === "darwin"
      ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
      : []),
    ...(process.platform === "linux"
      ? ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]
      : [])
  ].filter(Boolean);

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

const CHROME_BIN = findChrome();
if (!CHROME_BIN) {
  console.error("找不到 Chrome。请设置 CHROME=<chrome 可执行文件完整路径> 后重试。");
  process.exit(1);
}

const VITE_BIN = path.join(ROOT, "node_modules", "vite", "bin", "vite.js");
if (!existsSync(VITE_BIN)) {
  console.error(`找不到 ${VITE_BIN}。请先运行 npm install。`);
  process.exit(1);
}

if (!existsSync(path.join(ROOT, "dist", "index.html"))) {
  console.error("dist/index.html 不存在。请先运行：npx vite build");
  process.exit(1);
}

// Chrome is handed a native path by construction — no conversion step, nothing to forget.
const PROFILE_PATH = path.resolve(ROOT, PROFILE_DIR);

let preview = null;
let chrome = null;

/**
 * Kill a child and its descendants.
 *
 * `child.kill()` on Windows terminates only the direct process: `npx vite` spawns a real
 * vite child, and Chrome spawns a whole process tree of its own. Orphaning either leaves a
 * server holding port 4173 or a window that never closes.
 */
function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  if (process.platform === "win32" && child.pid !== undefined) {
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  child.kill("SIGTERM");
}

let cleanedUp = false;
function cleanup() {
  if (cleanedUp) {
    return;
  }
  cleanedUp = true;
  killTree(chrome);
  killTree(preview);
}

process.on("exit", cleanup);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    cleanup();
    process.exit(130);
  });
}

async function reachable(url, timeoutMs = 1000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForReachable(url, attempts, intervalMs) {
  for (let i = 0; i < attempts; i++) {
    if (await reachable(url)) {
      return true;
    }
    await delay(intervalMs);
  }
  return false;
}

/** One scene's measurement, via the existing CDP client. */
function runScene(scene) {
  const url = `http://127.0.0.1:${PREVIEW_PORT}/?scene=${scene}`;
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        path.join(ROOT, "scripts", "benchmark.mjs"),
        url,
        `--seconds=${SECONDS_PER_SCENE}`,
        `--port=${PORT}`
      ],
      { cwd: ROOT, stdio: "inherit" }
    );
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

// --- preview server ----------------------------------------------------------

console.log(`启动预览服务 (127.0.0.1:${PREVIEW_PORT}) ...`);
preview = spawn(
  process.execPath,
  [VITE_BIN, "preview", "--port", String(PREVIEW_PORT), "--strictPort", "--host", "127.0.0.1"],
  { cwd: ROOT, stdio: "ignore" }
);

if (!(await waitForReachable(`http://127.0.0.1:${PREVIEW_PORT}/`, 40, 250))) {
  console.error(
    `预览服务未在 127.0.0.1:${PREVIEW_PORT} 就绪。端口被占用？dist/ 是否已构建？`
  );
  cleanup();
  process.exit(1);
}

// --- visible Chrome, real GPU ------------------------------------------------

console.log("启动有头 Chrome（真实 GPU）...");

// No --headless, no --disable-gpu, no SwiftShader: the whole point is the real pipeline.
// The page URL is passed up front rather than about:blank: Chrome exposes a `page` target
// for a real navigation, and this script needs one to attach to.
const chromeArgs = [
  `--remote-debugging-port=${PORT}`,
  "--remote-allow-origins=*",
  `--user-data-dir=${PROFILE_PATH}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
  "--window-size=1600,900",
  `http://127.0.0.1:${PREVIEW_PORT}/?scene=${SCENES[0]}`
];

const chromeStderr = [];
chrome = spawn(CHROME_BIN, chromeArgs, { cwd: ROOT, stdio: ["ignore", "ignore", "pipe"] });
chrome.stderr.on("data", (chunk) => {
  chromeStderr.push(chunk.toString());
  if (chromeStderr.length > 40) {
    chromeStderr.shift();
  }
});
chrome.on("exit", (code) => {
  if (!cleanedUp && code !== 0) {
    console.error(`Chrome 提前退出（code=${code}）。`);
    if (chromeStderr.length > 0) {
      console.error(chromeStderr.join("").trim());
    }
  }
});

const debugReady = await waitForReachable(`http://127.0.0.1:${PORT}/json/version`, 60, 250);
if (!debugReady) {
  console.error("Chrome 调试端口未就绪。");
  if (chromeStderr.length > 0) {
    console.error(chromeStderr.join("").trim());
  }
  cleanup();
  process.exit(1);
}

// A wrong path form is silent: Chrome still starts, the benchmark still runs, and the only
// symptom is 68 MB appearing somewhere you are not looking. Assert it landed where asked.
if (!existsSync(PROFILE_PATH)) {
  console.error(`警告：Chrome 未在 ${PROFILE_PATH} 建立 profile，请检查 --user-data-dir。`);
}

// --- measure -----------------------------------------------------------------

console.log();
console.log(`开始测量（每场景 ${SECONDS_PER_SCENE} 秒）。请不要在此时操作其他重负载程序。`);
console.log();

let failures = 0;
for (const scene of SCENES) {
  console.log(`=== scene=${scene} ===`);
  const code = await runScene(scene);
  if (code !== 0) {
    failures++;
  }
  console.log();
}

cleanup();

if (failures > 0) {
  console.error(`${failures}/${SCENES.length} 个场景未能完成测量。`);
  process.exit(1);
}

console.log("完成。上面的 fps / p95Ms 即为真机 GPU 读数，请与架构文档承诺的 60 FPS 对照。");
