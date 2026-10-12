/**
 * Time-control verification in a real browser.
 *
 * The head-less tests pin the clock's arithmetic. They cannot show that the buttons are
 * wired to it, which is the part that actually broke here: `settle()` can be perfect and
 * the step button can still be calling `advance()`.
 *
 * Runs against the dev server rather than a production build on purpose. A preview server
 * serves `dist/`, and a build that silently failed leaves `dist/` holding the previous
 * version — the verifier then passes while testing code that no longer exists. The dev
 * server has no such gap: it compiles what is on disk right now.
 *
 * Usage: node scripts/verify-clock.mjs [--port=5178] [--cdp=9346]
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const ROOT = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const readFlag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const PORT = Number(readFlag("port", "5178"));
const CDP_PORT = Number(readFlag("cdp", "9346"));
const PAGE_URL = `http://127.0.0.1:${PORT}/?scene=battle`;
const PROFILE = path.resolve(ROOT, ".cdp-profile");

const failures = [];
const notes = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
  return ok;
};

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
    ...(process.platform === "darwin" ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"] : []),
    ...(process.platform === "linux" ? ["/usr/bin/google-chrome", "/usr/bin/chromium"] : [])
  ].filter(Boolean);
  return candidates.find((c) => existsSync(c)) ?? null;
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32" && child.pid !== undefined) {
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  child.kill("SIGTERM");
}

const chromeBin = findChrome();
const viteBin = path.join(ROOT, "node_modules", "vite", "bin", "vite.js");
if (!chromeBin || !existsSync(viteBin)) {
  console.log(JSON.stringify({ ok: false, reason: "缺少 Chrome 或 vite" }, null, 2));
  process.exit(1);
}

const dev = spawn(process.execPath, [viteBin, "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], {
  cwd: ROOT,
  stdio: "ignore"
});
let chrome = null;
let socket = null;
let cleanedUp = false;
const cleanup = () => {
  if (cleanedUp) return;
  cleanedUp = true;
  try {
    socket?.close();
  } catch {
    // already closed
  }
  killTree(chrome);
  killTree(dev);
};
process.on("exit", cleanup);

async function waitForServer() {
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/`);
      if (res.ok) return true;
    } catch {
      // not listening yet
    }
    await delay(300);
  }
  return false;
}

if (!(await waitForServer())) {
  console.log(JSON.stringify({ ok: false, reason: `dev server 未在 ${PORT} 就绪` }, null, 2));
  cleanup();
  process.exit(1);
}

chrome = spawn(
  chromeBin,
  [
    "--headless=new",
    `--remote-debugging-port=${CDP_PORT}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${PROFILE}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--window-size=1280,800",
    PAGE_URL
  ],
  { cwd: ROOT, stdio: ["ignore", "ignore", "ignore"] }
);

async function findPageTarget() {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      // not up yet
    }
    await delay(250);
  }
  throw new Error("no page target");
}

const target = await findPageTarget();
socket = new WebSocket(target.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  }
});
await new Promise((resolve, reject) => {
  socket.addEventListener("open", () => resolve());
  socket.addEventListener("error", () => reject(new Error("CDP socket error")));
});
const send = (method, params = {}) => {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
};
const evaluate = async (expression) => {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? "evaluate threw");
  }
  return result.result?.value;
};

await send("Runtime.enable");

const deadline = Date.now() + 40_000;
let mounted = false;
while (Date.now() < deadline) {
  mounted = await evaluate(`!!document.querySelector("canvas") && !!window.__arenaBench`);
  if (mounted) break;
  await delay(300);
}
if (!check(mounted, "app 未挂载")) {
  console.log(JSON.stringify({ ok: false, failures }, null, 2));
  cleanup();
  process.exit(1);
}

// The help overlay covers the panel on first run.
await evaluate(`document.querySelector(".help__footer button")?.click()`);
await delay(200);

/**
 * Clicks a button by its visible label.
 *
 * A programmatic `.click()` still runs the real React handler — the synthetic event system
 * listens at the root container, so this is the same code path a mouse press takes. What it
 * does not exercise is hit-testing, which is not what this script is about.
 */
const click = async (label) => {
  const hit = await evaluate(`(() => {
    const button = [...document.querySelectorAll("button")]
      .find((b) => b.textContent.trim() === ${JSON.stringify(label)});
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!hit) throw new Error(`找不到按钮：${label}`);
  await delay(120);
};

const phaseText = () => evaluate(`document.querySelector(".panel__phase")?.textContent.trim() ?? ""`);

const tick = () =>
  evaluate(`(() => {
    const dt = [...document.querySelectorAll(".panel__readout dt")]
      .find((d) => d.textContent.trim() === "Tick");
    return dt ? Number(dt.nextElementSibling.textContent.trim()) : NaN;
  })()`);

// --- The step button advances exactly one tick ------------------------------

/**
 * Reads the tick once the panel's 250 ms poll has caught up.
 *
 * The readout is polled, not pushed, so reading it the instant a phase changes returns the
 * value from up to a quarter-second earlier. Only meaningful while the simulation is
 * standing still; while it is running there is nothing to settle to.
 */
const settledTick = async () => {
  await delay(400);
  return tick();
};

/** The pause button doubles as resume, so the label depends on the current phase. */
const ensurePaused = async () => {
  if ((await phaseText()) === "已暂停") return;
  await click("暂停");
};

try {
  await click("开战");
  check((await phaseText()) === "交战中", "开战 之后应处于交战中");

  await delay(600);
  await click("暂停");
  check((await phaseText()) === "已暂停", "暂停 之后应处于已暂停");

  const before = await settledTick();
  check(Number.isFinite(before) && before > 0, `暂停时 tick 应为正数，实得 ${before}`);

  const deltas = [];
  for (let i = 0; i < 3; i += 1) {
    const from = await tick();
    await click("单步");
    deltas.push((await tick()) - from);
  }
  check(
    deltas.every((d) => d === 1),
    `单步 每次应恰好推进 1 tick，实得 ${JSON.stringify(deltas)}`
  );
  notes.push({ stepDeltas: deltas, tickAfterSteps: await tick() });

  // A paused battle must not drift on its own.
  const heldFrom = await tick();
  await delay(700);
  const heldTo = await tick();
  check(heldTo === heldFrom, `已暂停时不应自行推进：${heldFrom} → ${heldTo}`);

  // --- The rate control actually changes the rate ---------------------------

  /**
   * Ticks observed over `ms` of wall time at the given rate.
   *
   * Both endpoints are read while paused, so neither is a stale poll. The window is kept
   * short deliberately: the battle reaches a decision at around 450 ticks, and running off
   * the end of it would leave the pause button disabled and the measurement meaningless.
   */
  const measure = async (rate, ms) => {
    await ensurePaused();
    await click(rate);
    const from = await settledTick();
    await click("继续");
    await delay(ms);
    await click("暂停");
    const to = await settledTick();
    return to - from;
  };

  const slow = await measure("0.25×", 800);
  const fast = await measure("4×", 800);
  notes.push({ ticksAtQuarterSpeed: slow, ticksAtQuadSpeed: fast });

  // Absolute tick counts depend on the head-less frame rate, which is not fixed. The ratio
  // is the part that must hold, and it must hold by a wide margin: 0.25x against 4x is a
  // factor of 16, so anything at or below 4 means the control is not reaching the clock.
  check(fast > slow * 4, `4× 的推进速度应远高于 0.25×：0.25× ${slow} tick / 4× ${fast} tick`);

  // And 1x must land between them, or the two ends are not a scale.
  const middle = await measure("1×", 800);
  notes.push({ ticksAtNormalSpeed: middle, tickAtEnd: await tick() });
  check(
    middle > slow && middle < fast,
    `1× 应落在 0.25× 与 4× 之间：${slow} < ${middle} < ${fast}`
  );

  // Guard against the measurement window silently outliving the battle.
  check((await phaseText()) !== "已分胜负", "测量期间不应分出胜负，否则速率读数无意义");

  // A screenshot is the only evidence that the controls are laid out sensibly; no DOM
  // assertion can see a button that wrapped onto its own line.
  const shotFlag = args.find((a) => a.startsWith("--shot="));
  if (shotFlag) {
    const out = path.resolve(ROOT, shotFlag.slice(7));
    const shot = await send("Page.captureScreenshot", { format: "png" });
    await writeFile(out, Buffer.from(shot.data, "base64"));
    notes.push({ screenshot: out });
  }
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
}

console.log(JSON.stringify({ ok: failures.length === 0, failures, notes }, null, 2));
cleanup();
process.exit(failures.length === 0 ? 0 : 1);
