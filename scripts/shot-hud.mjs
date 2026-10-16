/**
 * HUD screenshot.
 *
 * Captures the running app at a normal desktop viewport, with the help overlay dismissed.
 * Separate from `shot-ui.mjs`, which overrides the viewport to something very tall and
 * scrolls the side panel — that was the right tool when everything lived in one scrolling
 * column, and it is the wrong one now that the chrome floats over a full-bleed canvas. A
 * tall viewport would show a lot of empty canvas and none of the layout.
 *
 * Runs against the dev server, not a preview of `dist/`: a failed build leaves the previous
 * bundle in `dist/`, and a screenshot of the previous bundle is worse than no screenshot.
 *
 * The capture waits for the asset layer to settle rather than for a fixed duration. It used
 * to sleep 1400 ms, and during a batch run that produced a screenshot of the *placeholder*
 * state: the arena was fully drawn, every unit was a magenta box, and the image read as a
 * finished render of a game whose art never loaded. That is the one confusion the appearance
 * layer exists to prevent, and a screenshot tool that captures mid-load manufactures it. The
 * settled appearance report goes into the output so the image can be checked against it.
 *
 * Usage: node scripts/shot-hud.mjs [--out=outputs/hud.png] [--scene=battle] [--view=flat]
 *                                 [--width=1600] [--height=900] [--drawer=open]
 *                                 [--port=5179] [--cdp=9348]
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const ROOT = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const readFlag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const OUT = path.resolve(ROOT, readFlag("out", "outputs/hud.png"));
const SCENE = readFlag("scene", "battle");
const VIEW = readFlag("view", "flat");
const WIDTH = Number(readFlag("width", "1600"));
const HEIGHT = Number(readFlag("height", "900"));
const DRAWER = readFlag("drawer", "open");
const PORT = Number(readFlag("port", "5179"));
/*
 * 9348, not 9347: `verify-music.mjs` already defaults to 9347, and this script is run
 * directly after it by the release sweep. Two scripts on one debugging port is not a
 * theoretical clash -- the second Chrome fails to bind, the CDP client then attaches to the
 * *first* one (still sitting on a different page), and the failure surfaces as "app 未挂载"
 * from a browser that is demonstrably running. The port audit is: 9333 bench/battle/shot-ui,
 * 9334 appearance/editor, 9336 iso, 9346 clock, 9347 music, 9348 here.
 */
const CDP_PORT = Number(readFlag("cdp", "9348"));
/* Per-port, so a run cannot collide with a previous one's profile lock either. */
const PROFILE = path.resolve(ROOT, `.cdp-profile-hud-${CDP_PORT}`);
const PAGE_URL = `http://127.0.0.1:${PORT}/?scene=${SCENE}&view=${VIEW}&debug=1`;

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
 * `stdio: "ignore"` discarded the only evidence that separates "the server never came up"
 * from "the server came up and served something the page could not use". Bounded, because
 * only the end matters when something is wrong.
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
    // The page under test is on 127.0.0.1; a browser that consults a proxy to reach its own
    // dev server is testing the proxy as much as the app, and the sweep must not depend on
    // how the operator's machine is configured.
    "--no-proxy-server",
    "--hide-scrollbars",
    // The same software rasteriser the other verifiers get, so a screenshot is reproducible
    // on a machine with no GPU and does not depend on the window being visible.
    "--use-gl=angle",
    "--use-angle=swiftshader",
    `--window-size=${WIDTH},${HEIGHT}`,
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
await send("Page.enable");

const errors = [];
const exceptions = [];
socket.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
    errors.push(msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
  }
  if (msg.method === "Runtime.exceptionThrown") {
    exceptions.push(msg.params.exceptionDetails.exception?.description ?? "exception");
  }
});

/**
 * What is actually on the other end, when the app is not.
 *
 * The errors and exceptions this script already collects are exactly the evidence that was
 * being thrown away: the failure path printed `reason: "app 未挂载"` and nothing else, so a
 * page that loaded and threw was indistinguishable from one that never loaded. The target
 * list is here for the same reason it is in the verifiers -- `findPageTarget` takes the first
 * page target on the port, so a stale Chrome answers for a new one that never managed to bind.
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
    errors,
    exceptions,
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
 * How long the page gets to become a running app. Generous on purpose: the sweep runs this
 * straight after a full build and four browser verifiers, and a cold dev server on a loaded
 * machine has been measured at 15.8 s just to print "ready" (1.2 s idle). A budget tuned to
 * an idle machine turns machine load into a product regression.
 */
const MOUNT_BUDGET_MS = 90_000;

let mounted = false;
const mountStartedAt = Date.now();
const deadline = mountStartedAt + MOUNT_BUDGET_MS;
while (Date.now() < deadline) {
  mounted = await evaluate(`!!document.querySelector("canvas") && !!window.__arenaBench`);
  if (mounted) break;
  await delay(300);
}
if (!mounted) {
  console.log(JSON.stringify({ ok: false, reason: "app 未挂载", diagnosis: await diagnose() }, null, 2));
  cleanup();
  process.exit(1);
}
const mountedAfterMs = Date.now() - mountStartedAt;

// The help overlay opens on a first visit and would cover the whole screenshot.
await evaluate(`document.querySelector(".help__footer button")?.click(), "dismissed"`);
await delay(200);

if (DRAWER === "closed") {
  await evaluate(
    `[...document.querySelectorAll(".hud__pill")].find((b) => b.textContent.includes("收起布阵"))?.click(), "collapsed"`
  );
}

// Wait for the asset layer to answer, not for a duration. Every registered key has to stop
// being `pending`. `failed` is a settled answer too: if the art is broken then the honest
// screenshot is the one that shows the failure, so this waits for the question to be answered
// rather than for a particular answer. The `debug=1` in PAGE_URL is what exposes the report;
// it installs two hooks and changes nothing on screen.
let appearance = [];
const settleDeadline = Date.now() + 25_000;
for (;;) {
  appearance = (await evaluate(`window.__arenaAppearance?.report?.() ?? []`)) ?? [];
  const stillPending = appearance.filter((row) => row.state === "pending");
  if (appearance.length > 0 && stillPending.length === 0) break;
  if (Date.now() > settleDeadline) break;
  await delay(200);
}

// The state has settled, but the frame that draws it may still be a compositor pass away.
await delay(400);

const shot = await send("Page.captureScreenshot", { format: "png" });
await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, Buffer.from(shot.data, "base64"));

const layout = await evaluate(`(() => {
  const stage = document.querySelector(".app__stage").getBoundingClientRect();
  const canvas = document.querySelector("canvas").getBoundingClientRect();
  const bar = document.querySelector(".hud__playbar").getBoundingClientRect();
  const drawer = document.querySelector(".app__panel").getBoundingClientRect();
  const round = (r) => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
  return { viewport: { w: window.innerWidth, h: window.innerHeight }, stage: round(stage), canvas: round(canvas), playbar: round(bar), drawer: round(drawer) };
})()`);

// A screenshot whose subjects are placeholders is not a usable deliverable, so a non-ready
// appearance state fails the run. It is reported rather than silently accepted: the whole
// point of the magenta placeholder is that "not loaded" must not pass for "finished".
const appearanceOk = appearance.every((row) => row.state === "ready");

console.log(
  JSON.stringify(
    {
      ok: errors.length === 0 && exceptions.length === 0 && appearanceOk,
      out: path.relative(ROOT, OUT),
      url: PAGE_URL,
      mountedAfterMs,
      layout,
      appearance,
      errors,
      exceptions
    },
    null,
    2
  )
);

cleanup();
process.exit(0);
