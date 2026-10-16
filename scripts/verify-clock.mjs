/**
 * Time-control verification in a real browser.
 *
 * The head-less tests pin the clock's arithmetic. They cannot show that the buttons are
 * wired to it, which is the part that actually broke here: `settle()` can be perfect and
 * the step button can still be calling `advance()`.
 *
 * Three things, all of them wiring:
 *
 *   1. 单步 advances exactly one tick, and a paused battle does not drift.
 *   2. The rate control changes the rate, and 1× lands between 0.25× and 4×.
 *   3. A hidden page pauses the fight and looking again resumes it — but a pause the operator
 *      asked for survives the round trip. The policy is unit-tested in
 *      `tests/attention.test.mjs`; what cannot be tested there is that the listener is
 *      installed at all, which is exactly the failure that would ship silently.
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
/* Its own profile directory: a shared one serialises the sweep behind a stale lock. */
const PROFILE = path.resolve(ROOT, ".cdp-profile-clock");

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

/**
 * The dev server's own output, kept for the failure path.
 *
 * `stdio: "ignore"` was the wrong default here. When the app does not mount, the one piece
 * of evidence that separates "the server never came up" from "the server came up and served
 * something the page could not use" is what vite printed, and discarding it is what turned a
 * diagnosable failure into a one-line mystery. Bounded, because a server that has been
 * running for a while can print a lot and only the end matters when something is wrong.
 */
let devLog = "";
const dev = spawn(process.execPath, [viteBin, "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], {
  cwd: ROOT,
  stdio: ["ignore", "pipe", "pipe"]
});
for (const stream of [dev.stdout, dev.stderr]) {
  stream?.setEncoding("utf8");
  stream?.on("data", (chunk) => {
    devLog = (devLog + chunk).slice(-6000);
  });
}
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
    // The page under test is on 127.0.0.1. A browser that consults a proxy -- any proxy --
    // to reach its own dev server is testing the proxy as much as the app, and the sweep has
    // no business depending on how the operator's machine is configured.
    "--no-proxy-server",
    "--window-size=1280,800",
    "about:blank"
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
await send("Network.enable");
await send("Page.enable");

/**
 * The load timeline, captured from before the first byte.
 *
 * Chrome is launched on `about:blank` and navigated here only once the debugger is
 * attached. Launching straight at the URL looks equivalent and is not: the debugger
 * connects some fraction of a second into the load, so every request that has already gone
 * out -- including the one that never comes back -- is invisible, and a page that is stuck
 * and a page that is merely slow produce the same empty report.
 *
 * `outstanding` is the point of it: requests that were sent and neither finished nor
 * failed. A hung request is not an error, so it produces no console message and no
 * exception, which is exactly the shape of "the app is not mounted and nothing is wrong".
 */
const load = { domContentAt: null, loadAt: null };
const byId = new Map();
const outstanding = new Map();
const netFailures = [];
let requestCount = 0;
socket.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.method === "Page.domContentEventFired") load.domContentAt = Date.now();
  if (msg.method === "Page.loadEventFired") load.loadAt = Date.now();
  if (msg.method === "Network.requestWillBeSent") {
    const path = msg.params.request.url.replace(`http://127.0.0.1:${PORT}`, "");
    byId.set(msg.params.requestId, path);
    outstanding.set(msg.params.requestId, path);
    requestCount += 1;
  }
  if (msg.method === "Network.loadingFinished") {
    outstanding.delete(msg.params.requestId);
  }
  if (msg.method === "Network.loadingFailed") {
    outstanding.delete(msg.params.requestId);
    netFailures.push({
      url: byId.get(msg.params.requestId) ?? "?",
      error: msg.params.errorText,
      canceled: msg.params.canceled
    });
  }
});

const consoleErrors = [];
const exceptions = [];
socket.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
    consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
  }
  if (msg.method === "Runtime.exceptionThrown") {
    exceptions.push(msg.params.exceptionDetails.exception?.description ?? "exception");
  }
});

const navigatedAt = Date.now();
await send("Page.navigate", { url: PAGE_URL });

/**
 * What is actually on the other end, when the app is not.
 *
 * "app 未挂载" cannot distinguish three different failures, and all three have been seen:
 * a page that never loaded, a page that loaded and threw before React mounted, and a CDP
 * client attached to somebody else's browser. The third is not hypothetical --
 * `findPageTarget` takes the first page target on the port, so a stale Chrome from an
 * earlier run answers for a new one that never managed to bind, and from inside the script
 * that looks exactly like a page that will not mount. Hence the target list.
 *
 * The server probe is the other half: it asks the dev server for the entry module over
 * plain HTTP, which is the cheapest way to see a compile error or a dependency-optimizer
 * failure that the browser would only report as a blank page.
 */
const probeServer = async (path) => {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}${path}`);
    const body = await res.text();
    return { status: res.status, body: body.slice(0, 400) };
  } catch (error) {
    return { error: String(error) };
  }
};

const diagnose = async () => {
  const out = {
    targetUrl: target.url,
    consoleErrors,
    exceptions,
    load: {
      elapsedMs: Date.now() - navigatedAt,
      domContentAfterMs: load.domContentAt === null ? null : load.domContentAt - navigatedAt,
      loadEventAfterMs: load.loadAt === null ? null : load.loadAt - navigatedAt,
      requests: requestCount,
      outstanding: [...outstanding.values()],
      failures: netFailures
    },
    devServer: devLog.trim().split("\n").slice(-25)
  };
  try {
    out.page = await evaluate(`({
      href: location.href,
      readyState: document.readyState,
      title: document.title,
      canvas: !!document.querySelector("canvas"),
      bench: typeof window.__arenaBench,
      bodyLength: document.body ? document.body.innerHTML.length : -1,
      bodyHead: document.body ? document.body.innerHTML.slice(0, 200) : ""
    })`);
  } catch (error) {
    out.page = { error: String(error) };
  }
  try {
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
    out.targets = (await res.json()).map((t) => ({ type: t.type, url: t.url }));
  } catch (error) {
    out.targets = { error: String(error) };
  }
  out.server = { root: await probeServer("/"), entry: await probeServer("/src/main.tsx") };
  return out;
};

/**
 * How long the page gets to become a running app.
 *
 * Deliberately generous, because the failure this replaces was machine load rather than the
 * app. Measured on this machine: vite prints "ready" in 1.2 s when the machine is idle and
 * in 15.8 s during the release sweep, and the page's first load pays the cold transform cost
 * of the whole module graph on top of that. A budget tuned to an idle machine turns "the
 * operator's machine was busy" into "the product regressed" -- and the sweep runs these
 * scripts directly after a full build and four browser verifiers, which is the busiest this
 * machine ever gets. A genuine hang is still caught, and `diagnose()` now names the request
 * that never came back instead of leaving one line of Chinese behind.
 */
const MOUNT_BUDGET_MS = 90_000;

const mountStartedAt = Date.now();
const deadline = mountStartedAt + MOUNT_BUDGET_MS;
let mounted = false;
while (Date.now() < deadline) {
  mounted = await evaluate(`!!document.querySelector("canvas") && !!window.__arenaBench`);
  if (mounted) break;
  await delay(300);
}
if (!check(mounted, "app 未挂载")) {
  console.log(JSON.stringify({ ok: false, failures, diagnosis: await diagnose() }, null, 2));
  cleanup();
  process.exit(1);
}
notes.push({ mountedAfterMs: Date.now() - mountStartedAt });

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

  // --- Losing sight of the page pauses the fight ----------------------------

  /**
   * Drives the visibility API instead of waiting for it.
   *
   * Head-less Chrome reports `document.visibilityState` as "hidden" on its own, which makes
   * the *pause* direction trivial to trigger and the *resume* direction impossible — so the
   * two properties are redefined for the duration. This is the one place in the suite where a
   * browser API is faked, and it is faked because there is no honest way to look away: the
   * assertion here is about the **listener**, and the policy behind it is unit-tested.
   *
   * The `hidden` getter lives on `Document.prototype`, so defining it on the instance shadows
   * it without touching anything else on the page.
   */
  const setVisibility = async (value) => {
    await evaluate(`(() => {
      Object.defineProperty(document, "visibilityState", { value: ${JSON.stringify(value)}, configurable: true });
      Object.defineProperty(document, "hidden", { value: ${value === "visible" ? "false" : "true"}, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
      return document.visibilityState;
    })()`);
    await delay(400);
  };

  await ensurePaused();
  await click("继续");
  check((await phaseText()) === "交战中", "切出页面之前应先处于交战中");

  const visibleBefore = await settledTick();
  await setVisibility("hidden");
  const hiddenPhase = await phaseText();
  check(hiddenPhase === "已暂停", `切出页面应暂停，实得 ${hiddenPhase}`);

  // Read *after* the pause has settled, for the same reason `settledTick` exists: the panel
  // polls at 250 ms, so a reading taken at the instant of the transition is up to a quarter
  // of a second stale. Comparing that against a later reading would measure ticks that ran
  // while the battle was still running, and report them as drift under a pause.
  const hiddenFrom = await settledTick();
  await delay(700);
  const hiddenTo = await tick();
  check(hiddenTo === hiddenFrom, `切出页面后 tick 不应推进：${hiddenFrom} → ${hiddenTo}`);

  await setVisibility("visible");
  const backPhase = await phaseText();
  check(backPhase === "交战中", `回到页面应自动继续，实得 ${backPhase}`);

  // The case that matters most: a pause the operator asked for is not the page's to undo.
  await click("暂停");
  await setVisibility("hidden");
  await setVisibility("visible");
  const keptPhase = await phaseText();
  check(keptPhase === "已暂停", `手动暂停不应被切出/切回页面撤销，实得 ${keptPhase}`);

  notes.push({ autoPause: { tickBeforeHiding: visibleBefore, hiddenPhase, hiddenFrom, hiddenTo, backPhase, keptPhase } });

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
