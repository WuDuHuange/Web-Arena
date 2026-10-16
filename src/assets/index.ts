/**
 * Asset URLs.
 *
 * Every file the renderer or the audio engine loads comes through here, and every path is
 * discovered by `import.meta.glob` rather than written by hand. That is not tidiness:
 *
 *   `vite.config.ts` sets `base: "./"` because the site is served from a repository subpath
 *   on GitHub Pages. A root-absolute path (`/assets/ground/x.jpg`) resolves against the
 *   domain root and 404s under that subpath, and the failure is silent — the app runs, the
 *   texture simply never arrives. The glob hands back the URL Vite actually emitted, hashed
 *   and relative, so the mistake cannot be made by hand.
 *
 * `eager: true` inlines the URL map into the bundle instead of code-splitting it, so the URL
 * is known at module load and the renderer can start its fetch on the first frame rather
 * than after a dynamic import resolves.
 *
 * The directory listing below is the whole reason these are separate globs rather than one
 * glob over `assets/`: each slot has its own required extension and its own consumer, and a
 * single map would let a texture be handed to the audio loader.
 *
 * ⚠️ `assets/ui/` is deliberately NOT here. Those files are the HUD chrome — 9-slice panels,
 * buttons and the display face — and the only consumer is `src/styles.css`, which reaches
 * them with a relative `url()` that Vite rewrites through the same `base` pipeline. Routing
 * them through a glob would mean setting CSS custom properties from JavaScript at boot, for
 * no gain: there is no runtime lookup to protect, because the stylesheet is resolved at
 * build time. Everything a *renderer or audio engine* loads at runtime still comes through
 * here, which is the boundary this file actually guards.
 */

/** Square, top-down, seamless ground material. See `render/ground.ts` for why square. */
const GROUND = import.meta.glob("./ground/*.jpg", {
  eager: true,
  query: "?url",
  import: "default"
}) as Record<string, string>;

/**
 * Looping background tracks.
 *
 * Kept as its own glob rather than folded into the one above, because the extension is the
 * only thing standing between "the audio loader got a JPEG" and a track that silently never
 * plays. The slot name below is what `content/credits.ts` registers against.
 */
const MUSIC = import.meta.glob("./music/*.mp3", {
  eager: true,
  query: "?url",
  import: "default"
}) as Record<string, string>;

/**
 * Character art, one file per pose.
 *
 * One file per pose rather than a packed atlas or a horizontal strip, because that is how the
 * pack ships them and because a packed format invented here would be a guess at a format the
 * next pack will not use. PNG, not JPEG: the art is flat-shaded with hard edges, and JPEG
 * rings around every one of them.
 */
const CHARACTERS = import.meta.glob("./characters/*.png", {
  eager: true,
  query: "?url",
  import: "default"
}) as Record<string, string>;

/**
 * Looks a slot up, and fails loudly when it is missing.
 *
 * Throwing at module load is deliberate. The alternative is a `?? ""` that hands Pixi an
 * empty URL, which produces a floor that renders as the app background — a wrong picture
 * that looks like a lighting choice rather than like a bug. A rename of the file on disk
 * should stop the build, not quietly remove the ground.
 */
function requireSlot(urls: Record<string, string>, name: string): string {
  const url = urls[name];
  if (!url) {
    throw new Error(
      `素材缺失 ${name}；当前已知：${Object.keys(urls).sort().join(", ") || "（空）"}`
    );
  }
  return url;
}

/** The arena floor. CC0; see `content/credits.ts` for the source and the date. */
export const GROUND_TEXTURE_URL = requireSlot(GROUND, "./ground/ambientcg-ground051-512.jpg");

/**
 * The battle loop.
 *
 * A `maou_loop_*` file, not the plain one: 魔王魂 ships a separate cut of each track whose
 * tail is written to butt against its own head, and looping the ordinary cut leaves an
 * audible seam every time round. CC BY 4.0, so it carries an attribution obligation that
 * the plain CC0 floor does not — see `content/credits.ts`.
 */
export const BGM_URL = requireSlot(MUSIC, "./music/maou-loop-8bit27.mp3");

/**
 * The character art slots, keyed by the logical name the appearance registry uses.
 *
 * A table rather than one named export per pose, and the reason is structural: the registry
 * lives in `content/appearance.ts`, which imports nothing by contract — that is what lets the
 * whole decision table run under `node --test` with no browser and no asset pipeline. So a
 * spec can only ever *name* a slot (`asset:robot-idle`); the lookup that turns that name into
 * a hashed URL has to happen on this side, where the glob is. Keeping the paths in one table
 * also means a renamed file breaks the build at `requireSlot` rather than at 404 time.
 */
export const CHARACTER_ART: Readonly<Record<string, string>> = {
  "robot-idle": requireSlot(CHARACTERS, "./characters/robot-idle.png"),
  "robot-attack": requireSlot(CHARACTERS, "./characters/robot-attack.png"),
  "zombie-idle": requireSlot(CHARACTERS, "./characters/zombie-idle.png"),
  "zombie-attack": requireSlot(CHARACTERS, "./characters/zombie-attack.png")
};
