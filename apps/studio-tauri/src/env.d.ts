import type { DesktopExportBridge } from "../../desktop/src/renderer/ffmpeg-sink.js";

declare global {
  interface Window {
    // Electron's copy of this declaration sits in export-renderer.ts, which the app doesn't include.
    desktopExport: DesktopExportBridge;
  }
}
