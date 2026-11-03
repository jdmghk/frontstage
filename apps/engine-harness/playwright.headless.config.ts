import base from "./playwright.config";
import { defineConfig } from "@playwright/test";

// Headless Chromium has no WebGPU on this Mac, so run headed with the window off-screen.
export default defineConfig({
  ...base,
  projects: [
    {
      name: "chromium-webgpu-offscreen",
      use: {
        browserName: "chromium",
        launchOptions: {
          headless: false,
          args: [
            "--enable-unsafe-webgpu",
            "--ignore-gpu-blocklist",
            "--window-position=-2000,-2000",
            "--window-size=400,300",
            "--disable-backgrounding-occluded-windows",
            "--disable-renderer-backgrounding",
          ],
        },
      },
    },
  ],
});
