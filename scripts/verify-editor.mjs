/**
 * End-to-end deployment editor verification in a real browser.
 *
 * `tests/editor.test.mjs` proves the rules — what overlaps, what is out of bounds, what can
 * be fought. It cannot prove that a drag on the canvas reaches those rules. The chain that
 * matters here is entirely outside the unit tests: a pointer event on the canvas, through the
 * fit transform, into a hit test, into React state, back out through a rebuilt world and the
 * renderer. Every link in it can be broken while every head-less test stays green.
 *
 * So this drives the real build with real mouse input and reads the real DOM.
 *
 * Usage: node scripts/verify-editor.mjs <pageUrl> [--port=9334] [--shot=out.png]
 */
import { setTimeout as delay } from "node:timers/promises";
import { statSync } from "node:fs";
import { writeFile } from "node:fs/promises";

const args = process.argv.slice(2);
const pageUrl = args.find((a) => !a.startsWith("--"));
if (!pageUrl) {
  console.error("usage: node scripts/verify-editor.mjs <pageUrl> [--port=9334] [--shot=out.png]");
  process.exit(2);
}

const readFlag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const port = Number(readFlag("port", "9334"));
const shotPath = readFlag("shot", "");

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

await send("Runtime.enable");
await send("Page.enable");
await send("Page.navigate", { url: pageUrl });

// The help overlay auto-opens on a fresh profile and covers the arena.
await delay(1200);
try {
  await evaluate(`localStorage.setItem("project-arena.help.seen.v1", "1"), "ok"`);
} catch {
  // The document may not be ready; the reload below still lands on a fresh state, and the
  // overlay is dismissed by the app's own button if it appears.
}
await send("Page.reload");

let state = "pending";
const deadline = Date.now() + 25_000;
while (Date.now() < deadline) {
  state = await evaluate(`(() => {
    if (!document.querySelector("canvas")) return "no-canvas";
    if (!window.__arenaBench) return "no-bench-hook";
    if (!document.querySelector(".editor__chips")) return "no-editor";
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

// The overlay is a real modal over the arena, and `Input.dispatchMouseEvent` goes through the
// real hit-testing — so a drag aimed at a unit would land on the help card instead. Dismiss it
// the way a user would.
await evaluate(`document.querySelector(".help__footer button")?.click(), "dismissed"`);
await delay(250);

// --- DOM readers -------------------------------------------------------------

const clickButton = (label) =>
  evaluate(
    `[...document.querySelectorAll(".panel__buttons button, .editor__actions button")]
       .find((b) => b.textContent.trim() === ${JSON.stringify(label)})?.click(), "clicked"`
  );

const clickChip = (name) =>
  evaluate(
    `[...document.querySelectorAll(".editor__chip")]
       .find((b) => b.textContent.includes(${JSON.stringify(name)}))?.click(), "clicked"`
  );

const readEditor = () => evaluate(`(() => {
  const inspector = document.querySelector(".editor__inspector");
  const dd = inspector ? [...inspector.querySelectorAll(".panel__readout dd")].map((n) => n.textContent) : [];
  const start = [...document.querySelectorAll(".panel__buttons button")].find((b) => b.textContent.trim() === "开战");
  const phaseNode = document.querySelector(".panel__phase");
  const dt = [...document.querySelectorAll(".panel__readout dt")];
  const dv = [...document.querySelectorAll(".panel__readout dd")];
  const readout = {};
  dt.forEach((n, i) => { if (!inspector || !inspector.contains(n)) readout[n.textContent] = dv[i]?.textContent ?? ""; });
  return {
    phase: phaseNode?.textContent ?? "",
    summary: document.querySelector(".editor__summary")?.textContent ?? "",
    selected: dd,
    startDisabled: start ? start.disabled : null,
    startTitle: start ? (start.title ?? "") : "",
    issues: [...document.querySelectorAll(".panel__issues li")].map((li) => li.textContent),
    verdict: document.querySelector(".editor__verdict")?.textContent ?? "",
    readout
  };
})()`);

/** World point to viewport pixels, using the same fit the renderer uses. */
const screenOf = (worldX, worldY, boundsWidth, boundsHeight) =>
  evaluate(`(() => {
    const c = document.querySelector("canvas");
    const r = c.getBoundingClientRect();
    const scale = Math.min(r.width / ${boundsWidth}, r.height / ${boundsHeight});
    return { x: r.left + ${worldX} * scale, y: r.top + ${worldY} * scale, scale, rect: { left: r.left, top: r.top, width: r.width, height: r.height } };
  })()`);

async function drag(fromX, fromY, dx, dy) {
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: fromX,
    y: fromY,
    button: "left",
    buttons: 1,
    clickCount: 1
  });
  // Two moves, because a single jump is exactly the case a broken handler still passes:
  // the first move is what a real drag always produces, and it is what a stale closure on
  // the draft fails on.
  await send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: fromX + dx / 2,
    y: fromY + dy / 2,
    button: "left",
    buttons: 1
  });
  await delay(60);
  await send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: fromX + dx,
    y: fromY + dy,
    button: "left",
    buttons: 1
  });
  await delay(60);
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: fromX + dx,
    y: fromY + dy,
    button: "left",
    buttons: 0,
    clickCount: 1
  });
  await delay(180);
}

function parseCoords(text) {
  const match = /^(-?\d+),\s*(-?\d+)$/.exec((text ?? "").trim());
  return match ? { x: Number(match[1]), y: Number(match[2]) } : null;
}

// --- The run -----------------------------------------------------------------

const report = { ok: true, url: pageUrl, steps: [], consoleErrors, exceptions };
const step = (name, detail) => report.steps.push({ name, ...detail });

const initial = await readEditor();
step("initial layout is the scene and is fightable", {
  summary: initial.summary,
  startDisabled: initial.startDisabled
});

// 1. Clear to an empty field.
await clickButton("清空");
await delay(250);
const cleared = await readEditor();
step("cleared field refuses to start", {
  summary: cleared.summary,
  startDisabled: cleared.startDisabled,
  verdict: cleared.verdict.trim()
});

// 2. One side only is still refused, with the side named.
await clickChip("赤刃");
await delay(250);
const oneSide = await readEditor();
const redAt = parseCoords(oneSide.selected[0]);
step("one side is refused and the new unit is selected", {
  summary: oneSide.summary,
  startDisabled: oneSide.startDisabled,
  verdict: oneSide.verdict.trim(),
  coordinates: redAt,
  facing: oneSide.selected[1]
});

// 3. Both sides: fightable.
await clickChip("苍锋");
await delay(250);
const twoSides = await readEditor();
const blueAt = parseCoords(twoSides.selected[0]);
step("both sides makes it fightable", {
  summary: twoSides.summary,
  startDisabled: twoSides.startDisabled,
  verdict: twoSides.verdict.trim(),
  coordinates: blueAt
});

// 4. Turn the selected unit. 15° per press. The blue unit starts facing 180°, so one press
//    lands on 195° — the test asserts the step, not an absolute angle that depends on which
//    side the unit is on.
const facingBefore = twoSides.selected[1];
await evaluate(
  `[...document.querySelectorAll(".editor__inspector button")].find((b) => b.textContent.includes("↻"))?.click(), "clicked"`
);
await delay(200);
const turned = await readEditor();
step("the turn control changes facing", { from: facingBefore, to: turned.selected[1] });

// 5. Drag the selected unit with real mouse input. Leftward and upward, because the unit
//    starts 12 units from the right wall and a rightward drag would clamp — which is correct
//    behaviour, but it makes the test measure the clamp instead of the drag.
const before = parseCoords(turned.selected[0]);
const from = await screenOf(before.x, before.y, 960, 600);
await drag(from.x, from.y, -140, -60);
const afterDrag = await readEditor();
const after = parseCoords(afterDrag.selected[0]);
step("dragging moves the unit in world units", {
  scale: Number(from.scale.toFixed(4)),
  from: before,
  to: after,
  expectedDelta: {
    x: Number((-140 / from.scale).toFixed(0)),
    y: Number((-60 / from.scale).toFixed(0))
  },
  actualDelta: after && before ? { x: after.x - before.x, y: after.y - before.y } : null,
  stillSelected: afterDrag.selected.length > 0
});

// 6. Drag it onto the red unit: the layout must be refused, with a reason.
const redScreen = await screenOf(redAt.x, redAt.y, 960, 600);
const blueNow = parseCoords(afterDrag.selected[0]);
const blueScreen = await screenOf(blueNow.x, blueNow.y, 960, 600);
await drag(blueScreen.x, blueScreen.y, redScreen.x - blueScreen.x, redScreen.y - blueScreen.y);
const overlapped = await readEditor();
step("stacking two units is refused", {
  summary: overlapped.summary,
  startDisabled: overlapped.startDisabled,
  issues: overlapped.issues,
  verdict: overlapped.verdict.trim()
});

// 7. Undo the overlap by dragging away again.
const stuck = parseCoords(overlapped.selected[0]);
const stuckScreen = await screenOf(stuck.x, stuck.y, 960, 600);
await drag(stuckScreen.x, stuckScreen.y, 180, 120);
const separated = await readEditor();
step("dragging apart clears the refusal", {
  startDisabled: separated.startDisabled,
  issues: separated.issues,
  verdict: separated.verdict.trim()
});

// 8. Add a mechanism and confirm it counts.
await clickChip("熔岩");
await delay(250);
const withProp = await readEditor();
step("adding a mechanism updates the summary", { summary: withProp.summary });

// 9. Screenshot the editor state before fighting.
let shot = null;
if (shotPath) {
  const captured = await send("Page.captureScreenshot", { format: "png" });
  shot = await writeScreenshot(shotPath, captured.data);
}
report.screenshot = shot;

// 10. Fight the field that was built by hand, then reset it.
await clickButton("开战");
await delay(300);
const started = await readEditor();
let elapsed = 0;
while (elapsed < 40_000) {
  await delay(1000);
  elapsed += 1000;
  const now = await readEditor();
  if (now.phase.includes("已分胜负")) {
    break;
  }
}
const decided = await readEditor();
step("a hand-built field resolves", {
  startedPhase: started.phase,
  finalPhase: decided.phase,
  elapsedSeconds: elapsed / 1000,
  redAlive: decided.readout["红方存活"],
  blueAlive: decided.readout["蓝方存活"]
});

await clickButton("重置");
await delay(600);
const reset = await readEditor();
step("reset restores the hand-built layout", {
  phase: reset.phase,
  summary: reset.summary,
  redAlive: reset.readout["红方存活"],
  blueAlive: reset.readout["蓝方存活"],
  startDisabled: reset.startDisabled
});

// --- Verdict -----------------------------------------------------------------

const expectations = [
  [initial.startDisabled === false, "the default scene must be fightable"],
  [cleared.startDisabled === true, "an empty field must not be fightable"],
  [cleared.verdict.includes("没有放置"), "an empty field must say why"],
  [oneSide.startDisabled === true, "a one-sided field must not be fightable"],
  [oneSide.verdict.includes("红方"), "a one-sided field must name the side"],
  [redAt !== null && blueAt !== null, "adding a unit must select it and report coordinates"],
  [twoSides.startDisabled === false, "two sides must be fightable"],
  [turned.selected[1] === "195°", "the turn control must move facing by 15°"],
  [
    after !== null &&
      before !== null &&
      Math.abs(after.x - before.x - Math.round(-140 / from.scale)) <= 1 &&
      Math.abs(after.y - before.y - Math.round(-60 / from.scale)) <= 1,
    "a drag must move the unit the way it was dragged"
  ],
  [overlapped.startDisabled === true, "stacked units must block the start"],
  [overlapped.issues.some((i) => i.includes("重叠")), "stacked units must be explained"],
  [separated.startDisabled === false, "dragging apart must clear the refusal"],
  [withProp.summary.includes("机关 1"), "adding a mechanism must be counted"],
  [decided.phase.includes("已分胜负"), "a hand-built field must resolve"],
  [reset.phase.includes("待命"), "reset must return to laying out"],
  [reset.summary === withProp.summary, "reset must keep the hand-built layout, not the scene"],
  [consoleErrors.length === 0, "no console errors"],
  [exceptions.length === 0, "no uncaught exceptions"]
];

report.checks = expectations.map(([passed, message]) => ({ passed, message }));
const failed = report.checks.filter((c) => !c.passed);
report.ok = failed.length === 0;
report.failures = failed.map((c) => c.message);

console.log(JSON.stringify(report, null, 2));
socket.close();
process.exit(report.ok ? 0 : 1);
