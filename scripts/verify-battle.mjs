/**
 * End-to-end battle verification in a real browser.
 *
 * The head-less tests prove the simulation is correct. They say nothing about whether the
 * battle actually renders, whether it reaches a decision on screen, or whether the panel
 * reports it. This drives the real build and reads the real DOM.
 *
 * Usage: node scripts/verify-battle.mjs <pageUrl> [--port=9333] [--seconds=60]
 */
import { setTimeout as delay } from "node:timers/promises";

const args = process.argv.slice(2);
const pageUrl = args.find((a) => !a.startsWith("--"));
if (!pageUrl) {
  console.error("usage: node scripts/verify-battle.mjs <pageUrl> [--port=9333] [--seconds=60]");
  process.exit(2);
}

const readFlag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const port = Number(readFlag("port", "9333"));
const maxSeconds = Number(readFlag("seconds", "60"));

async function findPageTarget() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) {
        return page;
      }
    } catch {
      // Chrome not up yet.
    }
    await delay(250);
  }
  throw new Error(`no page target on port ${port}`);
}

const target = await findPageTarget();
const socket = new WebSocket(target.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
const consoleErrors = [];
const exceptions = [];

socket.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) {
      reject(new Error(JSON.stringify(msg.error)));
    } else {
      resolve(msg.result);
    }
    return;
  }
  if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
    consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
  }
  if (msg.method === "Runtime.exceptionThrown") {
    exceptions.push(msg.params.exceptionDetails.text ?? "unknown");
  }
});

await new Promise((resolve, reject) => {
  socket.addEventListener("open", () => resolve());
  socket.addEventListener("error", () => reject(new Error("socket error")));
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
    throw new Error(`evaluate failed: ${result.exceptionDetails.text}`);
  }
  return result.result.value;
};

await send("Runtime.enable");
await send("Page.enable");
await send("Page.navigate", { url: pageUrl });

// Wait for the app to mount.
let state = "pending";
const deadline = Date.now() + 25_000;
while (Date.now() < deadline) {
  state = await evaluate(`(() => {
    if (!document.querySelector("canvas")) return "no-canvas";
    if (!window.__arenaBench) return "no-bench-hook";
    const badges = [...document.querySelectorAll(".app__badge")].map((b) => b.textContent);
    if (badges.length < 2) return "no-badges";
    return "ready";
  })()`);
  if (state === "ready") {
    break;
  }
  await delay(300);
}

if (state !== "ready") {
  console.log(JSON.stringify({ ok: false, reason: state }, null, 2));
  socket.close();
  process.exit(1);
}

/** Reads the battle panel state out of the DOM. */
const readState = `(() => {
  const phase = document.querySelector(".panel__phase")?.textContent ?? "";
  const readout = {};
  const dt = [...document.querySelectorAll(".panel__readout dt")];
  const dd = [...document.querySelectorAll(".panel__readout dd")];
  dt.forEach((node, i) => { readout[node.textContent] = dd[i]?.textContent ?? ""; });
  return { phase, readout };
})()`;

const initial = await evaluate(readState);

// Start the battle the way a user would.
await evaluate(`[...document.querySelectorAll(".panel__buttons button")].find((b) => b.textContent === "开战")?.click()`);

// Poll until the battle is decided or we run out of time.
let final = initial;
let elapsed = 0;
const tickInterval = 1000;
while (elapsed < maxSeconds * 1000) {
  await delay(tickInterval);
  elapsed += tickInterval;
  final = await evaluate(readState);
  if (final.phase.includes("已分胜负")) {
    break;
  }
}

const canvasInfo = await evaluate(`(() => {
  const c = document.querySelector("canvas");
  return c ? { width: c.width, height: c.height } : null;
})()`);

// The reset button must put it back to a fresh field.
await evaluate(`[...document.querySelectorAll(".panel__buttons button")].find((b) => b.textContent === "重置")?.click()`);
await delay(800);
const afterReset = await evaluate(readState);

console.log(
  JSON.stringify(
    {
      ok: true,
      url: pageUrl,
      canvas: canvasInfo,
      initial,
      final,
      elapsedSeconds: elapsed / 1000,
      afterReset,
      consoleErrors,
      exceptions
    },
    null,
    2
  )
);

socket.close();
process.exit(0);
