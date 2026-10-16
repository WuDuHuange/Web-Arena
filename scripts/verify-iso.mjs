/**
 * End-to-end verification of the 2.5D view, against pixels.
 *
 * `tests/projection.test.mjs` proves the map: that the inverse is an inverse, that a ground
 * circle becomes a 2:1 ellipse, that depth and screen height order points the same way. What
 * it cannot prove is that the renderer *uses* the map — a battlefield that ignored the
 * projector entirely would pass all 21 of those.
 *
 * So this drives the real build and checks four things the unit tests cannot reach:
 *
 *   1. **The arena is a diamond.** Measured as the width of the topmost non-background row:
 *      the flat view's top edge is a full horizontal line, the isometric view's is a vertex.
 *      One number separates the two views, and it is not something a stylesheet can fake.
 *   2. **The teams moved to opposite corners.** In flat both teams sit at the same height; in
 *      isometric the low-x team is up-left and the high-x team is down-right. This is the
 *      check that the ground matrix is applied to the whole floor rather than to some of it.
 *   3. **A unit is drawn where the projection says it is.** The script derives the world to
 *      client-pixel mapping itself and then requires the unit's own faction colour to be
 *      under that point. If the derivation were wrong the assertion fails, rather than
 *      passing for the wrong reason.
 *   4. **A dragged unit lands under the cursor.** This is the one that matters. The editor
 *      converts a pointer position back to world coordinates, so if `unproject` is off by
 *      anything, the unit is dropped somewhere offset from the cursor — and the offset grows
 *      with distance from the origin, which is exactly the kind of bug that survives a
 *      casual look at a screenshot.
 *
 * ## Why the geometry checks pin the appearance layer to procedural
 *
 * Checks 2 and 3 identify the two teams by their **faction fill** — a solid `#e0554b` or
 * `#4b8fe0` disc. That predicate only works while some unit is drawn procedurally, and since
 * the character-art phase every character in the library resolves to a bitmap: the shipped
 * scene has no procedural disc left. Left alone, the predicate then latches onto whatever
 * else happens to be red or blue on the floor — an aura prop's `#ff7a3c` glow reads as red
 * and the robot's `#5393c5` armour reads as blue — and the "teams are in opposite corners"
 * check reports the arena upside down. It did exactly that.
 *
 * So the geometry phases overwrite every shipped key with `null` through the debug hook
 * first, which is the state a key that was never registered is in: every unit falls through
 * to the procedural body. That is not a weaker test. The subject of these checks is the
 * **floor matrix** — where the projection put the units — and a procedural body is the one
 * rendering whose colour is a property of the simulation rather than of whichever art pack
 * is loaded. It also keeps this script from breaking the next time the art changes.
 *
 * Art gets its own phase at the end: the keys are restored and a unit drawn from art has to
 * have its pixels on its projected point, which is the half of claim 3 the procedural bodies
 * cannot speak to. (The earlier version of this check asked for the demo fixture's yellow
 * attack ring. That fixture is gone; it had been passing by matching a prop glow.)
 *
 * Usage: node --experimental-strip-types scripts/verify-iso.mjs <pageUrl> [--port=9336] [--shot=out]
 */
import { statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import { createProjector } from "../src/render/projection.ts";

const args = process.argv.slice(2);
const rawUrl = args.find((a) => !a.startsWith("--"));
if (!rawUrl) {
  console.error("usage: node --experimental-strip-types scripts/verify-iso.mjs <pageUrl> [--port=9336] [--shot=out]");
  process.exit(2);
}

const readFlag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const port = Number(readFlag("port", "9336"));
const shotStem = readFlag("shot", "");

const buildUrl = (query) => {
  const url = new URL(rawUrl);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
};

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

// --- CDP ---------------------------------------------------------------------

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
    const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
    throw new Error(`evaluate failed: ${detail}`);
  }
  return result.result.value;
};

await send("Page.enable");
await send("Runtime.enable");
// Head-less defaults to a small viewport, which would letterbox the arena into a strip and
// make the shape assertions meaningless.
await send("Emulation.setDeviceMetricsOverride", {
  width: 1440,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false
});

// --- helpers -----------------------------------------------------------------

const checks = [];
const check = (passed, message, detail) => {
  checks.push({ passed, message, ...(detail === undefined ? {} : { detail }) });
};

const override = (key, entry) =>
  evaluate(`window.__arenaAppearance.override(${JSON.stringify(key)}, ${JSON.stringify(entry)}), "ok"`);

/**
 * The shipped registry, captured before the geometry phases pin it to `null`.
 *
 * Snapshotting first is not optional: `override(key, null)` removes the key, so the registry
 * read afterwards no longer knows what the entry was. `verify-appearance.mjs` has a comment
 * about an earlier version of *that* script "restoring" the broken entry it had just
 * installed and then reporting the art never came back.
 */
let pristine = null;

async function open(query, { procedural = false } = {}) {
  await send("Page.navigate", { url: buildUrl(query) });
  const deadline = Date.now() + 25_000;
  let ready = false;
  while (Date.now() < deadline) {
    ready = await evaluate(`!!document.querySelector("canvas") && !!window.__arenaAppearance`);
    if (ready) {
      break;
    }
    await delay(300);
  }
  if (!ready) {
    throw new Error(`app did not mount for ${JSON.stringify(query)}`);
  }
  // Dismiss the first-run overlay: it is a real modal over the arena and would swallow the
  // synthetic pointer events the drag test dispatches.
  await evaluate(`document.querySelector(".help__footer button")?.click(), "dismissed"`);
  await delay(400);

  if (procedural) {
    if (pristine === null) {
      pristine = await evaluate(`window.__arenaAppearance.registry()`);
    }
    // Pinned one key at a time rather than in a batch, because each call is a round trip and
    // a half-applied pin would leave the scene in a state neither phase expects.
    for (const key of Object.keys(pristine)) {
      await override(key, null);
    }
    await delay(500);
  }
}

/** Puts the shipped art back, for the one check that needs it. */
async function restoreArt() {
  if (pristine === null) {
    return [];
  }
  for (const [key, entry] of Object.entries(pristine)) {
    await override(key, entry);
  }
  await delay(600);
  return Object.keys(pristine);
}

/**
 * Reads the canvas and reports the shape of what is drawn on it.
 *
 * Restricted to the canvas rectangle, and the HUD is hidden for the capture. The rectangle
 * alone is not enough: the HUD floats *over* the canvas, so its chrome lands inside the
 * region and is counted as arena pixels. The scan was measuring the stylesheet.
 *
 * The leak was found, rather than reasoned about, because the 收起布阵 pill happened to be
 * painted in exactly the blue faction colour -- the stylesheet carried one token for "this
 * control is active" and for "this unit is on the blue side". That token is gone now, but the
 * leak was never about that one colour: any chrome drifting over the canvas rectangle gets
 * counted. Hiding the HUD is what actually fixes it, and it is why this is not a filter on
 * the predicate.
 *
 * It used to pass by luck: the top strip sat outside the canvas rectangle, because the open
 * drawer pushed the stage inwards. Insetting the strip so the drawer stopped covering its
 * buttons moved those pixels inside the region and the luck ran out. The premise "everything
 * inside the canvas rect is the arena" was never true; this makes it true.
 *
 * Hidden and restored around the capture only — nothing here asserts anything about the HUD,
 * and the drag test below still needs it back in the tree.
 */
async function scan() {
  await evaluate(`for (const el of document.querySelectorAll(".hud")) el.style.display = "none"`);
  await delay(150);
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

    const canvas = document.querySelector("canvas");
    const rect = canvas.getBoundingClientRect();
    const k = c.width / window.innerWidth;
    const x0 = Math.max(0, Math.round(rect.left * k));
    const y0 = Math.max(0, Math.round(rect.top * k));
    const x1 = Math.min(c.width, Math.round(rect.right * k));
    const y1 = Math.min(c.height, Math.round(rect.bottom * k));
    const regionWidth = Math.max(x1 - x0, 1);
    const regionHeight = Math.max(y1 - y0, 1);
    const { data } = ctx.getImageData(x0, y0, regionWidth, regionHeight);

    // The canvas is filled with the renderer's background colour, so "drawn" is "differs
    // from it". A tolerance rather than equality, because every edge here is anti-aliased.
    const BG = { r: 27, g: 31, b: 42 };
    const drawn = (r, g, b) =>
      Math.abs(r - BG.r) > 24 || Math.abs(g - BG.g) > 24 || Math.abs(b - BG.b) > 24;

    // Red 0xe0554b and blue 0x4b8fe0 are the faction fills. The tolerances are wide enough
    // for the anti-aliased rim and for the dark stroke around each body.
    const isRed = (r, g, b) => r > 150 && g < 130 && b < 120 && r - g > 60;
    const isBlue = (r, g, b) => b > 150 && r < 140 && b - r > 60;

    let topRow = -1;
    let topRowWidth = 0;
    let topRowMinX = -1;
    let topRowMaxX = -1;
    let minY = -1, maxY = -1, minX = 1e9, maxX = -1;
    const red = { n: 0, x: 0, y: 0 };
    const blue = { n: 0, x: 0, y: 0 };

    for (let y = 0; y < regionHeight; y += 1) {
      for (let x = 0; x < regionWidth; x += 1) {
        const i = (y * regionWidth + x) * 4;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];

        if (drawn(r, g, b)) {
          if (topRow === -1) { topRow = y; topRowMinX = x; topRowMaxX = x; }
          if (y === topRow) {
            topRowWidth += 1;
            if (x < topRowMinX) topRowMinX = x;
            if (x > topRowMaxX) topRowMaxX = x;
          }
          if (minY === -1) minY = y;
          maxY = y;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
        }

        if (isRed(r, g, b)) { red.n += 1; red.x += x; red.y += y; }
        else if (isBlue(r, g, b)) { blue.n += 1; blue.x += x; blue.y += y; }
      }
    }

    return {
      region: { x0, y0, x1, y1, width: regionWidth, height: regionHeight },
      // Offset back into screenshot coordinates so the drag helper can compare against
      // client coordinates scaled by k.
      topRow: topRow === -1 ? null : { y: topRow, width: topRowWidth, minX: topRowMinX, maxX: topRowMaxX },
      bbox: minY === -1 ? null : { minX, minY, maxX, maxY },
      red: red.n > 0 ? { n: red.n, cx: red.x / red.n, cy: red.y / red.n } : null,
      blue: blue.n > 0 ? { n: blue.n, cx: blue.x / blue.n, cy: blue.y / blue.n } : null,
      k
    };
  })()`);
  return { ...pixels, data: captured.data };
}

/**
 * The canvas box in client coordinates.
 *
 * The renderer's own mapping is derived here rather than asked for, because a test that
 * asks the thing under test where it thinks a unit is has asserted nothing. Deriving it and
 * then requiring faction colour to be under the derived point is what gives the derivation
 * teeth: if it were wrong, the assertion fails instead of passing for the wrong reason.
 */
async function deriveMapping() {
  return evaluate(`(() => {
    const c = document.querySelector("canvas");
    const r = c.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  })()`);
}

// --- 1 & 2: flat vs isometric shape -----------------------------------------

await open({ scene: "battle", view: "flat", debug: "1" }, { procedural: true });
const flat = await scan();
const flatBadge = await evaluate(
  `[...document.querySelectorAll(".app__badge")].map((b) => b.textContent).join("|")`
);

await open({ scene: "battle", view: "iso", debug: "1" }, { procedural: true });
const iso = await scan();
const isoBadge = await evaluate(
  `[...document.querySelectorAll(".app__badge")].map((b) => b.textContent).join("|")`
);

check(
  !flatBadge.includes("2.5D") && isoBadge.includes("2.5D"),
  "the view badge distinguishes the two modes",
  { flatBadge, isoBadge }
);

// The top edge of a rectangle is a long run of pixels; the top vertex of a diamond is a
// handful. Comparing the two views on the same scene is what makes this a shape test rather
// than a threshold that happens to pass.
const flatTopWidth = flat.topRow?.width ?? 0;
const isoTopWidth = iso.topRow?.width ?? 0;
check(
  flatTopWidth > 200,
  "the flat arena's top edge is a wide horizontal run",
  { flatTopWidth, flatBboxWidth: flat.bbox ? flat.bbox.maxX - flat.bbox.minX + 1 : 0 }
);
check(
  isoTopWidth > 0 && isoTopWidth < flatTopWidth / 8,
  "the isometric arena's top is a vertex, not an edge",
  { isoTopWidth, flatTopWidth }
);

// A diamond is widest in the middle. Measure the drawn extent on the middle row and require
// it to be substantially wider than the top row, which a rectangle's top edge cannot be.
check(
  iso.bbox !== null && iso.topRow !== null,
  "the isometric view drew something",
  { isoBbox: iso.bbox }
);

// --- 2: the teams moved to opposite corners ----------------------------------

const flatRed = flat.red;
const flatBlue = flat.blue;
const isoRed = iso.red;
const isoBlue = iso.blue;

check(
  flatRed !== null && flatBlue !== null && Math.abs(flatRed.cy - flatBlue.cy) < 40,
  "in flat both teams stand at the same height",
  { flatRedY: flatRed?.cy, flatBlueY: flatBlue?.cy }
);
check(
  isoRed !== null && isoBlue !== null && isoRed.cy < isoBlue.cy - 40,
  "in isometric the low-x team is drawn higher up the screen",
  { isoRedY: isoRed?.cy, isoBlueY: isoBlue?.cy }
);
check(
  isoRed !== null && isoBlue !== null && isoRed.cx < isoBlue.cx,
  "in isometric the teams are still left to right",
  { isoRedX: isoRed?.cx, isoBlueX: isoBlue?.cx }
);

// --- 3: a unit is drawn where the projection says ----------------------------

const bounds = { width: 960, height: 600 };
const projector = createProjector("iso", bounds);
const extent = projector.projectedExtent();
const box = await deriveMapping();
const fitScale = Math.min(box.width / extent.width, box.height / extent.height);
const toClient = (worldX, worldY) => {
  const p = projector.project(worldX, worldY);
  return { x: box.left + p.x * fitScale, y: box.top + p.y * fitScale };
};

const units = await evaluate(`window.__arenaAppearance.units()`);
check(units.length >= 4, "the scene exposes its units", { count: units.length });

/**
 * Is there a pixel of this kind within `radius` screenshot pixels of this client point?
 *
 * The radius matters and is therefore a parameter, because the two kinds of subject have
 * different shapes. A procedural body is a filled disc the size of the collider, so a box the
 * size of the unit lands on it. A character portrait is anchored at its **feet** and stands
 * up from the projected point, so the box has to be tall enough to reach the body: the feet
 * are the bottom edge of the sprite and are mostly transparent.
 */
async function colourNear(clientX, clientY, kind, radiusCss = 12) {
  const shot = await send("Page.captureScreenshot", { format: "png" });
  const hit = await evaluate(`(async () => {
    const img = new Image();
    img.src = "data:image/png;base64,${shot.data}";
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const k = c.width / window.innerWidth;
    const cx = Math.round(${clientX} * k);
    const cy = Math.round(${clientY} * k);
    const radius = Math.round(${radiusCss} * k);
    const x0 = Math.max(0, cx - radius);
    const y0 = Math.max(0, cy - radius);
    const w = Math.min(c.width, cx + radius) - x0;
    const h = Math.min(c.height, cy + radius) - y0;
    const { data } = ctx.getImageData(x0, y0, Math.max(w, 1), Math.max(h, 1));
    const matches = {
      red: (r, g, b) => r > 150 && g < 130 && b < 120 && r - g > 60,
      blue: (r, g, b) => b > 150 && r < 140 && b - r > 60,
      // The shipped character art, for the phase that runs with the keys restored. Same two
      // predicates as verify-appearance.mjs, and narrow for the same reason: the red side's
      // skin #3dbf9e is g - r = 130 while the health-bar green #63c07a is 93, and the blue
      // side's armour #5393c5 is b - g = 50 while the faction blue #4b8fe0 is 81.
      zombieArt: (r, g, b) => g > 130 && g - r > 100 && b > 105 && b < 200 && r < 110,
      robotArt: (r, g, b) => b > 160 && b - g > 15 && b - g < 65 && b - r > 80 && g > 110 && g < 200 && r < 130
    }[${JSON.stringify(kind)}];
    let n = 0;
    // The most "warm" pixel in the region, for when a strict threshold finds nothing and the
    // question is whether the art is missing or the threshold is simply too tight.
    let warmest = { r: 0, g: 0, b: 0, score: -999 };
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (r - b > warmest.score) warmest = { r, g, b, score: r - b };
      if (matches(r, g, b)) n += 1;
    }
    return { n, k, warmest };
  })()`);
  return hit;
}

// Picked by coordinate rather than by array order, so the test does not depend on how the
// scene was authored.
//
// The registry is read from the page rather than assumed, and in this phase it is empty on
// purpose: `open(..., { procedural: true })` pinned every shipped key to `null`, so every
// unit falls through to the procedural body and the faction-colour predicate has something
// to find. Asserting the registry is empty is what proves the pin took — without it, a pin
// that silently failed would leave this check measuring the wrong pixels, which is the exact
// failure this whole phase exists to prevent.
const registryKeys = new Set(Object.keys(await evaluate(`window.__arenaAppearance.registry()`)));
const drawsArt = (unit) => unit.appearance !== undefined && registryKeys.has(unit.appearance);

const sortedByX = [...units].sort((a, b) => a.x - b.x);
const redUnit = sortedByX.find((u) => u.x < bounds.width / 2 && !drawsArt(u));
const blueUnit = [...sortedByX].reverse().find((u) => u.x > bounds.width / 2 && !drawsArt(u));

check(
  registryKeys.size === 0 && redUnit !== undefined && blueUnit !== undefined,
  "the scene has a procedural unit per side",
  {
    redUnit: redUnit && { id: redUnit.id, x: redUnit.x, y: redUnit.y },
    blueUnit: blueUnit && { id: blueUnit.id, x: blueUnit.x, y: blueUnit.y },
    registryKeys: [...registryKeys]
  }
);

if (redUnit) {
  const point = toClient(redUnit.x, redUnit.y);
  const hit = await colourNear(point.x, point.y, "red");
  check(hit.n > 0, "a procedural red unit is drawn at its projected position", { point, pixels: hit.n });
}

if (blueUnit) {
  const point = toClient(blueUnit.x, blueUnit.y);
  const hit = await colourNear(point.x, point.y, "blue");
  check(hit.n > 0, "a procedural blue unit is drawn at its projected position", { point, pixels: hit.n });
}

// --- 4: a drag lands under the cursor ---------------------------------------

/**
 * Drags a unit by a screen-space delta and reports where it ended up.
 *
 * The assertion is not "the unit moved". It is that the unit's *new projected position*
 * equals the point the cursor was released at — which is only true if the editor's
 * screen-to-world conversion is the exact inverse of the renderer's world-to-screen one.
 * A wrong inverse still moves the unit, and still looks plausible in a screenshot.
 */
async function dragUnit(worldX, worldY, dx, dy) {
  const from = toClient(worldX, worldY);
  const steps = [
    { type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 },
    { type: "mouseMoved", x: from.x + dx / 2, y: from.y + dy / 2, button: "left", buttons: 1 },
    { type: "mouseMoved", x: from.x + dx, y: from.y + dy, button: "left", buttons: 1 },
    { type: "mouseReleased", x: from.x + dx, y: from.y + dy, button: "left", buttons: 0, clickCount: 1 }
  ];
  for (const step of steps) {
    await send("Input.dispatchMouseEvent", step);
    await delay(70);
  }
  await delay(250);
  return { from, to: { x: from.x + dx, y: from.y + dy } };
}

const before = await evaluate(`window.__arenaAppearance.units()`);
const targetUnit =
  (redUnit && before.find((u) => u.id === redUnit.id)) ??
  before.find((u) => !drawsArt(u)) ??
  before[0];
const drag = await dragUnit(targetUnit.x, targetUnit.y, 120, -70);
const after = await evaluate(`window.__arenaAppearance.units()`);
const moved = after.find((u) => u.id === targetUnit.id);

check(moved !== undefined, "the dragged unit still exists", { id: targetUnit.id });
check(
  moved && (Math.abs(moved.x - targetUnit.x) > 1 || Math.abs(moved.y - targetUnit.y) > 1),
  "the drag actually moved the unit",
  { before: { x: targetUnit.x, y: targetUnit.y }, after: moved && { x: moved.x, y: moved.y } }
);

if (moved) {
  const landed = toClient(moved.x, moved.y);
  const errorPx = Math.hypot(landed.x - drag.to.x, landed.y - drag.to.y);
  // Two pixels of slack: the editor snaps nothing, but a pointer move is a float and the
  // projection is a division, so exact equality would be a brittle assertion about rounding.
  check(
    errorPx < 2,
    "the unit lands under the cursor, so unproject is the inverse of project",
    { cursor: drag.to, landed, errorPx: Number(errorPx.toFixed(3)) }
  );
}

// --- 5: art is positioned by the projection, not squashed by it ---------------

// The phases above pinned the appearance layer to procedural bodies, which is what makes the
// faction-colour predicate trustworthy — and also what makes them silent about art. This puts
// the shipped keys back and asks the other half of claim 3: a bitmap is *positioned* at the
// projected point while being drawn square to the camera. Had the billboard been pushed
// through the ground matrix it would be sheared away from that point, and the further the
// unit sits from the origin the further off it would land.
//
// The box is wider than the procedural one on purpose. A portrait is anchored at its feet, so
// the projected point is the *bottom* of the sprite and the body stands above it; a box the
// size of the collider would sample the transparent feet and report "no art".
//
// The right-most art unit is chosen rather than the left-most: the diagnostics panel is a
// left-hand overlay, and a subject underneath it would measure the stylesheet instead of the
// sprite.
const restoredKeys = await restoreArt();
const artUnits = await evaluate(`window.__arenaAppearance.units()`);
const artUnit = artUnits
  .filter((u) => u.appearance !== undefined && restoredKeys.includes(u.appearance))
  .map((u) => ({ unit: u, client: toClient(u.x, u.y) }))
  .sort((a, b) => b.client.x - a.client.x)[0];

check(restoredKeys.length > 0 && artUnit !== undefined, "restoring the keys puts art back on the field", {
  restoredKeys,
  artUnit: artUnit && { id: artUnit.unit.id, appearance: artUnit.unit.appearance }
});

if (artUnit) {
  const kind = artUnit.unit.appearance === "toon-zombie" ? "zombieArt" : "robotArt";
  const hit = await colourNear(artUnit.client.x, artUnit.client.y, kind, 46);
  check(hit.n > 0, "a unit drawn from art is positioned by the projection, not squashed by it", {
    point: artUnit.client,
    kind,
    pixels: hit.n,
    warmest: hit.warmest,
    unit: { id: artUnit.unit.id, x: artUnit.unit.x, y: artUnit.unit.y, appearance: artUnit.unit.appearance }
  });
}

// --- report ------------------------------------------------------------------

let shot = null;
if (shotStem) {
  const last = await send("Page.captureScreenshot", { format: "png" });
  shot = await writeScreenshot(`${shotStem}.png`, last.data);
}

const failures = checks.filter((c) => !c.passed);
const report = {
  ok: failures.length === 0,
  url: buildUrl({ scene: "battle", view: "iso", debug: "1" }),
  checks,
  failures: failures.map((c) => c.message),
  shapes: {
    flatTopRowWidth: flatTopWidth,
    isoTopRowWidth: isoTopWidth,
    flatRedY: flatRed?.cy ?? null,
    flatBlueY: flatBlue?.cy ?? null,
    isoRedY: isoRed?.cy ?? null,
    isoBlueY: isoBlue?.cy ?? null
  },
  consoleErrors,
  exceptions,
  shot
};
console.log(JSON.stringify(report, null, 2));

socket.close();
process.exit(report.ok ? 0 : 1);
