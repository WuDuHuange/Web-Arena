/**
 * Phase 1 browser benchmark.
 *
 * The head-less assertions in tests/pressure.test.mjs prove the solver is stable. They
 * say nothing about frame rate, because there is no renderer involved. This script
 * measures the thing the architecture document actually promised: 100 units plus 20
 * props sustained at 60 FPS in a real browser.
 *
 * Division of labour, learned the hard way on this machine:
 *   - bash starts Chrome with --remote-debugging-port and keeps it alive.
 *   - this script only *connects* over CDP.
 * Spawning Chrome from Node yields a /json/list with only a background_page target and
 * no page target, so the connection silently has nothing to attach to.
 *
 * Usage:
 *   node scripts/benchmark.mjs <pageUrl> [--seconds=10] [--port=9333]
 *
 * It prints one JSON object so the caller can capture the numbers.
 */
import { setTimeout as delay } from "node:timers/promises";

const args = process.argv.slice(2);
const pageUrl = args.find((a) => !a.startsWith("--"));
if (!pageUrl) {
  console.error("usage: node scripts/benchmark.mjs <pageUrl> [--seconds=10] [--port=9333]");
  process.exit(2);
}

const readFlag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const seconds = Number(readFlag("seconds", "10"));
const port = Number(readFlag("port", "9333"));

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
  throw new Error(`no page target on port ${port} after 20s`);
}

/** Minimal CDP client: enough to evaluate expressions and collect console output. */
function createClient(wsUrl) {
  const socket = new WebSocket(wsUrl);
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
      exceptions.push(msg.params.exceptionDetails.text ?? "unknown exception");
    }
  });

  const ready = new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", (e) => reject(new Error(`socket error: ${e.message ?? e.type}`)));
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
      throw new Error(`evaluate failed: ${result.exceptionDetails.text}`);
    }
    return result.result.value;
  };

  return { ready, send, evaluate, consoleErrors, exceptions, close: () => socket.close() };
}

const target = await findPageTarget();
const client = createClient(target.webSocketDebuggerUrl);
await client.ready;
await client.send("Runtime.enable");
await client.send("Page.enable");
await client.send("Page.navigate", { url: pageUrl });

// Wait for the app to actually mount a canvas and expose its diagnostics hook.
const readyExpr = `(() => {
  const canvas = document.querySelector("canvas");
  if (!canvas) return "no-canvas";
  if (!window.__arenaBench) return "no-bench-hook";
  return "ready";
})()`;

let state = "pending";
const readyDeadline = Date.now() + 25_000;
while (Date.now() < readyDeadline) {
  state = await client.evaluate(readyExpr);
  if (state === "ready") {
    break;
  }
  await delay(300);
}
if (state !== "ready") {
  console.log(JSON.stringify({ ok: false, reason: state }, null, 2));
  client.close();
  process.exit(1);
}

await client.evaluate("window.__arenaBench.start()");
await delay(seconds * 1000);

const report = await client.evaluate("window.__arenaBench.stop()");
const canvasInfo = await client.evaluate(`(() => {
  const c = document.querySelector("canvas");
  return c ? { width: c.width, height: c.height } : null;
})()`);

console.log(
  JSON.stringify(
    {
      ok: true,
      url: pageUrl,
      seconds,
      canvas: canvasInfo,
      report,
      consoleErrors: client.consoleErrors,
      exceptions: client.exceptions
    },
    null,
    2
  )
);

client.close();
