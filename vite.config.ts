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
    // Preserve existing files locally. Publish from a fresh CI workspace.
    emptyOutDir: false
  }
});
