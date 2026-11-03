import { defineConfig, loadEnv, type Plugin } from "vite";

// transformers.js sets ONNX's wasmPaths to its CDN unconditionally, so onnxruntime's 21.6 MB wasm,
// which Vite copies in because of a fallback reference, is never loaded. It would only add to the
// binary. The renderer's local models still download what they need, as they do in Electron.
const dropUnusedOrtWasm = (): Plugin => ({
  name: "drop-unused-ort-wasm",
  apply: "build",
  generateBundle(_options, bundle) {
    for (const name of Object.keys(bundle)) {
      if (/ort-wasm-.*\.wasm$/.test(name)) delete bundle[name];
    }
  },
});

// The Phase 0/1 test pages go into a bundle only for test builds: VITE_TEST_PAGES=1, used together
// with cargo's webkit-tests feature. A release bundle has the editor alone.
export default defineConfig(({ mode }) => {
  const testPages = (process.env.VITE_TEST_PAGES ?? loadEnv(mode, process.cwd()).VITE_TEST_PAGES) === "1";
  return {
    base: "./",
    build: {
      outDir: "dist",
      emptyOutDir: true,
      target: "safari16",
      rollupOptions: { input: { editor: "editor.html", ...(testPages ? { spike: "spike.html", bench: "bench.html", phase1: "phase1.html" } : {}) } },
    },
    plugins: [dropUnusedOrtWasm()],
    esbuild: { jsx: "automatic" },
    resolve: { conditions: ["import", "module", "browser", "default"] },
  };
});
