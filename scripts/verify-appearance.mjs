/**
 * End-to-end appearance verification, against pixels.
 *
 * `tests/appearance.test.mjs` proves the decision table: which of the three states a key is
 * in, and what plan comes out. What it cannot prove is the last step — that the renderer
 * draws something *different* for each of them. That is the entire point of the layer, and it
 * is invisible to every test that does not have a canvas: a renderer that ignored the plan
 * and always drew the grey box would pass all 21 of them.
 *
 * So this drives the real build, rewrites a live appearance key through the debug hook, and
 * counts pixels on a real screenshot:
 *
 *   - art authored and loaded  → sprite pixels, no magenta
 *   - no art authored          → no sprite, no magenta (the grey box is the rendering)
 *   - art authored, load fails → magenta, no sprite
 *
 * Two colours identify the sprite, because the demo fixture has both slots and the field
 * spends its whole time in one of them:
 *
 *   - **cyan** `#2ee6c8` — the six-frame strip, i.e. the *base* slot, a sequence.
 *   - **yellow** `#ffd166` — the ring, i.e. the *attack* slot, a single frame.
 *
 * While the field is frozen in the editor, tick 0 puts every unit in `windup` and the
 * simulation never advances, so the attack slot is what is on screen — permanently. The base
 * strip can only be observed once the battle is running. Both are asserted, which turns this
 * into a test of the slot switch as well as of the drawing.
 *
 * Usage: node --experimental-strip-types scripts/verify-appearance.mjs <pageUrl> [--port=9334] [--shot=out.png]
 *
 * The script appends `?debug=1` itself: the override hook is only installed under that flag,
 * so a shipped page carries no handle that can rewrite the asset table.
 */
import { statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import { PLACEHOLDER_COLOR } from "../src/content/appearance.ts";

const args = process.argv.slice(2);
const rawUrl = args.find((a) => !a.startsWith("--"));
if (!rawUrl) {
  console.error(
    "usage: node --experimental-strip-types scripts/verify-appearance.mjs <pageUrl> [--port=9334] [--shot=out.png]"
  );
  process.exit(2);
}

const readFlag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const port = Number(readFlag("port", "9334"));
const shotPath = readFlag("shot", "");

const pageUrl = (() => {
  const url = new URL(rawUrl);
  url.searchParams.set("debug", "1");
  return url.toString();
})();

/** Git Bash hands over `/c/...`; Node on Windows resolves that against the current drive. */
function toLocalPath(value) {
  if (process.platform !== "win32" || value.length === 0) {
    return value;
  }
  const match = /^\/([a-zA-Z])\/(.*)$/.exec(value);
  return match ? `${match[1]}:/${match[2]}` : value;
}

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
    // `text` alone is just "Uncaught"; the description is the only part that says what broke.
    const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
    throw new Error(`evaluate failed: ${detail}`);
  }
  return result.result.value;
};

// --- Navigation ---------------------------------------------------------------

await send("Page.enable");
// headless defaults to roughly 758x426, which would render the arena about 700 px wide and
// put the sprite near the edge of legibility. Set the viewport explicitly rather than trusting
// the window size the launcher was given.
await send("Emulation.setDeviceMetricsOverride", {
  width: 1440,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false
});
await send("Page.navigate", { url: pageUrl });
await delay(1200);
try {
  await evaluate(`localStorage.setItem("project-arena.help.seen.v1", "1"), "ok"`);
} catch {
  // The document may not be ready; the reload below lands on a fresh state either way.
}
// Enabled after the first navigation, so an exception from the previous page context cannot
// be attributed to this run. Everything after the reload is what gets collected.
consoleErrors.length = 0;
exceptions.length = 0;
await send("Runtime.enable");
await send("Page.reload");

let state = "pending";
const readyDeadline = Date.now() + 25_000;
while (Date.now() < readyDeadline) {
  state = await evaluate(`(() => {
    if (!document.querySelector("canvas")) return "no-canvas";
    if (!window.__arenaBench) return "no-bench-hook";
    if (!window.__arenaAppearance) return "no-appearance-hook";
    return "ready";
  })()`);
  if (state === "ready") {
    break;
  }
  await delay(300);
}
if (state !== "ready") {
  console.log(JSON.stringify({ ok: false, reason: state, consoleErrors, exceptions }, null, 2));
  socket.close();
  process.exit(1);
}

// The help overlay is a real modal over the arena. It does not affect a whole-image pixel
// scan, but leaving it up would put a card in the screenshot that is meant as evidence.
await evaluate(`document.querySelector(".help__footer button")?.click(), "dismissed"`);
await delay(300);

// --- Readers -----------------------------------------------------------------

/** The 外观 panel, as a human reads it. */
const readPanel = () =>
  evaluate(`(() => {
    const blocks = [...document.querySelectorAll(".panel__block")];
    const block = blocks.find((b) => b.querySelector("h2")?.textContent === "外观");
    if (!block) return null;
    return {
      summary: block.querySelector(".panel__ok, .panel__alert")?.textContent ?? "",
      rows: [...block.querySelectorAll(".panel__appearances li")].map((li) => ({
        key: li.querySelector("code")?.textContent ?? "",
        state: li.querySelector(".appearance__state")?.textContent ?? "",
        reason: li.querySelector(".appearance__reason")?.textContent ?? ""
      })),
      notes: [...block.querySelectorAll(".panel__note")].map((n) => n.textContent.trim())
    };
  })()`);

const readPhase = () => evaluate(`document.querySelector(".panel__phase")?.textContent ?? ""`);

/**
 * Counts the colours that identify each state, over the whole screenshot.
 *
 * Whole-image rather than a box around the unit: the mapping from world units to screenshot
 * pixels depends on the fit transform, the device pixel ratio and the window size, and a box
 * that silently lands in the wrong place would pass or fail for the wrong reason. The three
 * colours are unambiguous enough to count globally.
 */
async function scan() {
  const captured = await send("Page.captureScreenshot", { format: "png" });
  const pixels = await evaluate(`(async () => {
    const img = new Image();
    img.src = "data:image/png;base64,${captured.data}";
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);

    // Only the arena. The rest of the screenshot is the panel, and the panel is styled with
    // the same palette family as the sprites — an amber badge or a swatch is enough to make a
    // whole-image count non-zero and turn a renderer assertion into a stylesheet assertion.
    // The scale factor is 1 under the emulated viewport, but computing it keeps the mapping
    // honest if that ever changes.
    const rect = document.querySelector("canvas").getBoundingClientRect();
    const k = c.width / window.innerWidth;
    const x0 = Math.max(0, Math.round(rect.left * k));
    const y0 = Math.max(0, Math.round(rect.top * k));
    const x1 = Math.min(c.width, Math.round(rect.right * k));
    const y1 = Math.min(c.height, Math.round(rect.bottom * k));
    const { data } = ctx.getImageData(x0, y0, Math.max(x1 - x0, 1), Math.max(y1 - y0, 1));

    let cyan = 0;
    let magenta = 0;
    let yellow = 0;
    let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
    const cyanX = [];
    const cyanY = [];
    // The most cyan pixel in the whole arena, and how cyan it is. Distinguishes three very
    // different diagnoses that all look like "the sprite is missing": nothing was drawn at
    // all, a sprite was drawn but is transparent, or a sprite was drawn and the strict
    // threshold is simply too strict for an anti-aliased 4-pixel-wide bar.
    let peak = { r: 0, g: 0, b: 0, score: -999 };
    const regionWidth = x1 - x0;
    const regionHeight = y1 - y0;

    for (let y = 0; y < regionHeight; y += 1) {
      for (let x = 0; x < regionWidth; x += 1) {
        const i = (y * regionWidth + x) * 4;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        if (g - r > peak.score) {
          peak = { r, g, b, score: g - r };
        }
        if (r < 90 && g > 200 && b > 170 && b < 225) {
          cyan += 1;
          cyanX.push(x);
          cyanY.push(y);
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        } else if (r > 230 && g > 180 && g < 235 && b < 140) {
          yellow += 1;
        } else if (r > 200 && g < 110 && b > 160) {
          magenta += 1;
        }
      }
    }

    // A shape signature of the sprite, normalised to its own bounding box so it is independent
    // of where the unit is standing. That matters once the battle is running: a unit walking
    // across the arena changes a whole-screen fingerprint on its own, which would make a
    // frozen animation look like a working one. A rotating bar changes this signature; a
    // moving unit does not.
    let signature = "";
    if (cyan > 0) {
      const w = maxX - minX + 1;
      const h = maxY - minY + 1;
      const cells = new Array(64).fill(0);
      for (let k = 0; k < cyanX.length; k += 1) {
        const cx = Math.min(7, Math.floor(((cyanX[k] - minX) / w) * 8));
        const cy = Math.min(7, Math.floor(((cyanY[k] - minY) / h) * 8));
        cells[cy * 8 + cx] += 1;
      }
      signature = cells.map((n) => (n > 0 ? 1 : 0)).join("");
    }

    return {
      width: c.width,
      height: c.height,
      region: { x0, y0, x1, y1 },
      cyan,
      magenta,
      yellow,
      peak,
      bbox: cyan > 0 ? { w: maxX - minX + 1, h: maxY - minY + 1 } : null,
      signature
    };
  })()`);
  return { ...pixels, data: captured.data };
}

const override = (key, entry) =>
  evaluate(`window.__arenaAppearance.override(${JSON.stringify(key)}, ${JSON.stringify(entry)}), "ok"`);

// --- The run -----------------------------------------------------------------

const report = { ok: true, url: pageUrl, steps: [], consoleErrors, exceptions };
const step = (name, detail) => report.steps.push({ name, ...detail });

const units = await evaluate(`window.__arenaAppearance.units()`);
const carrying = units.filter((u) => u.appearance === "demo-sequence");
report.armedUnits = carrying;
report.unitCount = units.length;

// Snapshot the registry BEFORE anything is overwritten. Taking it afterwards is how the first
// run of this script "restored" the broken entry it had just installed and then reported that
// the art never came back — a test bug that looked exactly like a renderer bug.
const pristine = await evaluate(`window.__arenaAppearance.registry()`);

// 1. Art authored and loaded, while the field is frozen in the editor.
//
//    Tick 0 puts every unit in `windup` (`initialPhase`), and the editor does not advance the
//    simulation — so what is on screen here is the *attack* slot, held on a single frame. That
//    is the correct rendering, and it makes this step a test of two things at once: that the
//    single-frame path draws at all, and that `windup` selects `attack` over `base`.
const panelArt = await readPanel();
const art = await scan();
step("the attack slot draws while the field is frozen in windup", {
  panelSummary: panelArt?.summary.trim(),
  panelRows: panelArt?.rows,
  yellowPixels: art.yellow,
  cyanPixels: art.cyan,
  magentaPixels: art.magenta
});

let artShot = null;
if (shotPath) {
  artShot = await writeScreenshot(toLocalPath(shotPath), art.data);
}

// 2. No art authored. Removing the entry is how a key that was never registered behaves, and
//    it must look like neither of the other two states.
await override("demo-sequence", null);
await delay(500);
const panelNone = await readPanel();
const none = await scan();
step("an unregistered key falls back to procedural, with no failure marker", {
  panelNote: panelNone?.notes[0],
  panelRowCount: panelNone?.rows.length,
  yellowPixels: none.yellow,
  cyanPixels: none.cyan,
  magentaPixels: none.magenta
});

// 3. Art authored, load fails. A `builtin:` name with no fixture, so the failure runs through
//    the real catch in the real loader rather than a simulated one — and no network request,
//    so the run stays quiet.
await override("demo-sequence", { base: { kind: "single", source: "builtin:no-such-fixture" } });
await delay(700);
const panelFail = await readPanel();
const failed = await scan();
step("a failed load is visible on screen and named in the panel", {
  panelSummary: panelFail?.summary.trim(),
  panelRows: panelFail?.rows,
  yellowPixels: failed.yellow,
  cyanPixels: failed.cyan,
  magentaPixels: failed.magenta
});

let failedShot = null;
if (shotPath) {
  const stem = toLocalPath(shotPath).replace(/\.png$/i, "");
  failedShot = await writeScreenshot(`${stem}.failed.png`, failed.data);
}

// 4. A file that is not there, which is what a real missing asset looks like. Same state, but
//    the reason now has to carry a path a human can act on.
await override("demo-sequence", { base: { kind: "single", source: "art/definitely-not-here.png" } });
await delay(900);
const panelMissing = await readPanel();
const missing = await scan();
step("a missing file reports the path it could not load", {
  panelRows: panelMissing?.rows,
  cyanPixels: missing.cyan,
  magentaPixels: missing.magenta
});

// 5. Put it back. A debug hook that cannot round-trip would leave the page broken after the
//    test, and would make every later assertion measure the wrong thing.
await override("demo-sequence", pristine["demo-sequence"]);
await delay(500);
const panelRestored = await readPanel();
const restored = await scan();
step("restoring the entry brings the art back", {
  panelSummary: panelRestored?.summary.trim(),
  yellowPixels: restored.yellow,
  cyanPixels: restored.cyan,
  magentaPixels: restored.magenta
});

// 6. Run the battle and look for the base sequence.
//
//    This is the only place the *sequence* path can be observed: while the field is frozen the
//    unit is permanently in windup, so the strip is never on screen. Once the fight starts it
//    cycles windup / active / cooldown, and most of the cycle is spent off the telegraph.
const signatures = new Set();
let cyanSeen = 0;
let yellowSeen = 0;
let battleShot = null;
await evaluate(
  `[...document.querySelectorAll(".panel__buttons button")].find((b) => b.textContent.trim() === "开战")?.click(), "clicked"`
);
for (let i = 0; i < 10; i += 1) {
  await delay(180);
  const frame = await scan();
  if (frame.cyan > 0) {
    cyanSeen += 1;
    signatures.add(frame.signature);
    battleShot = frame.data;
  }
  if (frame.yellow > 0) {
    yellowSeen += 1;
  }
}
const phase = await readPhase();
step("the base sequence draws and animates once the battle is running", {
  phase,
  scansWithBaseSequence: cyanSeen,
  scansWithAttackTelegraph: yellowSeen,
  distinctSignatures: signatures.size
});

await evaluate(
  `[...document.querySelectorAll(".panel__buttons button")].find((b) => b.textContent.trim() === "重置")?.click(), "clicked"`
);
await delay(400);

report.screenshots = { failed: failedShot, art: artShot, battle: battleShot };

// --- Verdict -----------------------------------------------------------------

const expectations = [
  [units.length > 0, "the scene must place at least one unit"],
  [carrying.length > 0, "a shipped unit must carry the appearance key under test"],
  [art.yellow > 0, "art must actually be drawn on the canvas"],
  [art.cyan === 0, "a unit frozen in windup must show the attack slot, not the idle strip"],
  [art.magenta === 0, "loaded art must not draw the failure marker"],
  [panelArt?.summary.includes("就绪 1") === true, "the panel must report the key as ready"],
  [panelArt?.rows.length === 1, "the panel must list exactly the one registered key"],
  [none.yellow === 0, "a key with no art must not draw a sprite"],
  [none.cyan === 0, "a key with no art must not draw a sprite"],
  [none.magenta === 0, "a key with no art must not draw the failure marker either"],
  [panelNone?.notes.some((n) => n.includes("注册表为空")) === true, "an empty registry must say so"],
  [failed.yellow === 0, "a failed load must not leave the sprite on screen"],
  [failed.cyan === 0, "a failed load must not leave the sprite on screen"],
  [failed.magenta > 0, "a failed load must be visible on the canvas"],
  [panelFail?.rows.some((r) => r.state === "加载失败") === true, "the panel must report the failure"],
  [panelFail?.summary.includes("失败 1") === true, "the panel tally must count the failure"],
  [
    panelMissing?.rows.some((r) => r.reason.includes("definitely-not-here")) === true,
    "the panel must name the file it could not load"
  ],
  [missing.magenta > 0, "a missing file must stay visible on the canvas"],
  [restored.yellow > 0, "restoring the entry must bring the art back"],
  [restored.magenta === 0, "restoring the entry must clear the failure marker"],
  [phase.includes("交战"), "a battle must still start"],
  [cyanSeen > 0, "the base sequence must be drawn when the unit is not winding up"],
  [signatures.size >= 2, "a sequence must animate rather than freeze on one frame"],
  [consoleErrors.length === 0, "no console errors"],
  [exceptions.length === 0, "no uncaught exceptions"]
];

report.checks = expectations.map(([passed, message]) => ({ passed, message }));
const failedChecks = report.checks.filter((c) => !c.passed);
report.ok = failedChecks.length === 0;
report.failures = failedChecks.map((c) => c.message);
report.placeholderColor = `#${PLACEHOLDER_COLOR.toString(16).padStart(6, "0")}`;

console.log(JSON.stringify(report, null, 2));
socket.close();
process.exit(report.ok ? 0 : 1);
