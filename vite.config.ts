import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Relative assets support both a Pages repository subpath and a custom domain.
  // Keep a single page; do not add history routes without a hosting strategy.
  base: "./",
  server: {
    host: "127.0.0.1",
    // Pre-transform the client entry, and by extension everything it imports.
    //
    // Vite transforms on demand, so the first page load pays the transform cost of every
    // module it reaches. That cost is not small here: measured on this machine, the app took
    // 19.4 / 20.3 / 20.8 s to mount on three consecutive runs with an idle machine -- and the
    // release sweep's mount budget had to be raised to 90 s because a busy machine turned
    // that into more than 40 s and the verifiers reported it as "app 未挂载".
    //
    // Vite's own warm-up walks the import graph from the files listed here (`clientFiles`)
    // and transforms them at server start, so the cost lands where nothing is being timed.
    // It also makes `npm run dev` start into a usable page for a human.
    //
    // Measured: `verify-clock` reports 15.4 s from navigation to a mounted app with this on,
    // against 19.4 s with it off. Worth keeping, and not the whole story -- a warm graph still
    // leaves ~15 s, so most of the mount is elsewhere and Pixi's renderer coming up under the
    // software rasteriser is the obvious next thing to profile.
    warmup: { clientFiles: ["src/main.tsx"] }
  },
  preview: { host: "127.0.0.1" },
  build: {
    outDir: "dist",
    // Empty the output directory on every build.
    //
    // This was previously `false`, with the reasoning "publish from a fresh CI workspace".
    // That reasoning only holds on CI. Locally it means `dist/` is the union of every build
    // ever run, and the artifact stops answering the one question that matters before a
    // release: *is what I am about to publish the thing I just built?* The answer was no —
    // a run of stale chunks from four generations back pushed the shipped bundle from
    // ~263 kB to ~458 kB gzipped while every individual file still looked correct.
    //
    // `scripts/check-build.mjs` catches the accumulation, but catching it is not the same
    // as not producing it.
    emptyOutDir: true
  }
});
