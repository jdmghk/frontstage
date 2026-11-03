// Entry for the real app: the bridge first, so window.desktop* exists when the editor's modules run.
import "./tauri-bridge.js";
import "./legacy-secrets-notice.js";

const smoke = import.meta.env.VITE_TEST_PAGES === "1" && (window as unknown as { __FRONTSTAGE_SMOKE__?: boolean }).__FRONTSTAGE_SMOKE__;
if (import.meta.env.VITE_TEST_PAGES === "1" && smoke) await import("./smoke-raf.js");

await import("../../desktop/src/renderer/editor.js");

// The test build's hook. import.meta.env keeps smoke.ts out of a release bundle altogether.
if (import.meta.env.VITE_TEST_PAGES === "1" && smoke) await import("./smoke.js");
