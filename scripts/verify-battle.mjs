/**
 * End-to-end battle verification in a real browser.
 *
 * The head-less tests prove the simulation is correct. They say nothing about whether the
 * battle actually renders, whether it reaches a decision on screen, or whether the panel
 * reports it. This drives the real build and reads the real DOM.
 *
 * Usage: node scripts/verify-battle.mjs <pageUrl> [--port=9333] [--seconds=60]
 *                                       [--shot=out.png] [--shotAfter=6]
 *                                       [--shotHelp=help.png]
 *
 * `--shot` captures a PNG mid-battle. Presentation changes cannot be asserted from the
 * DOM, so a screenshot is the only honest evidence that the field layer drew anything.
 */
import { setTimeout as delay } from "node:timers/promises";
import { statSync } from "node:fs";
import { writeFile } from "node:fs/promises";

const args = process.argv.slice(2);
const pageUrl = args.find((a) => !a.startsWith("--"));
if (!pageUrl) {
  console.error(
    "usage: node scripts/verify-battle.mjs <pageUrl> [--port=9333] [--seconds=60] [--shot=out.png] [--shotHelp=help.png]"
  );
  process.exit(2);
}

const readFlag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const port = Number(readFlag("port", "9333"));
const maxSeconds = Number(readFlag("seconds", "60"));
const shotPath = readFlag("shot", "");
const shotAfterMs = Number(readFlag("shotAfter", "6")) * 1000;
const shotHelpPath = readFlag("shotHelp", "");

/**
 * Rewrites a Git Bash POSIX path into a Windows one.
 *
 * `$PWD` in Git Bash is `/c/course_task/...`, and Node on Windows resolves a leading slash
 * against the current drive — so the screenshot would be written to `C:\c\course_task\...`,
 * which does not exist. Worse, a write refused outside the workspace is swallowed rather
 * than thrown, so the script goes on to report a screenshot path that is not there. That
 * is the exact shape of a verification run that proves nothing while looking green.
 */
function toLocalPath(value) {
  if (process.platform !== "win32" || value.length === 0) {
    return value;
  }
  const match = /^\/([a-zA-Z])\/(.*)$/.exec(value);
  return match ? `${match[1]}:/${match[2]}` : value;
}

/** Writes a screenshot and refuses to report one that did not land. */
async function writeScreenshot(target, base64) {
  const resolved = toLocalPath(target);
  await writeFile(resolved, Buffer.from(base64, "base64"));
  const size = statSync(resolved).size;
  if (size === 0) {
    throw new Error(`screenshot ${resolved} was written but is empty`);
  }
  return { path: resolved, bytes: size };
}

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

// The help overlay only auto-opens once per browser profile, so a second run would
// capture an arena with no overlay and quietly prove nothing. Clear the flag and reload to
// reproduce what a first-time visitor actually sees.
if (shotHelpPath) {
  await delay(700);
  try {
    await evaluate(`localStorage.removeItem("project-arena.help.seen.v1"), "cleared"`);
  } catch {
    // The document was not ready; the reload below still lands on a fresh state.
  }
  await send("Page.reload");
}

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
  // Reporting only the state here would hide the actual cause, which is almost always an
  // exception thrown while the renderer initialises.
  console.log(JSON.stringify({ ok: false, reason: state, consoleErrors, exceptions }, null, 2));
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

// The first-run help overlay covers the arena on a fresh profile. Capture it if asked,
// then dismiss it the way a user would before driving the battle.
let help = null;
if (shotHelpPath) {
  // `.help` scrolls, so at the default window height the lower half of the card — which is
  // where the generated content lives — never reaches the image. A screenshot of a clipped
  // card is worse than no screenshot: it looks like the content is missing.
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1000,
    height: 2200,
    deviceScaleFactor: 1,
    mobile: false
  });
  await delay(500);

  const shot = await send("Page.captureScreenshot", { format: "png" });
  const written = await writeScreenshot(shotHelpPath, shot.data);
  await send("Emulation.clearDeviceMetricsOverride");

  // A screenshot cannot show whether the generated text is *right*. The help screen is
  // built from the content library at runtime, so a missing label or a broken derivation
  // renders as a plausible-looking row — and a row reading `flying` or an empty
  // description is exactly the kind of thing a reviewer skims past in an image.
  help = await evaluate(`(() => {
    const sections = [...document.querySelectorAll(".help__section")].map((section) => ({
      title: section.querySelector("h3")?.textContent ?? "",
      rows: [...section.querySelectorAll("li")].map((li) => ({
        name: li.querySelector(".help__name")?.textContent ?? "",
        desc: li.querySelector(".help__desc")?.textContent ?? ""
      }))
    }));
    return {
      visible: document.querySelector(".help") !== null,
      sections,
      blankDescriptions: sections.flatMap((s) => s.rows).filter((r) => r.desc.trim().length === 0).length
    };
  })()`);
  help.screenshot = written;
}
await evaluate(`document.querySelector(".help__footer button")?.click()`);
await delay(200);

// Start the battle the way a user would.
await evaluate(`[...document.querySelectorAll(".panel__buttons button")].find((b) => b.textContent === "开战")?.click()`);

// Poll until the battle is decided or we run out of time.
let final = initial;
let elapsed = 0;
let shotTaken = false;
let shotResult = null;
const tickInterval = 1000;
while (elapsed < maxSeconds * 1000) {
  await delay(tickInterval);
  elapsed += tickInterval;
  final = await evaluate(readState);

  // Capture mid-battle rather than at the end: a decided arena has no shots in flight and
  // no traps mid-animation, which is precisely the state worth photographing.
  if (shotPath && !shotTaken && elapsed >= shotAfterMs) {
    const shot = await send("Page.captureScreenshot", { format: "png" });
    shotResult = await writeScreenshot(shotPath, shot.data);
    shotTaken = true;
  }

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
      screenshot: shotResult,
      helpScreenshot: shotHelpPath ? toLocalPath(shotHelpPath) : null,
      help,
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
