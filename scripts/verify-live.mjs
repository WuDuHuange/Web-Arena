/**
 * Verify the *deployed* site, not the local build.
 *
 * `check:build` already proves the production bundle is self-consistent and loads over
 * HTTP under a subpath. What it cannot prove is that the thing GitHub Pages is actually
 * serving boots: the CDN, the cache headers, and the real `base` are all outside its
 * reach. This script loads the live URL in headless Chrome, waits for the renderer to
 * come up, and reports every console error, uncaught exception, and failed request.
 *
 * It is deliberately NOT part of `npm run check`: it needs the network, and it is about
 * the deployment rather than the code.
 *
 * Usage:
 *   node scripts/verify-live.mjs
 *   node scripts/verify-live.mjs "https://example.com/app/?view=iso"
 *   node scripts/verify-live.mjs <url> --out=outputs/live.png
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const ROOT = path.resolve(import.meta.dirname, "..");
const DEFAULT_URL = "https://wuduhuange.github.io/Web-Arena/";

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("--"));
const pageUrl = positional[0] ?? DEFAULT_URL;
const outFlag = args.find((a) => a.startsWith("--out="));
const outPath = path.resolve(ROOT, outFlag ? outFlag.slice(6) : "outputs/live-pages.png");

const PORT = Number((args.find((a) => a.startsWith("--port=")) ?? "--port=9345").slice(7));
// `.cdp-profile` is the gitignored scratch name the other CDP scripts already use.
const PROFILE = path.resolve(ROOT, ".cdp-profile");

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
    ...(process.platform === "linux" ? ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"] : [])
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

// Windows only kills the direct child; Chrome spawns grandchildren.
function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32" && child.pid !== undefined) {
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  child.kill("SIGTERM");
}

const chromeBin = findChrome();
if (!chromeBin) {
  console.log(JSON.stringify({ ok: false, reason: "找不到 Chrome，请设置 CHROME=<可执行文件路径>" }, null, 2));
  process.exit(1);
}

// The URL is handed to Chrome up front, not `about:blank`: a real navigation is what
// gives Chrome a `page` target to attach to. We then do NOT call Page.navigate — doing
// both navigations makes the first one abort with net::ERR_ABORTED, which looks like a
// failed request on a site that is perfectly fine.
const chrome = spawn(
  chromeBin,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${PROFILE}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--window-size=1280,800",
    pageUrl
  ],
  { cwd: ROOT, stdio: ["ignore", "ignore", "ignore"] }
);

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
};
process.on("exit", cleanup);

async function findPageTarget() {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      // Chrome not listening yet.
    }
    await delay(250);
  }
  throw new Error(`在端口 ${PORT} 上找不到 page target`);
}

const target = await findPageTarget();
socket = new WebSocket(target.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
const consoleErrors = [];
const exceptions = [];
const failedRequests = [];

socket.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
    return;
  }
  if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
    consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(" "));
  }
  if (msg.method === "Runtime.exceptionThrown") {
    const details = msg.params.exceptionDetails;
    exceptions.push(details.exception?.description ?? details.text);
  }
  if (msg.method === "Network.loadingFailed") {
    failedRequests.push(`${msg.params.type} ${msg.params.errorText}`);
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
  return result.result?.value;
};

await send("Runtime.enable");
await send("Page.enable");
await send("Network.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: 1280,
  height: 800,
  deviceScaleFactor: 1,
  mobile: false
});

const deadline = Date.now() + 30_000;
let mounted = false;
while (Date.now() < deadline) {
  mounted = await evaluate(
    `!!document.querySelector("canvas") && (document.querySelector("#root")?.children.length ?? 0) > 0`
  );
  if (mounted) break;
  await delay(300);
}

const page = JSON.parse(
  (await evaluate(`JSON.stringify({
    title: document.title,
    canvases: document.querySelectorAll("canvas").length,
    rootChildren: document.querySelector("#root")?.children.length ?? 0,
    benchHook: typeof window.__arenaBench,
    webgl: (() => {
      const probe = document.createElement("canvas");
      const gl = probe.getContext("webgl2") || probe.getContext("webgl");
      return gl ? gl.getParameter(gl.VERSION) : "none";
    })(),
    bodyText: (document.body.innerText || "").slice(0, 200)
  })`)) ?? "{}"
);

if (mounted) {
  const shot = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(outPath, Buffer.from(shot.data, "base64"));
}

const ok = mounted && exceptions.length === 0 && failedRequests.length === 0;
console.log(
  JSON.stringify(
    {
      ok,
      url: pageUrl,
      mounted,
      page,
      consoleErrors,
      exceptions,
      failedRequests,
      screenshot: mounted ? outPath : null
    },
    null,
    2
  )
);

cleanup();
process.exit(ok ? 0 : 1);
