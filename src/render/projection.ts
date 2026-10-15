/**
 * World-to-screen projection, for the 2.5D view.
 *
 * The flat renderer draws world coordinates straight to the screen: one container scale and
 * nothing else. An isometric arena cannot do that, because a point's screen position is no
 * longer its world position — but the important part is *how* it differs, and that decides
 * how much of the renderer has to change.
 *
 * The answer is: less than it looks, and the split is the whole design.
 *
 *   - **The ground plane is a linear map.** An isometric projection of a plane is a matrix,
 *     so anything lying flat — the arena outline, trap fields, unit footprints — can be
 *     drawn in plain world coordinates and handed to a container carrying that matrix. It
 *     comes out correct with no per-shape work at all. This is why a circular lava pool
 *     becomes a correctly-shaped ellipse for free, and why `props.ts` needs no changes.
 *   - **Upright things are not.** A unit's sprite, its facing marker and its health bar
 *     stand perpendicular to the ground. Projecting them through the matrix would squash
 *     them into the floor, which is wrong in a way that is immediately visible. They have to
 *     be *positioned* by the projection but *drawn* without it.
 *
 * That distinction — positioned by, versus drawn through — is the entire content of 2.5D
 * support, and it is why `depth` exists here rather than in the renderer: with a ground
 * matrix the painter's order is no longer the order shapes were added, so it has to be
 * computed from the same coordinates the projection used.
 *
 * This module is pure and imports nothing, for the same reason `content/appearance.ts` is:
 * it is a decision, and decisions get asserted in tests rather than eyeballed on a canvas.
 */

export type ProjectionKind = "flat" | "iso";

export interface ProjectionOptions {
  /** Arena size in world units. The projection needs it to place the projected arena at the origin. */
  readonly width: number;
  readonly height: number;
}

/** A 2x3 affine transform, in PixiJS's component order. */
export interface AffineMatrix {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly tx: number;
  readonly ty: number;
}

export interface Point2D {
  readonly x: number;
  readonly y: number;
}

export interface Projector {
  readonly kind: ProjectionKind;
  /** World units to projected units. */
  project(x: number, y: number): Point2D;
  /**
   * Projected units back to world units — the exact inverse of `project`.
   *
   * Not a convenience. The editor drags units by pointer, and a pointer arrives in screen
   * pixels; without an exact inverse, every drop in the 2.5D view lands somewhere offset
   * from the cursor, and the offset grows with distance from the origin. A round-trip
   * assertion in the tests is what keeps the two directions from drifting apart.
   */
  unproject(x: number, y: number): Point2D;
  /**
   * Painter's-algorithm key. Larger is nearer the camera and must be drawn later.
   *
   * For this isometric projection that is `x + y`, and it is worth being precise about why,
   * because the obvious guess is wrong in an instructive way: screen `y` is `(x + y) * k`
   * for a constant `k`, so `x + y` and screen `y` order points *identically*. Sorting by
   * screen height is not an approximation of the isometric depth sort — for a parallel
   * projection it is exactly the same sort. That is why every 2.5D game y-sorts.
   *
   * The function exists anyway, rather than the renderer reaching for `project().y`, because
   * that equivalence is a property of a *parallel* projection. Under a perspective camera it
   * stops holding, and the renderer should not have to be edited when that day comes.
   */
  depth(x: number, y: number): number;
  /**
   * Which way a world-space heading points on screen, as a sign: `-1` is left.
   *
   * A billboard is drawn square to the camera, so a world angle has no direct screen meaning;
   * what the renderer needs is only the left/right half of it, and that half is a property of
   * the projection rather than of the angle. Under the flat view a heading points right when
   * its `cos` is positive. Under the isometric view screen `x` is `(x - y) * k`, so the same
   * heading points right when `cos - sin` is positive — and a unit walking "north-east" in
   * world space is drawn walking straight up the screen, a heading whose art must not flip
   * halfway across the arena.
   *
   * The sign is computed here rather than by the renderer because the projection is what
   * decides it, and the renderer has no business knowing which projection is in force.
   */
  horizontalSign(angle: number): -1 | 1;
  /**
   * Whether the renderer should honour `depth`.
   *
   * False for flat. The existing flat renderer draws in creation order and is verified
   * against that; turning sorting on there would be a behaviour change smuggled in under a
   * projection flag, so it stays off.
   */
  readonly sortable: boolean;
  /** `project` as a matrix, for handing to a container so flat shapes project for free. */
  matrix(): AffineMatrix;
  /** The arena's extent after projection, at the origin. Used to fit the view. */
  projectedExtent(): { readonly width: number; readonly height: number };
}

/**
 * Screen height of a ground square, as a fraction of its screen width.
 *
 * 0.5 is the 2:1 diamond that tile art and most isometric asset packs are drawn for. It is
 * a named constant rather than a magic number in the matrix because it is the one value an
 * art director is likely to want changed, and it has to be the same value in `project`,
 * `unproject` and `matrix` or the inverse stops being one.
 */
const ISO_RATIO = 0.5;

/**
 * Overall scale of the isometric projection.
 *
 * The projected arena is `(w + h) * SCALE` wide, so 0.5 keeps it in the same order of
 * magnitude as the flat arena and lets the existing fit-to-host step do the rest. Baking a
 * screen size in here would fight that step rather than feed it.
 */
const ISO_SCALE = 0.5;

function flatProjector(options: ProjectionOptions): Projector {
  return {
    kind: "flat",
    project: (x, y) => ({ x, y }),
    unproject: (x, y) => ({ x, y }),
    depth: (_x, y) => y,
    // Screen x is world x, so the heading's own cosine is the whole answer.
    horizontalSign: (angle) => (Math.cos(angle) >= 0 ? 1 : -1),
    sortable: false,
    matrix: () => ({ a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }),
    projectedExtent: () => ({ width: options.width, height: options.height })
  };
}

function isoProjector(options: ProjectionOptions): Projector {
  const { width, height } = options;

  // The un-offset projection puts the arena's left corner at `x = -height * ISO_SCALE`, so
  // everything is shifted right by exactly that much. Doing it here rather than as a
  // container offset keeps `project` and `matrix` the same function, which is what makes
  // the round-trip assertion meaningful.
  const offsetX = height * ISO_SCALE;
  const yScale = ISO_SCALE * ISO_RATIO;

  return {
    kind: "iso",
    project: (x, y) => ({
      x: (x - y) * ISO_SCALE + offsetX,
      y: (x + y) * yScale
    }),
    unproject: (x, y) => {
      // Recover `x - y` and `x + y`, then solve the 2x2 system. Inverting the matrix by hand
      // here rather than reusing the forward expressions is deliberate: two independent
      // derivations are what the round-trip test actually checks.
      const difference = (x - offsetX) / ISO_SCALE;
      const sum = y / yScale;
      return { x: (sum + difference) / 2, y: (sum - difference) / 2 };
    },
    depth: (x, y) => x + y,
    // Screen x is `(x - y) * ISO_SCALE + offsetX`, so a heading's screen component is
    // `cos - sin`. The same expression `project` uses, with the direction in place of the
    // position, which is why the two can never disagree about which way is right.
    horizontalSign: (angle) => (Math.cos(angle) - Math.sin(angle) >= 0 ? 1 : -1),
    sortable: true,
    matrix: () => ({
      a: ISO_SCALE,
      b: yScale,
      c: -ISO_SCALE,
      d: yScale,
      tx: offsetX,
      ty: 0
    }),
    projectedExtent: () => ({
      width: (width + height) * ISO_SCALE,
      height: (width + height) * yScale
    })
  };
}

export function createProjector(kind: ProjectionKind, options: ProjectionOptions): Projector {
  return kind === "iso" ? isoProjector(options) : flatProjector(options);
}

/** Reads `?view=` into a projection kind. Anything unrecognised is flat, the shipped default. */
export function projectionKindFrom(value: string | null | undefined): ProjectionKind {
  return value === "iso" ? "iso" : "flat";
}
