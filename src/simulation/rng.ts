/**
 * Seedable pseudo-random generator (mulberry32).
 *
 * A managed seed is the necessary foundation for reproducing a battle. It is NOT a
 * guarantee of bit-identical results across browsers, which the project does not promise.
 */
export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max). */
  range(min: number, max: number): number;
}

export function createRng(seed: number): Rng {
  let state = seed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    range(min: number, max: number): number {
      return min + Math.floor(next() * (max - min));
    }
  };
}
