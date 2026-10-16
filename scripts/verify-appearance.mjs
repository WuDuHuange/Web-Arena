/**
 * End-to-end appearance verification, against pixels.
 *
 * `tests/appearance.test.mjs` proves the decision table: which of the three states a key is
 * in, and what plan comes out. What it cannot prove is the last step — that the renderer
 * draws something *different* for each of them. That is the entire point of the layer, and it
 * is invisible to every test that does not have a canvas: a renderer that ignored the plan
 * and always drew the grey box would pass all of them.
 *
 * So this drives the real build, rewrites a live appearance key through the debug hook, and
 * counts pixels on a real screenshot:
 *
 *   - art authored and loaded  → character pixels, no magenta
 *   - no art authored          → no character pixels, no magenta (the grey box is the render)
 *   - art authored, load fails → magenta, no character pixels
 *
 * Two colours identify the two shipped keys, and the pair is what makes the third state
 * provable rather than merely plausible:
 *
 *   - **zombie green** `#3dbf9e` — the red side, the key this run overwrites.
 *   - **robot blue**   `#5393c5` — the blue side, the control.
 *
 * Overwriting one key must leave the other side drawing. Without that control, "the sprite
 * disappeared" and "the renderer stopped drawing anything" are the same observation, and the
 * second one is a far worse bug than the first.
 *
 * Both predicates are deliberately narrow, and each exclusion clause names a colour that is
 * genuinely on screen. The one that matters most is the **health bar** `#63c07a`: it is green,
 * it is drawn by `drawChrome` for every living unit regardless of what the appearance layer
 * decided, and a loose green test counts it as zombie art. That is not a hypothetical — an
 * earlier version of this file did exactly that and reported 683 health-bar pixels as sprite,
 * which turned "a key with no art must not draw a sprite" into a failure no renderer change
 * could have fixed. The exclusions and their reasons are spelled out at the predicates.
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

/** The key this run overwrites, and the one it must leave alone. */
const SUBJECT = "toon-zombie";
const CONTROL = "toon-robot";

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
// put a 128-pixel portrait near the edge of legibility. Set the viewport explicitly rather
// than trusting the window size the launcher was given.
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

/**
 * Polls the panel until it answers a question, rather than sleeping a guessed duration.
 *
 * Every step below changes what the panel should say and then reads it. A fixed delay encodes
 * how fast the machine was the day it was written: it is long enough on an idle laptop and too
 * short in a batch run, where the panel's 250 ms poll is throttled and the read lands on the
 * previous state. Waiting on the condition itself is the only version that is right on both.
 *
 * Returns the last panel it read even on timeout, so a failure reports what was actually on
 * screen instead of `undefined`.
 */
const waitForPanel = async (predicate, timeoutMs = 12_000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const panel = await readPanel();
    if (panel && predicate(panel)) return panel;
    if (Date.now() > deadline) return panel;
    await delay(200);
  }
};

const readPhase = () => evaluate(`document.querySelector(".panel__phase")?.textContent ?? ""`);

/**
 * Counts the colours that identify each state, over the canvas only.
 *
 * Whole-region rather than a box around one unit: the mapping from world units to screenshot
 * pixels depends on the fit transform, the device pixel ratio and the window size, and a box
 * that silently landed in the wrong place would pass or fail for the wrong reason.
 *
 * The HUD is hidden for the capture. It floats over the canvas, so its pixels land inside the
 * canvas rectangle — and while it is dark and low-saturation today, "does not match the
 * predicate today" is not the same as "cannot match", and the fix is two evaluates.
 */
async function scan() {
  await evaluate(`for (const el of document.querySelectorAll(".hud")) el.style.display = "none"`);
  const captured = await send("Page.captureScreenshot", { format: "png" });
  await evaluate(`for (const el of document.querySelectorAll(".hud")) el.style.display = ""`);

  const pixels = await evaluate(`(async () => {
    const img = new Image();
    img.src = "data:image/png;base64,${captured.data}";
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);

    const rect = document.querySelector("canvas").getBoundingClientRect();
    const k = c.width / window.innerWidth;
    const x0 = Math.max(0, Math.round(rect.left * k));
    const y0 = Math.max(0, Math.round(rect.top * k));
    const x1 = Math.min(c.width, Math.round(rect.right * k));
    const y1 = Math.min(c.height, Math.round(rect.bottom * k));
    const { data } = ctx.getImageData(x0, y0, Math.max(x1 - x0, 1), Math.max(y1 - y0, 1));

    let zombie = 0;
    let robot = 0;
    let magenta = 0;
    let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
    const regionWidth = x1 - x0;
    const regionHeight = y1 - y0;

    for (let y = 0; y < regionHeight; y += 1) {
      for (let x = 0; x < regionWidth; x += 1) {
        const i = (y * regionWidth + x) * 4;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];

        // Magenta first: the failure marker is the one colour nothing else in the arena uses,
        // and matching it must never be shadowed by a looser predicate below.
        if (r > 200 && g < 110 && b > 160) {
          magenta += 1;
        } else if (g > 130 && g - r > 100 && b > 105 && b < 200 && r < 110) {
          // The zombie's skin, #3dbf9e. The g - r > 100 clause is the load-bearing one, and
          // it is there for exactly one reason: the **health bar**. A full-health unit draws
          // a bar in #63c07a — (99,192,122) — which is g - r = 93, and every way that green
          // can be blended on screen (into its own dark backing, into the floor, into the
          // arena background) moves all three channels toward a darker, less green point, so
          // 93 is the ceiling for the whole family. A first version of this predicate used
          // g - r > 60 and counted 683 pixels of health bar as zombie art, which made "a key
          // with no art must not draw a sprite" fail with the sprite correctly absent. The
          // bar is drawn by drawChrome and has nothing to do with the appearance layer, so
          // no amount of correct renderer behaviour could ever have fixed that.
          //
          // 100 rather than 94 for headroom: the sprite's own anti-aliased edges blend toward
          // the dark arena and their g - r falls away from 130 quickly, so the clause is not
          // near any zombie pixel it needs to keep.
          zombie += 1;
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        } else if (b > 160 && b - g > 15 && b - g < 65 && b - r > 80 && g > 110 && g < 200 && r < 130) {
          // The robot's armour, #5393c5. Two clauses are doing exclusion work:
          //
          //   b - g < 65  keeps out #4b8fe0, the blue faction colour. Without it a blue
          //               unit's facing marker would read as robot art and the "no art
          //               authored" step would pass with a sprite on screen.
          //   b - g > 15  keeps out the near-grey facing marker #e8edf7 (b - g = 10).
          //   g < 200     keeps out the prop glows #7fd4e8 (g = 212) and #c792ea (b - g = 88).
          robot += 1;
        }
      }
    }

    return {
      width: c.width,
      height: c.height,
      region: { x0, y0, x1, y1 },
      zombie,
      robot,
      magenta,
      bbox: zombie > 0 ? { w: maxX - minX + 1, h: maxY - minY + 1 } : null
    };
  })()`);
  return { ...pixels, data: captured.data };
}

const override = (key, entry) =>
  evaluate(`window.__arenaAppearance.override(${JSON.stringify(key)}, ${JSON.stringify(entry)}), "ok"`);

// --- The run -----------------------------------------------------------------

const report = { ok: true, url: pageUrl, subject: SUBJECT, control: CONTROL, steps: [], consoleErrors, exceptions };
const step = (name, detail) => report.steps.push({ name, ...detail });

const units = await evaluate(`window.__arenaAppearance.units()`);
const carrying = units.filter((u) => u.appearance === SUBJECT);
report.armedUnits = carrying;
report.unitCount = units.length;
report.keysInUse = [...new Set(units.map((u) => u.appearance))].sort();

// Snapshot the registry BEFORE anything is overwritten. Taking it afterwards is how an
// earlier version of this script "restored" the broken entry it had just installed and then
// reported that the art never came back — a test bug that looked exactly like a renderer bug.
const pristine = await evaluate(`window.__arenaAppearance.registry()`);

// 1. Art authored and loaded, while the field is frozen in the editor.
//
//    Tick 0 puts every unit in `windup` (`initialPhase`), and the editor does not advance the
//    simulation — so what is on screen here is the *attack* slot, held on a single frame.
//    That is the correct rendering, and it makes this step a test of two things at once: that
//    the single-frame path draws at all, and that `windup` selects `attack` over `base`.
//
//    Waiting for the panel to *settle*, not merely to say something. "The debug hooks exist"
//    is not the same as "the registry has finished", and neither is "the status line is
//    non-empty": that line is rendered from the first poll, when it reads 就绪 0 · 加载中 2.
//    Accepting it read a loading state as a settled one, and the assertion that both keys are
//    ready then failed against a panel that had not caught up — while the pixels in the same
//    step showed the art already drawn. Head-less Chrome reports the page as hidden, which
//    throttles the panel's 250 ms poll to roughly a second, so the window is wide enough to
//    hit in a batch run and narrow enough to miss on an idle machine. The condition has to be
//    "nothing is still loading", which is the one thing the summary actually reports.
let panelSettled = false;
for (let i = 0; i < 60 && !panelSettled; i += 1) {
  panelSettled = (await evaluate(`(() => {
    const block = [...document.querySelectorAll(".panel__block")]
      .find((b) => b.querySelector("h2")?.textContent === "外观");
    const text = (block?.querySelector(".panel__ok, .panel__alert")?.textContent ?? "").trim();
    return text.length > 0 && !/加载中 [1-9]/.test(text);
  })()`)) === true;
  if (!panelSettled) {
    await delay(200);
  }
}

const panelArt = await readPanel();
const art = await scan();
step("the attack slot draws while the field is frozen in windup", {
  panelSettled,
  panelSummary: panelArt?.summary.trim(),
  panelRows: panelArt?.rows,
  zombiePixels: art.zombie,
  robotPixels: art.robot,
  magentaPixels: art.magenta,
  zombieBox: art.bbox
});

let artShot = null;
if (shotPath) {
  artShot = await writeScreenshot(toLocalPath(shotPath), art.data);
}

// 2. No art authored. Removing the entry is how a key that was never registered behaves, and
//    it must look like neither of the other two states. The control side must keep drawing:
//    without it, "the sprite is gone" and "the renderer is gone" are the same observation.
await override(SUBJECT, null);
const panelNone = await waitForPanel((panel) => panel.rows.length === 1);
// The renderer is a 60 Hz loop, so a quarter second is fifteen frames — this delay is about
// giving it a frame, not about waiting for anything to answer.
await delay(250);
const none = await scan();
step("an unregistered key falls back to procedural, and only that key", {
  panelSummary: panelNone?.summary.trim(),
  panelRowCount: panelNone?.rows.length,
  zombiePixels: none.zombie,
  robotPixels: none.robot,
  magentaPixels: none.magenta
});

// 3. Art authored, load fails. A slot the asset table does not know, so the failure runs
//    through the real resolver and the real catch rather than a simulated one — and no
//    network request, so the run stays quiet.
await override(SUBJECT, { base: { kind: "single", source: "asset:no-such-slot" } });
const panelFail = await waitForPanel((panel) => panel.rows.some((row) => row.state === "加载失败"));
await delay(250);
const failed = await scan();
step("a failed load is visible on screen and named in the panel", {
  panelSummary: panelFail?.summary.trim(),
  panelRows: panelFail?.rows,
  zombiePixels: failed.zombie,
  robotPixels: failed.robot,
  magentaPixels: failed.magenta
});

let failedShot = null;
if (shotPath) {
  const stem = toLocalPath(shotPath).replace(/\.png$/i, "");
  failedShot = await writeScreenshot(`${stem}.failed.png`, failed.data);
}

// 4. A file that is not there, which is what a real missing asset looks like. Same state, but
//    the reason now has to carry a path a human can act on.
await override(SUBJECT, { base: { kind: "single", source: "art/definitely-not-here.png" } });
const panelMissing = await waitForPanel((panel) =>
  panel.rows.some((row) => row.reason.includes("definitely-not-here"))
);
await delay(250);
const missing = await scan();
step("a missing file reports the path it could not load", {
  panelRows: panelMissing?.rows,
  zombiePixels: missing.zombie,
  magentaPixels: missing.magenta
});

// 5. Put it back. A debug hook that cannot round-trip would leave the page broken after the
//    test, and would make every later assertion measure the wrong thing.
await override(SUBJECT, pristine[SUBJECT]);
const panelRestored = await waitForPanel(
  (panel) => panel.rows.length === 2 && panel.rows.every((row) => row.state === "已就绪")
);
await delay(250);
const restored = await scan();
step("restoring the entry brings the art back", {
  panelSummary: panelRestored?.summary.trim(),
  zombiePixels: restored.zombie,
  robotPixels: restored.robot,
  magentaPixels: restored.magenta
});

// 6. Run the battle and look for the base slot.
//
//    This is the other half of the slot switch: while the field is frozen the unit is
//    permanently in windup, so the idle pose is never on screen. Once the fight starts it
//    cycles windup / active / cooldown, and most of the cycle is spent off the telegraph.
//
//    The window is bounded by the battle, not by a fixed iteration count. A flat ten
//    iterations silently assumed the fight outlives the scanning, and it does not: each
//    iteration captures and decodes a full-page PNG. Scanning past the decision measures an
//    empty arena, and an empty arena has no sprite to find.
let battleShot = null;
let sawRunning = false;
let battleZombie = 0;
let battleScans = 0;

await evaluate(
  `[...document.querySelectorAll(".panel__buttons button")].find((b) => b.textContent.trim() === "开战")?.click(), "clicked"`
);

// The phase readout is polled at 250 ms, so 开战 does not appear in it immediately.
for (let i = 0; i < 40 && !sawRunning; i += 1) {
  await delay(150);
  sawRunning = (await readPhase()).includes("交战");
}

for (let i = 0; i < 40; i += 1) {
  const frame = await scan();
  if (frame.zombie > 0) {
    battleZombie = Math.max(battleZombie, frame.zombie);
    battleShot = frame.data;
    battleScans += 1;
  }
  if (!(await readPhase()).includes("交战")) {
    break;
  }
  await delay(120);
}

step("the base slot draws once the battle is running", {
  sawRunning,
  scansWithCharacterArt: battleScans,
  peakZombiePixels: battleZombie
});

await evaluate(
  `[...document.querySelectorAll(".panel__buttons button")].find((b) => b.textContent.trim() === "重置")?.click(), "clicked"`
);
await delay(400);

report.screenshots = { failed: failedShot, art: artShot, battle: battleShot };

// --- Verdict -----------------------------------------------------------------

const expectations = [
  [units.length > 0, "the scene must place at least one unit"],
  [carrying.length > 0, `a shipped unit must carry the appearance key ${SUBJECT}`],
  [report.keysInUse.includes(CONTROL), `the scene must also place a unit drawing ${CONTROL}`],
  [art.zombie > 0, "the red side's art must actually be drawn on the canvas"],
  [art.robot > 0, "the blue side's art must actually be drawn on the canvas"],
  [art.magenta === 0, "loaded art must not draw the failure marker"],
  [panelArt?.summary.includes("就绪 2") === true, "the panel must report both keys as ready"],
  [panelArt?.rows.length === 2, "the panel must list both registered keys"],
  [none.zombie === 0, "a key with no art must not draw a sprite"],
  [none.magenta === 0, "a key with no art must not draw the failure marker either"],
  [none.robot > 0, "overwriting one key must leave the other side drawing"],
  [panelNone?.rows.length === 1, "the panel must drop the removed key from its list"],
  [failed.zombie === 0, "a failed load must not leave the sprite on screen"],
  [failed.robot > 0, "a failed load must not take the other side down with it"],
  [failed.magenta > 0, "a failed load must be visible on the canvas"],
  [panelFail?.rows.some((r) => r.state === "加载失败") === true, "the panel must report the failure"],
  [
    panelMissing?.rows.some((r) => r.reason.includes("definitely-not-here")) === true,
    "the panel must name the file it could not load"
  ],
  [missing.magenta > 0, "a missing file must stay visible on the canvas"],
  [restored.zombie > 0, "restoring the entry must bring the art back"],
  [restored.magenta === 0, "restoring the entry must clear the failure marker"],
  // Asserts the click actually started a fight, not that a fight is still in progress by the
  // time the observation window closes — which is what a phase read afterwards measures.
  [sawRunning, "a battle must still start"],
  [battleScans > 0, "the base slot must be drawn when the unit is not winding up"],
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
