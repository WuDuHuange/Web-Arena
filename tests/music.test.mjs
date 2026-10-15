/**
 * Music policy assertions.
 *
 * The element half of `music.ts` cannot be asserted head-lessly — there is no audio device
 * and no DOM here, and faking one would only test the fake. What can be asserted is the
 * decision layer: which phases should be audible, how mute maps onto gain, and that a
 * browser without an audio element degrades instead of throwing. Those are the places a
 * wrong answer is invisible until someone notices the music started at the wrong moment,
 * kept playing after 重置, or took the battle loop down with it.
 *
 * Run with: npm run test:music
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  MUSIC_VOLUME,
  createMusicChannel,
  createSilentChannel,
  musicVolume,
  shouldPlayMusic
} from "../src/audio/music.ts";

test("music runs for the whole fight, not only while it is advancing", () => {
  // 暂停 and 已分胜负 are still the fight. Cutting the track the moment a battle is
  // interrupted would make pausing feel like leaving the arena.
  assert.equal(shouldPlayMusic("running"), true);
  assert.equal(shouldPlayMusic("paused"), true);
  assert.equal(shouldPlayMusic("decided"), true);
});

test("laying out a field is quiet", () => {
  // 待命 is setup, not battle. Music that started here would be running before 开战 was ever
  // pressed, which is the wrong moment by the only definition that matters.
  assert.equal(shouldPlayMusic("editing"), false);
});

test("mute is a gain of zero, not a stop", () => {
  // The distinction is load-bearing: zero keeps the track's position, so unmuting rejoins
  // the loop where it is instead of restarting the fight music from the top.
  assert.equal(musicVolume(true), 0);
  assert.equal(musicVolume(false), MUSIC_VOLUME);
});

test("the loop sits under the effects bus", () => {
  // A continuous loop at the same nominal level as transient cues reads as far louder and
  // buries the hit and blast feedback. `MASTER_GAIN` in synth.ts is 0.5.
  assert.ok(MUSIC_VOLUME > 0, "the loop has to be audible");
  assert.ok(MUSIC_VOLUME < 0.5, `expected below the effects master, got ${MUSIC_VOLUME}`);
});

test("a browser without an audio element degrades to a silent stand-in", () => {
  // Node has no `Audio` global, which is the same shape as an old or locked-down browser.
  // Every call site uses `?.` and never checks the result, so a channel that threw here
  // would take the battle loop down with it on the first frame.
  const channel = createMusicChannel({ url: "missing.mp3" });

  assert.equal(channel.available, false, "availability is answered up front, not on failure");
  assert.equal(channel.playing, false);
  assert.equal(channel.source, "missing.mp3", "the channel still reports what it was asked for");
  assert.doesNotThrow(() => {
    channel.play();
    channel.setMuted(false);
    channel.stop();
    channel.destroy();
  });
});

test("the silent stand-in is safe to drive and never claims to be playing", () => {
  const channel = createSilentChannel(true);

  assert.equal(channel.available, false);
  assert.equal(channel.muted, true);
  assert.equal(channel.playing, false);
  assert.equal(channel.source, "");
  // The probe has to answer with numbers rather than throw, or `?debug=1` turns a silent
  // arena into a broken page — which is the opposite of what a diagnostic is for.
  assert.deepEqual(channel.diagnostics(), { readyState: 0, errorCode: null, volume: 0 });
  assert.doesNotThrow(() => {
    channel.play();
    channel.stop();
    channel.setMuted(false);
    channel.destroy();
  });
  assert.equal(channel.playing, false);
});
