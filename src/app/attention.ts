/**
 * What the clock should do when the page stops being looked at.
 *
 * Pure and import-free, for the same reason `content/appearance.ts` is: this decision is worth
 * testing without a browser, and a `document` in scope is an invitation to read it.
 *
 * ## Why `visibilitychange` rather than `blur`
 *
 * The architecture asks for "页面失焦默认暂停" (§2.2), and the clause that follows it says what
 * the requirement is *for*: a backgrounded page must not accumulate time. That is exactly what
 * the visibility API reports — the page is not being rendered, so nobody is watching the
 * fight. `blur` answers a different question: it fires when focus moves into devtools or an
 * inner frame, which is when an operator is most likely to be inspecting the bench and least
 * likely to want it frozen.
 *
 * ## Why a return resumes
 *
 * "默认" reads as a default, not a latch. A pause the page imposed on itself is undone when
 * the page is looked at again, so in practice the interruption is invisible. A pause the *user*
 * asked for is not, because it carries no automatic mark and survives any amount of tab
 * switching. Without that distinction, switching away and back would silently clear a pause
 * the operator set on purpose — the worse of the two failures, since it is the one that
 * destroys a deliberate action rather than merely repeating a convenient one.
 *
 * Nothing here reads the clock or the world; the caller owns both. What this owns is the one
 * decision that is easy to get wrong and impossible to notice in a screenshot.
 */

/**
 * Phases the shell can be in, as far as the attention policy is concerned.
 *
 * Deliberately a second declaration of the shell's union rather than an import from `App.tsx`,
 * matching `MusicPhase` in `audio/music.ts`. The two are structurally identical, so a value
 * flows across the boundary without a cast — but a policy module that imported the component
 * would drag React into a file whose whole value is that it has no dependencies.
 */
export type AttentionPhase = "editing" | "running" | "paused" | "decided";

export interface AttentionState {
  readonly phase: AttentionPhase;
  /**
   * Whether the current pause was imposed by a hidden page rather than asked for by the user.
   *
   * False in every phase but `paused`, and the only thing that makes a return able to resume.
   */
  readonly autoPaused: boolean;
}

/**
 * The clock state a visibility change asks for.
 *
 * Returning the argument unchanged is the common case and is deliberate — the caller compares
 * the two fields and skips the re-render, because "the page hid while we were laying out" is
 * not a state change. `decided` is in that group for a second reason: a finished battle has
 * nothing left to advance, so hiding and returning must not resurrect it into `running`.
 */
export function onVisibility(state: AttentionState, visible: boolean): AttentionState {
  if (!visible) {
    return state.phase === "running" ? { phase: "paused", autoPaused: true } : state;
  }
  return state.phase === "paused" && state.autoPaused
    ? { phase: "running", autoPaused: false }
    : state;
}
