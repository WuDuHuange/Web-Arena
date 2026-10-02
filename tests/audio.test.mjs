/**
 * Audio cue assertions.
 *
 * Sound itself cannot be asserted head-lessly, and pretending otherwise would be theatre.
 * What can be asserted is the decision layer: given two snapshots, which cues should be
 * produced. That is where the real failure modes live — a phantom cue on the first frame,
 * a missing cue when an entity leaves the world, or one cue per victim when an AoE hits
 * twenty units at once and floods the mixer.
 *
 * Run with: npm run test:audio
 */
import assert from "node:assert/strict";
import test from "node:test";

import { createCueDetector } from "../src/audio/detect.ts";

/** Builds a snapshot from loose entity stubs; the detector only reads a few fields. */
function snap(entities) {
  return { tick: 0, entities };
}

function unit(id, { hp = 100, dead = false } = {}) {
  return { id, health: { current: hp, max: 100, dead } };
}

function prop(id, spent) {
  return { id, health: { current: 1, max: 1, dead: false }, mechanism: { spent } };
}

function shot(id) {
  return {
    id,
    health: { current: 1, max: 1, dead: false },
    projectile: { damage: 5, ticksLeft: 10, sourceId: 1 }
  };
}

function flung(id, vx) {
  return { id, health: { current: 100, max: 100, dead: false }, persistentVelocity: { x: vx, y: 0 } };
}

const cuesOf = (events) => events.map((e) => e.cue);

test("a drop in health produces one hit cue", () => {
  const detector = createCueDetector();
  detector.detect(snap([unit(1)]));

  const events = detector.detect(snap([unit(1, { hp: 70 })]));

  assert.deepEqual(cuesOf(events), ["hit"]);
});

test("the first sighting of an entity is not damage", () => {
  // Without a baseline, every entity looks like it just lost all its health.
  const detector = createCueDetector();
  const events = detector.detect(snap([unit(1, { hp: 12 }), unit(2, { hp: 3 })]));

  assert.deepEqual(events, []);
});

test("a death produces a kill cue alongside the hit that caused it", () => {
  const detector = createCueDetector();
  detector.detect(snap([unit(1)]));

  const events = detector.detect(snap([unit(1, { hp: 0, dead: true })]));

  assert.deepEqual(cuesOf(events), ["hit", "kill"]);
});

test("a mechanism turning spent produces exactly one blast cue", () => {
  const detector = createCueDetector();
  detector.detect(snap([prop(7, false)]));

  const first = detector.detect(snap([prop(7, true)]));
  assert.deepEqual(cuesOf(first), ["blast"]);

  // It stays spent forever, and a spent barrel is not a second explosion.
  const second = detector.detect(snap([prop(7, true)]));
  assert.deepEqual(second, []);
});

test("a newly fired projectile produces one shot cue", () => {
  const detector = createCueDetector();
  detector.detect(snap([]));

  const events = detector.detect(snap([shot(9)]));
  assert.deepEqual(cuesOf(events), ["shot"]);

  // The same shot on the next frame is not a new shot.
  const again = detector.detect(snap([shot(9)]));
  assert.deepEqual(again, []);
});

test("a sudden burst of velocity reads as a spring launch", () => {
  const detector = createCueDetector();
  detector.detect(snap([flung(3, 0)]));

  const events = detector.detect(snap([flung(3, 400)]));
  assert.deepEqual(cuesOf(events), ["spring"]);
});

test("gradual acceleration is not mistaken for a launch", () => {
  // A unit walking under its own power must not sound like it hit a spring.
  const detector = createCueDetector();
  detector.detect(snap([flung(3, 100)]));

  const events = detector.detect(snap([flung(3, 160)]));
  assert.deepEqual(events, []);
});

test("a wide hit produces one cue, not one per victim", () => {
  // Twenty simultaneous hits would otherwise queue twenty voices and clip the mixer.
  const detector = createCueDetector();
  detector.detect(snap([unit(1), unit(2), unit(3), unit(4)]));

  const events = detector.detect(
    snap([unit(1, { hp: 50 }), unit(2, { hp: 50 }), unit(3, { hp: 50 }), unit(4, { hp: 50 })])
  );

  assert.equal(events.filter((e) => e.cue === "hit").length, 1);
});

test("heavier damage produces a louder hit", () => {
  const soft = createCueDetector();
  soft.detect(snap([unit(1)]));
  const quiet = soft.detect(snap([unit(1, { hp: 92 })]))[0].intensity;

  const hard = createCueDetector();
  hard.detect(snap([unit(1)]));
  const loud = hard.detect(snap([unit(1, { hp: 8 })]))[0].intensity;

  assert.ok(loud > quiet, `expected ${loud} > ${quiet}`);
  assert.ok(loud <= 1 && quiet >= 0, "intensity must stay within 0..1");
});

test("reset discards baselines so a reused id cannot fake damage", () => {
  const detector = createCueDetector();
  detector.detect(snap([unit(1, { hp: 100 })]));

  detector.reset();
  // Same id, much lower health — but this is a brand new battle, not a wound.
  const events = detector.detect(snap([unit(1, { hp: 10 })]));

  assert.deepEqual(events, []);
});

test("an entity that leaves the world is forgotten", () => {
  // Without cleanup the health map grows for the whole session, and worse: an id that is
  // reused after a reset would compare against a stale value and report phantom damage.
  const detector = createCueDetector();
  detector.detect(snap([unit(1)]));
  detector.detect(snap([]));

  const events = detector.detect(snap([unit(1, { hp: 20 })]));
  assert.deepEqual(events, []);
});

test("an entity that revives can die again and still be reported", () => {
  const detector = createCueDetector();
  detector.detect(snap([unit(1, { hp: 0, dead: true })]));
  detector.detect(snap([unit(1)]));

  // The dead-set must not latch: a reset that reuses the id has to be able to report a
  // second death, otherwise the last kill of a battle goes silent.
  const events = detector.detect(snap([unit(1, { hp: 0, dead: true })]));
  assert.deepEqual(cuesOf(events), ["hit", "kill"]);
});
