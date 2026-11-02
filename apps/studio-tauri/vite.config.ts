import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  build: { outDir: "dist", emptyOutDir: true, target: "safari16", rollupOptions: { input: { index: "index.html", bench: "bench.html", phase1: "phase1.html" } } },
  resolve: { conditions: ["import", "module", "browser", "default"] },
});
