import base from "./playwright.config";
import { defineConfig } from "@playwright/test";

// The old headless shell has no WebGPU on this Mac. The "chromium" channel's new headless mode does,
// and opens no window.
export default defineConfig({
  ...base,
  projects: [
    {
      name: "chromium-webgpu-headless",
      use: {
        browserName: "chromium",
        launchOptions: {
          headless: true,
          channel: "chromium",
          args: [
            "--enable-unsafe-webgpu",
            "--ignore-gpu-blocklist",
            "--use-angle=metal",
          ],
        },
      },
    },
  ],
});
