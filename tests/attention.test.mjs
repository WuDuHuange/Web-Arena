/**
 * Attention policy assertions.
 *
 * The listener half of `attention.ts` cannot be asserted here — there is no document, and
 * stubbing one would only test the stub. What can be asserted is the decision layer, and that
 * is where a wrong answer is invisible: a battle that resumes when the operator asked it to
 * stay paused looks exactly like a battle that never paused, and one that stays frozen after
 * a tab switch looks exactly like a hung renderer.
 *
 * Run with: npm run test:attention
 */
import assert from "node:assert/strict";
import test from "node:test";

import { onVisibility } from "../src/app/attention.ts";

/** A running battle nobody has paused. */
const running = { phase: "running", autoPaused: false };

test("a hidden page pauses a running battle, and says the pause was its own", () => {
  const next = onVisibility(running, false);
  assert.equal(next.phase, "paused");
  // The mark is the whole mechanism: without it a return cannot tell this pause from one the
  // operator asked for, and it would clear a deliberate pause instead.
  assert.equal(next.autoPaused, true);
});

test("looking again resumes a pause the page imposed", () => {
  const hidden = onVisibility(running, false);
  const back = onVisibility(hidden, true);
  assert.equal(back.phase, "running");
  assert.equal(back.autoPaused, false, "the mark must not survive the resume it caused");
});

test("a pause the operator asked for survives a tab switch", () => {
  // Hiding while already paused must not adopt the pause: the operator's intent is not the
  // page's to undo, and this is the case where getting it wrong destroys a deliberate action.
  const userPaused = { phase: "paused", autoPaused: false };
  const hidden = onVisibility(userPaused, false);
  assert.equal(hidden.phase, "paused");
  assert.equal(hidden.autoPaused, false);

  const back = onVisibility(hidden, true);
  assert.equal(back.phase, "paused", "returning must not resume a pause the user set");
});

test("laying out a field is not something to pause", () => {
  // 待命 has no clock to stop, and marking it paused would put the shell in a phase that no
  // button can leave: 继续 is disabled outside 暂停.
  const editing = { phase: "editing", autoPaused: false };
  assert.equal(onVisibility(editing, false), editing);
  assert.equal(onVisibility(editing, true), editing);
});

test("a decided battle is not resurrected by looking away and back", () => {
  // 已分胜负 is frozen on the result. If a return could move it back to 运行, the last survivor
  // would start walking again — and the result would be a state the operator cannot get out
  // of without a 重置.
  const decided = { phase: "decided", autoPaused: false };
  assert.equal(onVisibility(decided, false), decided);
  assert.equal(onVisibility(decided, true), decided);
});

test("a resume with no automatic pause behind it is a no-op", () => {
  // The shell may already be running when the event arrives — a visible transition fires on
  // load in some browsers. Resuming something that was never paused must not be a state change.
  assert.equal(onVisibility(running, true), running);
});

test("the no-op cases return the same object, so the caller can skip a render", () => {
  // `App.tsx` compares the two fields to decide whether to call `setPhase`. That comparison is
  // only cheap because these branches hand back the argument; if one started returning a fresh
  // object the effect would still be correct, but the reason for the comparison would be gone.
  for (const state of [
    { phase: "editing", autoPaused: false },
    { phase: "decided", autoPaused: false },
    { phase: "running", autoPaused: false }
  ]) {
    assert.equal(onVisibility(state, true), state, `${state.phase} / visible`);
  }
  const userPaused = { phase: "paused", autoPaused: false };
  assert.equal(onVisibility(userPaused, false), userPaused, "paused / hidden");
  assert.equal(onVisibility(userPaused, true), userPaused, "paused / visible");
});

test("hiding twice does not stack a second pause", () => {
  // Some browsers fire the event more than once for a single transition. The second one must
  // find the battle already paused by the page and leave it alone.
  const once = onVisibility(running, false);
  const twice = onVisibility(once, false);
  assert.equal(twice, once);
});
