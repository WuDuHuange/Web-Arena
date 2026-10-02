import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Relative assets support both a Pages repository subpath and a custom domain.
  // Keep a single page; do not add history routes without a hosting strategy.
  base: "./",
  server: { host: "127.0.0.1" },
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
