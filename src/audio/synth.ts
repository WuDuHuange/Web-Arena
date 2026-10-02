/**
 * Procedural sound effects.
 *
 * Every cue is synthesised from oscillators and one noise buffer, so the audio layer
 * ships zero asset bytes and carries zero licensing questions. That matters more than it
 * sounds: a battle sandbox that will later accept community art cannot afford to be
 * ambiguous about where its audio came from.
 *
 * Degradation is silent and total. If `AudioContext` is missing, if the browser blocks
 * autoplay, or if anything throws, the engine reports `available: false` and every `play`
 * becomes a no-op. A mute arena is acceptable; a crash on the first sword swing is not.
 */

export type Cue = "hit" | "kill" | "blast" | "shot" | "spring";

interface CueSpec {
  readonly wave: OscillatorType | "noise";
  readonly from: number;
  readonly to: number;
  readonly duration: number;
  readonly gain: number;
  /** Minimum gap between two plays of this cue, in milliseconds. */
  readonly minGapMs: number;
}

const CUES: Record<Cue, CueSpec> = {
  hit: { wave: "triangle", from: 240, to: 150, duration: 0.07, gain: 0.16, minGapMs: 35 },
  kill: { wave: "sawtooth", from: 190, to: 55, duration: 0.26, gain: 0.2, minGapMs: 90 },
  blast: { wave: "noise", from: 1400, to: 110, duration: 0.45, gain: 0.32, minGapMs: 150 },
  shot: { wave: "square", from: 780, to: 420, duration: 0.09, gain: 0.11, minGapMs: 55 },
  spring: { wave: "sine", from: 300, to: 900, duration: 0.16, gain: 0.16, minGapMs: 90 }
};

/** Concurrent voices are capped: a 100-unit brawl can otherwise request dozens per frame. */
const MAX_VOICES = 20;
/** Master level. Cues are mixed to sit under this, not at it. */
const MASTER_GAIN = 0.5;

export interface AudioEngine {
  readonly available: boolean;
  readonly muted: boolean;
  play(cue: Cue, intensity?: number): void;
  /** Called from a user gesture; browsers refuse to start audio any other way. */
  resume(): void;
  setMuted(muted: boolean): void;
  destroy(): void;
}

interface CueState {
  lastPlayedMs: number;
}

/**
 * A silent stand-in, used when audio is unavailable or the engine is muted.
 *
 * Returning this instead of `null` keeps every call site free of null checks, which is
 * the difference between "audio is optional" being true in the architecture and being
 * true in the code.
 */
function createSilentEngine(muted: boolean): AudioEngine {
  return {
    available: false,
    muted,
    play(): void {},
    resume(): void {},
    setMuted(): void {},
    destroy(): void {}
  };
}

export function createAudioEngine(options: { muted?: boolean } = {}): AudioEngine {
  let muted = options.muted ?? false;
  let context: AudioContext | null = null;
  let master: GainNode | null = null;
  let noise: AudioBuffer | null = null;
  let voices = 0;
  let broken = false;

  const states = new Map<Cue, CueState>();

  const ensureContext = (): AudioContext | null => {
    if (broken) {
      return null;
    }
    if (context) {
      return context;
    }
    try {
      const Ctor =
        (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) {
        broken = true;
        return null;
      }
      context = new Ctor();
      master = context.createGain();
      master.gain.value = muted ? 0 : MASTER_GAIN;
      master.connect(context.destination);
      return context;
    } catch {
      broken = true;
      return null;
    }
  };

  const noiseBuffer = (ctx: AudioContext): AudioBuffer => {
    if (noise) {
      return noise;
    }
    const frames = Math.floor(ctx.sampleRate * 0.5);
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    // Deterministic noise: a fixed LCG rather than Math.random, so the same hit sounds the
    // same every run. Nothing about audio should be non-reproducible.
    let seed = 0x9e3779b9;
    for (let i = 0; i < frames; i += 1) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      data[i] = (seed / 0xffffffff) * 2 - 1;
    }
    noise = buffer;
    return buffer;
  };

  const playTone = (ctx: AudioContext, dest: AudioNode, spec: CueSpec, level: number): void => {
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = spec.wave as OscillatorType;
    osc.frequency.setValueAtTime(Math.max(spec.from, 1), now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(spec.to, 1), now + spec.duration);

    const gain = ctx.createGain();
    // A short attack avoids the click that an instant gain step produces.
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(spec.gain * level, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + spec.duration);

    osc.connect(gain);
    gain.connect(dest);
    osc.start(now);
    osc.stop(now + spec.duration + 0.02);
    osc.onended = () => {
      voices -= 1;
      osc.disconnect();
      gain.disconnect();
    };
  };

  const playNoise = (ctx: AudioContext, dest: AudioNode, spec: CueSpec, level: number): void => {
    const now = ctx.currentTime;
    const source = ctx.createBufferSource();
    source.buffer = noiseBuffer(ctx);

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(Math.max(spec.from, 1), now);
    filter.frequency.exponentialRampToValueAtTime(Math.max(spec.to, 1), now + spec.duration);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(spec.gain * level, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + spec.duration);

    source.connect(filter);
    filter.connect(gain);
    gain.connect(dest);
    source.start(now);
    source.stop(now + spec.duration + 0.02);
    source.onended = () => {
      voices -= 1;
      source.disconnect();
      filter.disconnect();
      gain.disconnect();
    };
  };

  return {
    get available(): boolean {
      return !broken;
    },

    get muted(): boolean {
      return muted;
    },

    play(cue: Cue, intensity = 1): void {
      if (muted) {
        return;
      }
      const spec = CUES[cue];
      if (!spec) {
        return;
      }

      const now = performance.now();
      const state = states.get(cue) ?? { lastPlayedMs: -Infinity };
      if (now - state.lastPlayedMs < spec.minGapMs) {
        return;
      }
      state.lastPlayedMs = now;
      states.set(cue, state);

      if (voices >= MAX_VOICES) {
        return;
      }

      const ctx = ensureContext();
      if (!ctx || !master) {
        return;
      }
      // A context that has not been unlocked by a gesture stays suspended. Firing into it
      // would queue silent voices and burn the voice budget, so bail out instead.
      if (ctx.state === "suspended") {
        return;
      }

      const level = Math.max(0.15, Math.min(intensity, 1));
      voices += 1;
      try {
        if (spec.wave === "noise") {
          playNoise(ctx, master, spec, level);
        } else {
          playTone(ctx, master, spec, level);
        }
      } catch {
        voices -= 1;
      }
    },

    resume(): void {
      const ctx = ensureContext();
      if (!ctx) {
        return;
      }
      if (ctx.state === "suspended") {
        void ctx.resume().catch(() => {
          // Autoplay refusal is expected on a cold load; the arena simply stays quiet.
        });
      }
    },

    setMuted(next: boolean): void {
      muted = next;
      if (master) {
        master.gain.value = next ? 0 : MASTER_GAIN;
      }
    },

    destroy(): void {
      states.clear();
      voices = 0;
      noise = null;
      if (context) {
        void context.close().catch(() => {
          // Already closed, or the browser refused; either way there is nothing to clean.
        });
      }
      context = null;
      master = null;
    }
  };
}

export { createSilentEngine };
