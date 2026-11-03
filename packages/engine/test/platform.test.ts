import { describe, expect, test } from "vitest";
import { isWebKitEngine } from "../src/platform.js";

describe("isWebKitEngine", () => {
  test("WKWebView and Safari are WebKit", () => {
    expect(isWebKitEngine("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)")).toBe(true);
    expect(isWebKitEngine("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15")).toBe(true);
  });
  test("Chrome, Electron and WebView2 aren't", () => {
    expect(isWebKitEngine("Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36")).toBe(false);
    expect(isWebKitEngine("Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Frontstage/0.3.0 Chrome/140.0.0.0 Electron/38.0.0 Safari/537.36")).toBe(false);
    expect(isWebKitEngine("Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0")).toBe(false);
  });
});
