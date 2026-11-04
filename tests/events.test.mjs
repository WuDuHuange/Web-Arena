/**
 * Battle event channel.
 *
 * `simulation/events.ts` exists because the step already computes attribution and then
 * throws it away. These tests pin down the three properties that make the channel safe to
 * leave switched on:
 *
 *   1. it reports real damage from real fights, with usable attribution;
 *   2. a death always has a matching hit in the same tick, so a log can be read backwards;
 *   3. observing cannot change the outcome — the run with a sink and the run without one
 *      must end in byte-identical worlds.
 *
 * The third one is the important one. Everything else is reporting; that one is the
 * reason the channel is allowed to exist inside the simulation at all.
 *
 * Run with: npm run test:single -- tests/events.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

import { Simulation } from "../src/simulation/simulation.ts";
import { defaultMatchup, mechanismMatchup } from "../src/content/deployment.ts";

const FIXED_STEP_MS = 1000 / 60;
const MAX_TICKS = 6000;

/** Runs a battle to its decision, collecting everything the core reports. */
function observe(setup) {
  const events = [];
  const sim = new Simulation(setup, { onEvent: (event) => events.push(event) });
  let ticks = 0;
  while (ticks < MAX_TICKS && !sim.decided) {
    sim.step();
    ticks += 1;
  }
  return { sim, events, ticks };
}

test("an observed battle reports damage, and every event is well-formed", () => {
  const { events } = observe(defaultMatchup(FIXED_STEP_MS));

  assert.ok(events.length > 0, "a fight that lands hits must report events");

  for (const event of events) {
    assert.ok(
      event.kind === "damage" || event.kind === "death",
      `unexpected event kind: ${event.kind}`
    );
    assert.ok(Number.isInteger(event.tick) && event.tick >= 0, "tick must be a tick number");
    assert.ok(Number.isInteger(event.targetId), "targetId must be an entity id");
    assert.ok(Number.isInteger(event.sourceId), "sourceId must be an entity id");
    assert.equal(
      typeof event.cause,
      "string",
      "cause must name the ability or trigger that did it"
    );
    assert.ok(event.cause.length > 0, "cause must not be empty");
    if (event.kind === "damage") {
      assert.ok(event.amount > 0, `damage must be positive, got ${event.amount}`);
    }
  }
});

test("ticks never go backwards, so a log can be sorted by arrival", () => {
  const { events } = observe(defaultMatchup(FIXED_STEP_MS));

  let last = -1;
  for (const event of events) {
    assert.ok(
      event.tick >= last,
      `event tick went backwards: ${last} -> ${event.tick}`
    );
    last = event.tick;
  }
});

test("every death is attributed to a hit in the same tick", () => {
  const { events } = observe(defaultMatchup(FIXED_STEP_MS));
  const deaths = events.filter((event) => event.kind === "death");

  assert.ok(deaths.length > 0, "a decisive battle must produce deaths");

  for (const death of deaths) {
    const hit = events.find(
      (event) =>
        event.kind === "damage" &&
        event.tick === death.tick &&
        event.targetId === death.targetId &&
        event.sourceId === death.sourceId &&
        event.cause === death.cause
    );
    assert.ok(
      hit,
      `death of ${death.targetId} at tick ${death.tick} has no matching damage event`
    );
  }
});

test("mechanism damage names the prop trigger, not an ability", () => {
  const { events } = observe(mechanismMatchup(FIXED_STEP_MS));
  const triggers = new Set(["aura", "conveyor", "spring", "explosive", "spike", "turret"]);

  const fromMechanism = events.filter(
    (event) => event.kind === "damage" && triggers.has(event.cause)
  );

  assert.ok(
    fromMechanism.length > 0,
    "the Phase 3 scene must produce mechanism damage, or this test proves nothing"
  );
  for (const event of fromMechanism) {
    assert.ok(
      event.sourceId !== event.targetId,
      "a mechanism must not report damaging itself"
    );
  }
});

test("watching a battle cannot change its outcome", () => {
  // Same seed, same setup, one run with a sink attached and one without. If the event
  // channel touched any simulation state -- or if the object churn perturbed anything
  // order-dependent -- the two worlds would drift apart.
  const quiet = new Simulation(defaultMatchup(FIXED_STEP_MS));
  const watched = new Simulation(defaultMatchup(FIXED_STEP_MS), {
    onEvent: () => {
      // Deliberately does nothing: the point is that merely being called is inert.
    }
  });

  for (let i = 0; i < MAX_TICKS; i += 1) {
    const quietDone = quiet.decided;
    const watchedDone = watched.decided;
    assert.equal(watchedDone, quietDone, `decision state diverged at tick ${i}`);
    if (quietDone) {
      break;
    }
    quiet.step();
    watched.step();
  }

  assert.equal(
    JSON.stringify(watched.snapshot()),
    JSON.stringify(quiet.snapshot()),
    "an observed run must end in the same world as an unobserved one"
  );
});
