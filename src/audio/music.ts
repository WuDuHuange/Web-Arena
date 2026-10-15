/**
 * Looping background music.
 *
 * Separate from `synth.ts` on purpose. The effects are WebAudio voices that are created,
 * fired and torn down dozens of times a second; the music is one long decoded stream that
 * lives for the whole session. Running the track through `AudioContext.decodeAudioData`
 * would hold a decoded PCM buffer — roughly 10 MB per minute at 44.1 kHz stereo, for a
 * 45-second loop — to buy nothing, because an `<audio>` element already streams and already
 * loops. The two also fail differently: a missing effect is one silent swing, a missing
 * track is a silent session.
 *
 * ## Autoplay
 *
 * Every browser refuses `play()` outside a user gesture, and — this is the part that bites —
 * a refusal is not a one-off. The element stays blocked until a *later* gesture tries again.
 * So `play()` records the intent, attempts, and on refusal arms a one-shot retry on the next
 * pointer or key event. Without that, one unlucky first click means music never starts for
 * the rest of the session, and the bug looks like "the track is broken".
 *
 * ## Muting
 *
 * Mute is a gain of zero, not a pause. The track keeps its position, so unmuting mid-battle
 * rejoins the loop where it is rather than restarting the fight music from the top.
 *
 * Degradation is silent and total, matching the effects engine: no `Audio`, no file, a
 * blocked context — every method becomes a no-op and nothing in the battle path notices.
 */

/**
 * Music level, relative to the element's own scale (0..1).
 *
 * Deliberately well under `MASTER_GAIN` in `synth.ts` (0.5). A loop plays continuously while
 * effects are transient, so the same nominal level would read as far louder in practice and
 * would bury the hit and blast cues that carry the actual feedback.
 */
export const MUSIC_VOLUME = 0.34;

/** Phases the shell can be in, as far as the music policy is concerned. */
export type MusicPhase = "editing" | "running" | "paused" | "decided";

/**
 * Whether the track should be running in a given phase.
 *
 * Music belongs to the fight: it starts on 开战 and survives 暂停 and 已分胜负, so the result
 * screen does not go quiet under the player. Returning to 待命 stops it, which is what makes
 * laying out a field feel like setup rather than like a battle that has not begun.
 *
 * Pure, and separated from the element, because this is the part worth asserting: the DOM
 * half is thin, and the policy half is where a wrong answer is invisible until someone
 * notices the music started at the wrong moment.
 */
export function shouldPlayMusic(phase: MusicPhase): boolean {
  return phase !== "editing";
}

/** Mute is zero, not silence-by-absence. See the module note. */
export function musicVolume(muted: boolean): number {
  return muted ? 0 : MUSIC_VOLUME;
}

export interface MusicChannel {
  readonly available: boolean;
  readonly muted: boolean;
  readonly playing: boolean;
  /** The URL the channel was handed, so a caller can show or assert what it is loading. */
  readonly source: string;
  /**
   * Loader state, for the `?debug=1` probe.
   *
   * Separate from the playback contract on purpose: `playing` answers "is it running", and
   * when the answer is no, the only useful follow-up is whether the file loaded at all.
   * Without this, a head-less check cannot tell "the browser refused to autoplay" from
   * "the track 404'd", and those two need opposite fixes.
   */
  diagnostics(): {
    readonly readyState: number;
    readonly errorCode: number | null;
    readonly volume: number;
  };
  /** Records the intent to play and attempts it. Safe to call repeatedly. */
  play(): void;
  /** Stops the track and clears the intent, so a refusal retry will not restart it. */
  stop(): void;
  setMuted(muted: boolean): void;
  destroy(): void;
}

/**
 * A stand-in for when audio is unavailable.
 *
 * Same reasoning as the silent effects engine: returning this instead of `null` keeps every
 * call site free of null checks, which is the difference between "music is optional" being
 * true in the architecture and being true in the code.
 */
export function createSilentChannel(muted: boolean, source = ""): MusicChannel {
  return {
    available: false,
    muted,
    playing: false,
    source,
    diagnostics: () => ({ readyState: 0, errorCode: null, volume: 0 }),
    play(): void {},
    stop(): void {},
    setMuted(): void {},
    destroy(): void {}
  };
}

export function createMusicChannel(options: { url: string; muted?: boolean }): MusicChannel {
  let muted = options.muted ?? false;

  // Probed up front rather than lazily. A lazy check makes `available` report true until the
  // first attempt happens to fail, which is the one thing a caller would read it for.
  if (typeof (globalThis as { Audio?: unknown }).Audio !== "function") {
    return createSilentChannel(muted, options.url);
  }

  /** The intent, which is not the same as the element's state while a refusal is pending. */
  let wanted = false;
  let element: HTMLAudioElement | null = null;
  let broken = false;
  let retry: (() => void) | null = null;

  const ensureElement = (): HTMLAudioElement | null => {
    if (broken) {
      return null;
    }
    if (element) {
      return element;
    }
    try {
      const Ctor = (globalThis as { Audio?: typeof Audio }).Audio;
      if (!Ctor) {
        broken = true;
        return null;
      }
      const audio = new Ctor();
      audio.src = options.url;
      audio.loop = true;
      // `preload` rather than `autoplay`: autoplay is refused outright and, once refused,
      // the element is the one the browser remembers. An explicit `play()` from a gesture
      // is the only path that reliably starts.
      audio.preload = "auto";
      audio.volume = musicVolume(muted);
      element = audio;
      return audio;
    } catch {
      broken = true;
      return null;
    }
  };

  const disarm = (): void => {
    if (!retry) {
      return;
    }
    window.removeEventListener("pointerdown", retry);
    window.removeEventListener("keydown", retry);
    retry = null;
  };

  /**
   * Waits for the next gesture and tries once more.
   *
   * Both listeners are registered and both removed on the first of them to fire: `{ once }`
   * would retire only the one that fired and leave the other armed for the rest of the
   * session, which is a leak that also double-fires the retry.
   */
  const armRetry = (): void => {
    if (retry || typeof window === "undefined") {
      return;
    }
    retry = (): void => {
      disarm();
      if (wanted) {
        attempt();
      }
    };
    window.addEventListener("pointerdown", retry);
    window.addEventListener("keydown", retry);
  };

  function attempt(): void {
    const audio = ensureElement();
    if (!audio || !wanted || !audio.paused) {
      return;
    }
    try {
      const result = audio.play();
      if (result && typeof result.catch === "function") {
        // A rejection here is the normal cold-load case, not an error worth logging.
        result.catch(() => armRetry());
      }
    } catch {
      armRetry();
    }
  }

  return {
    get available(): boolean {
      return !broken;
    },

    get muted(): boolean {
      return muted;
    },

    get playing(): boolean {
      return element !== null && !element.paused;
    },

    get source(): string {
      return options.url;
    },

    diagnostics(): { readyState: number; errorCode: number | null; volume: number } {
      return {
        readyState: element?.readyState ?? 0,
        errorCode: element?.error?.code ?? null,
        volume: element?.volume ?? 0
      };
    },

    play(): void {
      wanted = true;
      attempt();
    },

    stop(): void {
      wanted = false;
      disarm();
      if (element) {
        element.pause();
      }
    },

    setMuted(next: boolean): void {
      muted = next;
      if (element) {
        element.volume = musicVolume(next);
      }
    },

    destroy(): void {
      wanted = false;
      disarm();
      if (element) {
        element.pause();
        // Pausing leaves the stream resident. Clearing the source and re-running `load()`
        // is what actually releases the buffer; without it a long session accumulates one
        // decoded track per battlefield rebuild.
        try {
          element.removeAttribute("src");
          element.load();
        } catch {
          // Already torn down by the browser; nothing left to release.
        }
      }
      element = null;
    }
  };
}
