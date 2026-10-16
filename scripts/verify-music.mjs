/**
 * Background-music verification in a real browser.
 *
 * The head-less suite pins the policy — which phases are audible, how mute maps onto gain —
 * but the two things that actually decide whether a track ever plays cannot be reached from
 * Node at all: the browser's autoplay gate, and whether the hashed asset URL resolves under
 * the dev server. Both fail silently and both look identical from the inside ("no sound"),
 * which is exactly the class of bug a verifier exists for.
 *
 * Three details make this a real test rather than theatre:
 *
 *   1. The click is dispatched through CDP `Input.dispatchMouseEvent`, not `element.click()`.
 *      A programmatic click is untrusted and grants no user activation, so `play()` would be
 *      refused and the run would "fail" for a reason no real user would ever hit.
 *   2. `--autoplay-policy` is deliberately *not* overridden. Passing
 *      `no-user-gesture-required` would make the run green while the shipped page still
 *      cannot start on a cold load.
 *   3. The mp3 request is read off the Network domain, so "the channel says it is playing"
 *      cannot be satisfied by a track that 404'd.
 *
 * Usage: node scripts/verify-music.mjs [--port=5181] [--cdp=9347]
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const ROOT = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const readFlag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const PORT = Number(readFlag("port", "5181"));
const CDP_PORT = Number(readFlag("cdp", "9347"));
/** `debug=1` is what installs `window.__arenaMusic`; see App.tsx. */
const PAGE_URL = `http://127.0.0.1:${PORT}/?scene=battle&debug=1`;
const PROFILE = path.resolve(ROOT, ".cdp-profile-music");

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
    ...(process.platform === "darwin"
      ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
      : []),
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
 * `stdio: "ignore"` threw away the only evidence that separates "the server never came up"
 * from "the server came up and served something the page could not use". Bounded, because
 * only the end of a long-lived server's output matters when something is wrong.
 */
let devLog = "";
const dev = spawn(
  process.execPath,
  [viteBin, "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"],
  { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] }
);
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
    "--window-size=1440,900",
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
/** Every media request the page made, so a 404 cannot masquerade as a playing track. */
const mediaRequests = [];
socket.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.method === "Network.responseReceived") {
    const { url, status } = msg.params.response;
    if (/\.(mp3|ogg|m4a|wav)(\?|$)/i.test(url)) {
      mediaRequests.push({ url, status });
    }
  }
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
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? "evaluate threw");
  }
  return result.result?.value;
};

await send("Runtime.enable");
await send("Network.enable");
await send("Page.enable");

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

/**
 * What is actually on the other end, when the app is not.
 *
 * The mount check is `canvas && window.__arenaMusic`, and its failure has several causes that
 * look identical from inside the script: a page that never loaded, a page that loaded and
 * threw before React mounted, a `debug=1` that never reached the URL, and a CDP client
 * attached to somebody else's browser. The last one is not hypothetical -- `findPageTarget`
 * takes the first page target on the port, so a stale Chrome answers for a new one that never
 * managed to bind. The target list and the server probe are what tell them apart.
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
    mediaRequests,
    devServer: devLog.trim().split("\n").slice(-25)
  };
  try {
    out.page = await evaluate(`({
      href: location.href,
      readyState: document.readyState,
      title: document.title,
      canvas: !!document.querySelector("canvas"),
      music: typeof window.__arenaMusic,
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

const mountStartedAt = Date.now();
const deadline = mountStartedAt + MOUNT_BUDGET_MS;
let mounted = false;
while (Date.now() < deadline) {
  mounted = await evaluate(`!!document.querySelector("canvas") && !!window.__arenaMusic`);
  if (mounted) break;
  await delay(300);
}
if (!check(mounted, "app 未挂载，或 ?debug=1 的 __arenaMusic 探针没装上")) {
  console.log(JSON.stringify({ ok: false, failures, diagnosis: await diagnose() }, null, 2));
  cleanup();
  process.exit(1);
}
notes.push({ mountedAfterMs: Date.now() - mountStartedAt });

// The help overlay covers the panel on first run.
await evaluate(`document.querySelector(".help__footer button")?.click()`);
await delay(200);

const music = () => evaluate(`window.__arenaMusic.state()`);
const phaseText = () =>
  evaluate(`document.querySelector(".panel__phase")?.textContent.trim() ?? ""`);

/** Centre of a button, in viewport coordinates. */
const centreOf = (label) =>
  evaluate(`(() => {
    const button = [...document.querySelectorAll("button")]
      .find((b) => b.textContent.trim() === ${JSON.stringify(label)});
    if (!button) return null;
    const r = button.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);

/**
 * Clicks through the input pipeline, which is what makes the browser treat it as a gesture.
 *
 * `element.click()` would run the React handler and change the phase — and then `play()` would
 * be refused for want of user activation, so the test would report a failure that no real
 * click produces.
 */
const click = async (label) => {
  const at = await centreOf(label);
  if (!at) throw new Error(`找不到按钮：${label}`);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", {
      type,
      x: at.x,
      y: at.y,
      button: "left",
      buttons: type === "mousePressed" ? 1 : 0,
      clickCount: 1
    });
  }
  await delay(200);
};

try {
  // --- 待命 is quiet --------------------------------------------------------

  const idle = await music();
  check(idle.available === true, "探针报告没有可用的音频通道（浏览器缺 Audio？）");
  check(idle.playing === false, `待命时不应播放，实得 playing=${idle.playing}`);
  notes.push({ idle });

  // --- 开战 starts it -------------------------------------------------------

  await click("开战");
  check((await phaseText()) === "交战中", "开战 之后应处于交战中");
  // The element has to fetch and decode before `paused` flips; the loop is short but the
  // file is not.
  await delay(1500);

  const running = await music();
  notes.push({ running, mediaRequests });

  check(running.playing === true, `开战后应开始播放，实得 ${JSON.stringify(running)}`);
  check(
    running.errorCode === null,
    `音轨加载报错 errorCode=${running.errorCode}（4 = 找不到文件或格式不支持）`
  );
  check(running.readyState >= 2, `音轨应至少已就绪到 CURRENT_DATA，实得 readyState=${running.readyState}`);
  check(/\.mp3$/.test(running.source), `通道加载的不是 mp3：${running.source}`);

  // The channel can only report a URL it was given. This is the half that proves the asset
  // pipeline emitted something the browser could actually fetch.
  //
  // 2xx, not 200: a media element issues a ranged request and the server answers 206 Partial
  // Content. Demanding exactly 200 would fail on a track that loaded perfectly.
  const succeeded = (status) => status >= 200 && status < 300;
  const served = mediaRequests.filter((r) => succeeded(r.status));
  check(served.length > 0, `浏览器没有成功取到任何音频文件，实得 ${JSON.stringify(mediaRequests)}`);
  check(
    mediaRequests.every((r) => succeeded(r.status)),
    `有音频请求没成功：${JSON.stringify(mediaRequests.filter((r) => !succeeded(r.status)))}`
  );

  // --- 暂停 does not cut it -------------------------------------------------

  await click("暂停");
  check((await phaseText()) === "已暂停", "暂停 之后应处于已暂停");
  const paused = await music();
  check(paused.playing === true, `暂停不应中断音乐，实得 playing=${paused.playing}`);
  notes.push({ paused });

  // --- 声音 mutes the gain, not the track -----------------------------------

  await click("声音：开");
  const muted = await music();
  check(muted.muted === true, `静音后 muted 应为 true，实得 ${muted.muted}`);
  check(muted.volume === 0, `静音应把增益降到 0，实得 volume=${muted.volume}`);
  check(muted.playing === true, "静音不该停掉音轨，否则取消静音会从头开始");
  notes.push({ muted });

  await click("声音：关");
  const unmuted = await music();
  check(unmuted.muted === false, "取消静音后 muted 应为 false");
  check(unmuted.volume > 0, `取消静音后增益应恢复，实得 volume=${unmuted.volume}`);
  check(
    unmuted.volume < 0.5,
    `音乐增益应低于音效总线（0.5），实得 ${unmuted.volume}`
  );
  notes.push({ unmuted });

  // --- 重置 returns to silence ---------------------------------------------

  await click("重置");
  check((await phaseText()) === "待命", "重置 之后应回到待命");
  const reset = await music();
  check(reset.playing === false, `重置后应停止播放，实得 playing=${reset.playing}`);
  notes.push({ reset });
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
}

console.log(JSON.stringify({ ok: failures.length === 0, failures, notes }, null, 2));
cleanup();
process.exit(failures.length === 0 ? 0 : 1);
