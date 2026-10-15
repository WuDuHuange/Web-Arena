/**
 * Release-boundary input checks.
 *
 * Two things ship with the MVP that take untrusted or hand-maintained data and decide
 * whether it is usable: the deployment importer and the asset credit registry. Both are
 * cheap to get subtly wrong, and both fail in the same unpleasant way — the problem is not
 * reported where it happened.
 *
 * Run with: npm run test:release
 */
import assert from "node:assert/strict";
import test from "node:test";

import { parseDeployment, summariseDeployment } from "../src/persistence/deployment-io.ts";
import {
  ASSET_CREDITS,
  findIncompleteCredits,
  findUnregisteredAppearances
} from "../src/content/credits.ts";
import { APPEARANCE_REGISTRY } from "../src/content/appearance.ts";

const VALID_DEPLOYMENT = {
  seed: 7,
  fixedStepMs: 1000 / 60,
  bounds: { width: 960, height: 600 },
  abilities: [],
  spawns: [
    { kind: "unit", faction: "red", x: 120, y: 300, radius: 12, mass: 1, hp: 200 },
    { kind: "unit", faction: "blue", x: 840, y: 300, radius: 12, mass: 1, hp: 200 }
  ]
};

/** Parses an object as if it had been read from a file. */
function parse(value) {
  return parseDeployment(typeof value === "string" ? value : JSON.stringify(value));
}

function withSpawn(patch) {
  return {
    ...VALID_DEPLOYMENT,
    spawns: [{ ...VALID_DEPLOYMENT.spawns[0], ...patch }, VALID_DEPLOYMENT.spawns[1]]
  };
}

test("a well-formed deployment is accepted", () => {
  const result = parse(VALID_DEPLOYMENT);

  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
  assert.equal(result.setup.spawns.length, 2);
});

test("malformed JSON is rejected without throwing", () => {
  // The importer sits behind a file picker, so garbage input is a normal event.
  const result = parse("{ not json");

  assert.equal(result.ok, false);
  assert.equal(result.setup, null);
  assert.match(result.issues[0], /JSON/);
});

test("a non-object root is rejected", () => {
  assert.equal(parse("[]").ok, false);
  assert.equal(parse("42").ok, false);
  assert.equal(parse("null").ok, false);
});

test("a missing seed is rejected", () => {
  const { seed, ...rest } = VALID_DEPLOYMENT;
  void seed;
  const result = parse(rest);

  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.includes("seed")));
});

test("a non-positive step length is rejected", () => {
  // A zero step would make the clock advance forever without ever ticking.
  assert.equal(parse({ ...VALID_DEPLOYMENT, fixedStepMs: 0 }).ok, false);
  assert.equal(parse({ ...VALID_DEPLOYMENT, fixedStepMs: -16 }).ok, false);
});

test("degenerate bounds are rejected", () => {
  assert.equal(parse({ ...VALID_DEPLOYMENT, bounds: { width: 0, height: 600 } }).ok, false);
  assert.equal(parse({ ...VALID_DEPLOYMENT, bounds: { width: 960, height: -1 } }).ok, false);
  assert.equal(parse({ ...VALID_DEPLOYMENT, bounds: "960x600" }).ok, false);
});

test("an empty field is rejected", () => {
  // Technically parseable, but it produces an arena with nothing in it, which reads as a
  // rendering failure rather than an empty lineup.
  const result = parse({ ...VALID_DEPLOYMENT, spawns: [] });

  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.includes("spawns")));
});

test("missing spawn coordinates are rejected", () => {
  const { x, ...withoutX } = VALID_DEPLOYMENT.spawns[0];
  void x;
  const result = parse({ ...VALID_DEPLOYMENT, spawns: [withoutX] });

  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.includes("spawns[0].x")));
});

test("a non-finite coordinate is rejected", () => {
  // JSON cannot carry NaN or Infinity, but it can carry a value that becomes one after a
  // hand edit, and a single NaN position poisons the whole solver.
  const result = parse(withSpawn({ y: "300" }));

  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.includes("spawns[0].y")));
});

test("an unknown kind or faction is rejected", () => {
  assert.equal(parse(withSpawn({ kind: "dragon" })).ok, false);
  assert.equal(parse(withSpawn({ faction: "green" })).ok, false);
});

test("zero radius or zero mass is rejected", () => {
  // These do not throw in the solver, they just make it misbehave, so nothing downstream
  // would point back at the file.
  assert.equal(parse(withSpawn({ radius: 0 })).ok, false);
  assert.equal(parse(withSpawn({ mass: 0 })).ok, false);
});

test("negative health is rejected", () => {
  assert.equal(parse(withSpawn({ hp: -1 })).ok, false);
  assert.equal(parse(withSpawn({ hp: 0 })).ok, true);
});

test("a missing abilities array is rejected", () => {
  const { abilities, ...rest } = VALID_DEPLOYMENT;
  void abilities;

  assert.equal(parse(rest).ok, false);
});

test("an oversized deployment is rejected before it is parsed entry by entry", () => {
  const spawns = Array.from({ length: 2001 }, (_, i) => ({
    ...VALID_DEPLOYMENT.spawns[0],
    x: i
  }));
  const result = parse({ ...VALID_DEPLOYMENT, spawns });

  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.includes("2001")));
});

test("the issue list is capped so one bad file cannot flood the panel", () => {
  const spawns = Array.from({ length: 50 }, () => ({ kind: "dragon" }));
  const result = parse({ ...VALID_DEPLOYMENT, spawns });

  assert.equal(result.ok, false);
  assert.ok(result.issues.length <= 12, `reported ${result.issues.length} issues`);
});

test("a rejected deployment reports every problem, not just the first", () => {
  // Reporting one issue at a time turns fixing a file into a guessing game.
  const result = parse({ seed: "x", fixedStepMs: 0, bounds: {}, spawns: "nope", abilities: 5 });

  assert.equal(result.ok, false);
  assert.ok(result.issues.length >= 4, `only reported ${result.issues.length}`);
});

test("summarising counts units and props separately", () => {
  const result = parse({
    ...VALID_DEPLOYMENT,
    spawns: [
      ...VALID_DEPLOYMENT.spawns,
      { kind: "prop", faction: "neutral", x: 480, y: 300, radius: 10, mass: 3, hp: 1 }
    ]
  });

  assert.equal(result.ok, true);
  const summary = summariseDeployment(result.setup);
  assert.equal(summary.units, 2);
  assert.equal(summary.props, 1);
  assert.equal(summary.bounds, "960×600");
});

test("an empty credit registry is complete, not incomplete", () => {
  // Nothing to declare is a correct state, not a missing one.
  assert.deepEqual(findIncompleteCredits([]), []);
});

test("a half-filled credit is reported field by field", () => {
  // A partial credit looks like diligence while leaving the licence question unanswered.
  const problems = findIncompleteCredits([
    {
      kind: "appearance",
      slot: "red-blade",
      title: "Blade",
      author: "",
      source: "",
      licence: "",
      obtained: ""
    }
  ]);

  assert.ok(problems.some((p) => p.includes("author")));
  assert.ok(problems.some((p) => p.includes("licence")));
  assert.ok(problems.some((p) => p.includes("obtained")));
  assert.ok(!problems.some((p) => p.includes("title")), "a filled field must not be reported");
});

test("a whitespace-only credit field counts as missing", () => {
  const problems = findIncompleteCredits([
    {
      kind: "material",
      slot: "ground.sand",
      title: "  ",
      author: "a",
      source: "s",
      licence: "l",
      obtained: "2026-01-01"
    }
  ]);

  assert.ok(problems.some((p) => p.includes("title")));
});

test("appearance keys without a credit are reported once the asset phase starts", () => {
  const appearances = ["red-blade", "prop-lava", "blue-skirmisher"];
  const registered = [
    {
      kind: "appearance",
      slot: "prop-lava",
      title: "t",
      author: "a",
      source: "s",
      licence: "l",
      obtained: "2026-01-01"
    }
  ];

  assert.deepEqual(findUnregisteredAppearances(appearances, registered), [
    "red-blade",
    "blue-skirmisher"
  ]);
});

test("a material credit cannot stand in for an appearance key", () => {
  // The two kinds are not interchangeable. A floor texture carries no appearance key, so
  // letting it satisfy this check would mark a sprite as licensed when it never was.
  const registered = [
    {
      kind: "material",
      slot: "ground.earth",
      title: "Ground051",
      author: "ambientCG",
      source: "s",
      licence: "CC0",
      obtained: "2026-10-13"
    }
  ];

  assert.deepEqual(findUnregisteredAppearances(["ground.earth"], registered), ["ground.earth"]);
});

test("the shipped credit registry is complete", () => {
  // Guards the real data, not a fixture: the floor material is in the build, so its row has
  // to be filled in rather than left as a template.
  assert.deepEqual(findIncompleteCredits(ASSET_CREDITS), []);
  assert.ok(ASSET_CREDITS.length > 0, "the asset phase has started, so a row must exist");
});

test("the battle loop is registered with its attribution obligation intact", () => {
  // The music is CC BY, not CC0: the licence requires attribution, and both the HUD corner
  // line and the credits panel render from this row. Losing it would be a licence breach
  // that nothing else would notice, because the app keeps working perfectly without it.
  const music = ASSET_CREDITS.find((credit) => credit.slot === "music.battle");

  assert.ok(music, "the build ships a BGM track, so a row must exist for it");
  assert.equal(music.kind, "material");
  assert.match(music.licence, /CC BY 4\.0/);
  assert.match(music.author, /魔王魂/);
  assert.match(music.source, /^https:\/\/maou\.audio\//);
});

test("every shipped appearance key has an appearance-kind credit", () => {
  // The kind is the part that decides coverage: `findUnregisteredAppearances` only counts
  // appearance rows, so a sprite registered as `material` would look credited in the panel
  // and still be reported as unlicensed by the one check that matters.
  for (const key of Object.keys(APPEARANCE_REGISTRY)) {
    const credit = ASSET_CREDITS.find((row) => row.slot === key);
    assert.ok(credit, `appearance key "${key}" ships art, so it must have a credit row`);
    assert.equal(credit.kind, "appearance", `"${key}" must be credited as an appearance`);
    assert.match(credit.licence, /CC0/, `"${key}" comes from a CC0 pack`);
    assert.match(credit.source, /^https:\/\/kenney\.nl\//);
  }

  assert.deepEqual(
    findUnregisteredAppearances(Object.keys(APPEARANCE_REGISTRY), ASSET_CREDITS),
    [],
    "every shipped appearance key must be covered by a credit"
  );
});
