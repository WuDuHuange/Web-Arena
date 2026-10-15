/**
 * Appearance layer tests.
 *
 * The layer exists because `render.appearance` was a dead field: authored in `library.ts`,
 * carried through the spawn, listed in the credits panel, exported in a deployment file —
 * and never read by the renderer. Nothing failed. The key was simply decorative.
 *
 * What that means for testing is that the interesting assertions are not about drawing. They
 * are about *telling three states apart*:
 *
 *   1. no art authored            → procedural grey box, and that is the correct rendering
 *   2. art authored, still loading → visibly not a grey box
 *   3. art authored, load failed   → visibly not a grey box, and visibly not #2 either
 *
 * Collapsing 2 and 3 into 1 is the silent degradation the architecture's Phase 3 gate
 * forbids, so the tests below pin the three apart one at a time. The pixel half — that the
 * screen actually differs — is `scripts/verify-appearance.mjs`, because it needs a canvas.
 *
 * Run with: npm run test:appearance
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  APPEARANCE_REGISTRY,
  PHASE_STEP_MS,
  PLACEHOLDER_COLOR,
  anchorOf,
  artHeight,
  findAppearanceProblems,
  frameAt,
  mirrorsFacing,
  overrideAppearance,
  phaseOffsetMs,
  planAppearance,
  registrySources
} from "../src/content/appearance.ts";
import { CONTENT_LIBRARY } from "../src/content/library.ts";
import { validateContent } from "../src/content/validate.ts";
import { factionColor } from "../src/render/palette.ts";
import { PROP_PALETTE } from "../src/render/props.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

/** A lookup that answers one state for every source. */
const always = (state, reason) => () => (reason ? { state, reason } : { state });

const SEQUENCE = {
  kind: "sequence",
  source: "test/strip.png",
  frameWidth: 16,
  frameHeight: 16,
  frameCount: 6,
  frameMs: 90,
  loop: true
};

// --- frameAt ----------------------------------------------------------------

test("a looping sequence advances one frame per frameMs and wraps", () => {
  assert.equal(frameAt(SEQUENCE, 0), 0);
  assert.equal(frameAt(SEQUENCE, 89), 0, "the last millisecond of a frame is still that frame");
  assert.equal(frameAt(SEQUENCE, 90), 1);
  assert.equal(frameAt(SEQUENCE, 449), 4);
  assert.equal(frameAt(SEQUENCE, 540), 0, "six frames at 90 ms is one full loop");
  assert.equal(frameAt(SEQUENCE, 541), 0);
});

test("a one-shot sequence holds its last frame instead of wrapping", () => {
  const oneShot = { ...SEQUENCE, loop: false };
  assert.equal(frameAt(oneShot, 90), 1);
  assert.equal(frameAt(oneShot, 540), 5);
  assert.equal(frameAt(oneShot, 100_000), 5, "a one-shot must not wrap round to frame 0");
});

test("a single-frame spec is always frame 0", () => {
  assert.equal(frameAt({ kind: "single", source: "test/one.png" }, 12_345), 0);
});

test("frameAt refuses to produce an index from a degenerate spec", () => {
  // Every one of these slices a zero-width or out-of-range texture rectangle. The sprite is
  // then blank or garbled and nothing at all is logged, which is the worst failure mode
  // available: a unit that is simply not there.
  assert.equal(frameAt({ ...SEQUENCE, frameCount: 0 }, 1000), 0);
  assert.equal(frameAt({ ...SEQUENCE, frameCount: -3 }, 1000), 0);
  assert.equal(frameAt({ ...SEQUENCE, frameMs: 0 }, 1000), 0);
  assert.equal(frameAt({ ...SEQUENCE, frameMs: -90 }, 1000), 0);
  assert.equal(frameAt(SEQUENCE, Number.NaN), 0, "NaN % n is NaN, and NaN is not an index");
  assert.equal(frameAt(SEQUENCE, -500), 0, "negative time is clamped, not wrapped backwards");
  assert.equal(frameAt({ ...SEQUENCE, frameCount: 1 }, 900), 0);
});

// --- phaseOffsetMs ----------------------------------------------------------

test("units are staggered on the animation clock by id, not by a random draw", () => {
  assert.equal(phaseOffsetMs(0), 0, "the first entity is the reference phase");
  assert.equal(phaseOffsetMs(3), 3 * PHASE_STEP_MS);
  assert.equal(phaseOffsetMs(-2), 2 * PHASE_STEP_MS, "a negative id is still an offset");
  assert.equal(phaseOffsetMs(1.7), PHASE_STEP_MS, "a fractional id truncates rather than fracturing");

  const offsets = new Set([0, 1, 2, 3, 4, 5].map(phaseOffsetMs));
  assert.equal(offsets.size, 6, "six units must not share one phase, or they march in lockstep");
});

// --- planAppearance: the three states ---------------------------------------

test("a key with no art is procedural, and that is not a fallback", () => {
  // The normal case for every entity in this build. Note the lookup: even a lookup that
  // claims to know the key must not turn an unregistered key into art — the registry is the
  // only thing that can author art, and the atlas is only asked about sources it named.
  const plan = planAppearance("red-blade", false, 1000, always("ready"));
  assert.equal(plan.kind, "procedural");
  assert.equal(plan.key, "red-blade");
});

test("a ready key resolves to its spec and its frame", () => {
  overrideAppearance("test.states", { base: SEQUENCE });
  try {
    const plan = planAppearance("test.states", false, 200, always("ready"));
    assert.equal(plan.kind, "art");
    assert.equal(plan.spec.source, "test/strip.png");
    assert.equal(plan.frame, 2, "200 ms at 90 ms per frame is frame 2");
  } finally {
    overrideAppearance("test.states", null);
  }
});

test("a pending key is a placeholder that says it is loading", () => {
  overrideAppearance("test.states", { base: SEQUENCE });
  try {
    const plan = planAppearance("test.states", false, 0, always("pending"));
    assert.equal(plan.kind, "placeholder");
    assert.equal(plan.reason, "外观加载中");
    // The source travels with the plan so the renderer can ask for the load to start. Without
    // it, a key the atlas has not seen stays at "加载中" for the rest of the session.
    assert.equal(plan.source, "test/strip.png");
  } finally {
    overrideAppearance("test.states", null);
  }
});

test("a failed key is a placeholder carrying the reason, not a grey box", () => {
  overrideAppearance("test.states", { base: SEQUENCE });
  try {
    const plan = planAppearance("test.states", false, 0, always("failed", "404 test/strip.png"));
    assert.equal(plan.kind, "placeholder");
    assert.equal(plan.reason, "404 test/strip.png");
    assert.equal(plan.source, "test/strip.png");
    assert.notEqual(plan.kind, "procedural", "a broken file must never render as 'no art'");
  } finally {
    overrideAppearance("test.states", null);
  }
});

test("a failure with no reason still says something a human can read", () => {
  overrideAppearance("test.states", { base: SEQUENCE });
  try {
    const plan = planAppearance("test.states", false, 0, always("failed"));
    assert.equal(plan.kind, "placeholder");
    assert.ok(plan.reason.length > 0, "an empty reason renders as an empty panel row");
  } finally {
    overrideAppearance("test.states", null);
  }
});

test("winding up swaps to the attack spec, and only when there is one", () => {
  overrideAppearance("test.states", {
    base: SEQUENCE,
    attack: { kind: "single", source: "test/attack.png" }
  });
  try {
    const idle = planAppearance("test.states", false, 0, always("ready"));
    const casting = planAppearance("test.states", true, 0, always("ready"));
    assert.equal(idle.spec.source, "test/strip.png");
    assert.equal(casting.spec.source, "test/attack.png");
  } finally {
    overrideAppearance("test.states", null);
  }

  // A key with one image must keep drawing that image while winding up rather than resolving
  // to nothing.
  overrideAppearance("test.states", { base: SEQUENCE });
  try {
    const casting = planAppearance("test.states", true, 0, always("ready"));
    assert.equal(casting.kind, "art");
    assert.equal(casting.spec.source, "test/strip.png");
  } finally {
    overrideAppearance("test.states", null);
  }
});

test("the base and attack slots are asked about separately", () => {
  // A broken attack sheet must not stop the idle frame from drawing — the unit keeps its
  // sprite and only the telegraph is lost, which is a degradation rather than a disappearance.
  overrideAppearance("test.states", {
    base: SEQUENCE,
    attack: { kind: "single", source: "test/missing.png" }
  });
  try {
    const lookup = (source) => (source === "test/missing.png" ? { state: "failed", reason: "404" } : { state: "ready" });
    assert.equal(planAppearance("test.states", false, 0, lookup).kind, "art");
    assert.equal(planAppearance("test.states", true, 0, lookup).kind, "placeholder");
  } finally {
    overrideAppearance("test.states", null);
  }
});

// --- Placement --------------------------------------------------------------

test("an anchor defaults to the centre and is copied rather than shared", () => {
  const bare = { kind: "single", source: "test/one.png" };
  assert.deepEqual(anchorOf(bare), { x: 0.5, y: 0.5 });

  const pinned = { kind: "single", source: "test/one.png", anchor: { x: 0.5, y: 1 } };
  assert.deepEqual(anchorOf(pinned), { x: 0.5, y: 1 });

  // A PixiJS anchor is a live point, so two calls must not hand back the same object: one
  // unit writing to it would move every other unit that never named an anchor at all.
  assert.notEqual(anchorOf(bare), anchorOf(bare), "the default anchor must be copied, not shared");
});

test("a spec without a height draws at its own size", () => {
  // Scale 1 is what every spec did before this field existed, so its absence has to keep
  // producing it — otherwise adding the field silently resizes the whole greybox era.
  assert.equal(artHeight({ kind: "single", source: "x.png" }, 128), 128);
  assert.equal(artHeight({ kind: "single", source: "x.png", height: 48 }, 128), 48);
});

test("a degenerate height is ignored rather than honoured", () => {
  // Honouring any of these scales the sprite away to nothing, and a unit that vanishes with
  // nothing logged is the exact failure this module exists to make impossible.
  for (const height of [0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(
      artHeight({ kind: "single", source: "x.png", height }, 128),
      128,
      `height ${height} must fall back to the natural size`
    );
  }
});

test("only the mirror facing asks for a flip", () => {
  assert.equal(mirrorsFacing({ kind: "single", source: "x.png" }), false);
  assert.equal(mirrorsFacing({ kind: "single", source: "x.png", facing: "none" }), false);
  assert.equal(mirrorsFacing({ kind: "single", source: "x.png", facing: "mirror" }), true);
});

test("registry problems reach the placement fields too", () => {
  const problems = findAppearanceProblems({
    bad: {
      base: {
        kind: "single",
        source: "x.png",
        anchor: { x: 1.5, y: -0.2 },
        height: 0,
        facing: "sideways"
      }
    }
  });

  assert.equal(problems.length, 3, `expected three problems, got ${JSON.stringify(problems)}`);
  assert.ok(problems.some((p) => p.includes("anchor")));
  assert.ok(problems.some((p) => p.includes("height")));
  assert.ok(problems.some((p) => p.includes("facing")));
});

// --- Registry integrity -----------------------------------------------------

test("the shipped appearance registry is clean", () => {
  assert.deepEqual(findAppearanceProblems(), []);
});

test("the shipped registry pins every portrait by its feet", () => {
  // The pack's opaque bounding boxes all end on the last row of the frame, so `y: 1` is where
  // the boots are. Anchored at the centre instead, a 128-pixel figure floats half its own
  // height above the floor — and no amount of depth sorting fixes that.
  for (const [key, entry] of Object.entries(APPEARANCE_REGISTRY)) {
    for (const spec of [entry.base, entry.attack]) {
      if (!spec) {
        continue;
      }
      assert.equal(spec.anchor?.y, 1, `${key} must be pinned by its feet`);
      assert.ok(spec.height > 0, `${key} must state a world-unit height`);
    }
  }
});

test("the shipped registry names asset slots rather than literal paths", () => {
  // A spec holding a path would break the moment Vite hashed the file, and it would break at
  // 404 time rather than at build time. `asset:` is the scheme that survives the hashing; the
  // lookup that turns a slot into a URL belongs to `assets/index.ts`, not to content.
  for (const [key, entry] of Object.entries(APPEARANCE_REGISTRY)) {
    for (const spec of [entry.base, entry.attack]) {
      if (!spec) {
        continue;
      }
      assert.match(spec.source, /^asset:/, `${key} must name an asset slot`);
    }
  }
});

test("registry problems name the key, the slot and the field", () => {
  const problems = findAppearanceProblems({
    broken: {
      base: { kind: "sequence", source: "  ", frameWidth: 0, frameHeight: 32, frameCount: 0, frameMs: 0, loop: true }
    }
  });

  assert.equal(problems.length, 4, `expected four problems, got ${JSON.stringify(problems)}`);
  assert.ok(problems.some((p) => p.startsWith("broken.base") && p.includes("source")));
  assert.ok(problems.some((p) => p.includes("frameCount")));
  assert.ok(problems.some((p) => p.includes("帧尺寸")));
  assert.ok(problems.some((p) => p.includes("frameMs")));
});

test("registry problems reach the content validator", () => {
  // The registry is content, and its failure mode is the one the validator exists to catch:
  // silent. A zero frame count draws nothing at all and logs nothing.
  const broken = {
    "test.broken": { base: { ...SEQUENCE, frameCount: 0 } }
  };
  const result = validateContent(CONTENT_LIBRARY, broken);
  assert.equal(result.ok, false);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].path, "appearance");
  assert.match(result.issues[0].message, /frameCount/);

  // And the shipped pair passes, which is the assertion that would otherwise rot unnoticed.
  assert.equal(validateContent(CONTENT_LIBRARY).ok, true);
});

test("every registered key is referenced by shipped content", () => {
  // This is what stops the demo fixture from becoming dead code. Delete the reference in
  // `library.ts` without deleting the entry, and this fails — rather than the entry quietly
  // staying in the registry as a branch nothing ever executes.
  const used = new Set([
    ...CONTENT_LIBRARY.characters.map((c) => c.appearance),
    ...CONTENT_LIBRARY.props.map((p) => p.appearance)
  ]);

  for (const key of Object.keys(APPEARANCE_REGISTRY)) {
    assert.ok(used.has(key), `appearance key "${key}" is registered but no content uses it`);
  }
});

test("the appearance layer covers units only, for now", () => {
  // A prop's drawing *is* its mechanic readout: the translucent field is the effect radius,
  // the inner disc is the collider, the pulse is the cadence the damage tick reads. Swapping
  // in a bitmap would delete gameplay information rather than change a costume, so prop art
  // has to be composited with the procedural field — a design task, not a lookup. This test
  // fails the moment a prop key gets registered before that work exists, which is the point.
  for (const prop of CONTENT_LIBRARY.props) {
    assert.equal(
      APPEARANCE_REGISTRY[prop.appearance],
      undefined,
      `prop "${prop.id}" must not resolve through the appearance layer yet`
    );
  }

  // Projectiles are emitter output and are named `projectile-<sourceId>` at spawn time. They
  // are procedural for the same reason, and their keys are not stable enough to register.
  const projectileKeys = Object.keys(APPEARANCE_REGISTRY).filter((key) => key.startsWith("projectile-"));
  assert.deepEqual(projectileKeys, []);
});

test("registrySources deduplicates and keeps a stable order", () => {
  const sources = registrySources({
    a: { base: { kind: "single", source: "one.png" }, attack: { kind: "single", source: "two.png" } },
    b: { base: { kind: "single", source: "one.png" } }
  });

  assert.deepEqual(sources, ["one.png", "two.png"], "a shared source must be loaded once");
});

test("the failure marker is a colour nothing else in the arena uses", () => {
  // If it collided with a faction colour or a mechanism glow, "art failed" would read as a
  // unit or a trap. Magenta is chosen because it is the one hue the palette has no use for.
  const taken = new Set([
    factionColor("red"),
    factionColor("blue"),
    factionColor("neutral"),
    ...Object.values(PROP_PALETTE).flatMap((palette) => [palette.base, palette.glow, palette.edge])
  ]);

  assert.ok(!taken.has(PLACEHOLDER_COLOR), `placeholder colour ${PLACEHOLDER_COLOR} is already in the palette`);
});

// --- The boundary that keeps the promise honest ------------------------------

test("the appearance module imports nothing, and the simulation cannot see it", () => {
  // The architecture promises that replacing art changes neither collision nor damage. The
  // behavioural half of that is in `mechanism.test.mjs`; this is the structural half, and it
  // is the stronger of the two: the simulation cannot be influenced by art it cannot import.
  const appearanceSource = readFileSync(join(root, "src", "content", "appearance.ts"), "utf8");
  assert.ok(
    !/^\s*import\s/m.test(appearanceSource),
    "content/appearance.ts must stay import-free so the whole decision table is testable head-lessly"
  );

  const dir = join(root, "src", "simulation");
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".ts"))) {
    const code = readFileSync(join(dir, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    assert.ok(
      !/from\s+["'][^"']*appearance/.test(code),
      `${file} must not import the appearance layer: presentation cannot reach the simulation`
    );
  }
});

test("overrideAppearance can put an entry back exactly as it was", () => {
  // The debug hook depends on this: the smoke test rewrites a live key to prove the failure
  // is visible, and a restore that did not round-trip would leave the page broken afterwards.
  const before = JSON.parse(JSON.stringify(APPEARANCE_REGISTRY));
  overrideAppearance("test.roundtrip", { base: { kind: "single", source: "x.png" } });
  assert.equal(planAppearance("test.roundtrip", false, 0, always("ready")).kind, "art");
  overrideAppearance("test.roundtrip", null);
  assert.equal(planAppearance("test.roundtrip", false, 0, always("ready")).kind, "procedural");
  assert.deepEqual(JSON.parse(JSON.stringify(APPEARANCE_REGISTRY)), before);
});
