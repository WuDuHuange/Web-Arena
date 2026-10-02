/**
 * UI screenshot tool.
 *
 * The battle verifier asserts behaviour; it cannot show what the side panel looks like,
 * because the panel scrolls and a viewport screenshot only ever captures the top of it.
 * This overrides the device metrics to something tall enough for the whole panel, scrolls
 * it to the bottom, and captures.
 *
 * Usage: node scripts/shot-ui.mjs <pageUrl> <out.png> [--port=9333] [--width=1000] [--height=1500] [--scroll=1]
 */
import { setTimeout as delay } from "node:timers/promises";
import { writeFile } from "node:fs/promises";

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("--"));
const [pageUrl, outPath] = positional;

if (!pageUrl || !outPath) {
  console.error("usage: node scripts/shot-ui.mjs <pageUrl> <out.png> [--port=9333] [--width=1000] [--height=1500]");
  process.exit(2);
}

const readFlag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const port = Number(readFlag("port", "9333"));
const width = Number(readFlag("width", "1000"));
const height = Number(readFlag("height", "1500"));
const scroll = readFlag("scroll", "1") === "1";

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
  return result.result?.value;
};

await send("Runtime.enable");
await send("Page.enable");
// A tall viewport is what makes the whole scrollable panel visible at once.
await send("Emulation.setDeviceMetricsOverride", {
  width,
  height,
  deviceScaleFactor: 1,
  mobile: false
});
await send("Page.navigate", { url: pageUrl });

const deadline = Date.now() + 25_000;
let ready = false;
while (Date.now() < deadline) {
  ready = await evaluate(`!!document.querySelector("canvas") && !!window.__arenaBench`);
  if (ready) {
    break;
  }
  await delay(300);
}

if (!ready) {
  console.log(JSON.stringify({ ok: false, reason: "app did not mount" }, null, 2));
  socket.close();
  process.exit(1);
}

// Dismiss the first-run overlay so the panel behind it is visible.
await evaluate(`document.querySelector(".help__footer button")?.click()`);
await delay(300);

if (scroll) {
  await evaluate(`document.querySelector(".app__panel").scrollTop = 100000, "scrolled"`);
  await delay(200);
}

const shot = await send("Page.captureScreenshot", { format: "png" });
await writeFile(outPath, Buffer.from(shot.data, "base64"));

console.log(JSON.stringify({ ok: true, url: pageUrl, out: outPath, width, height }, null, 2));
socket.close();
