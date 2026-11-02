import { writeFileSync } from "node:fs";
import { test, expect } from "@playwright/test";

interface Row {
  name: string; maxDiff: number; meanAbs: number; overTol: number; tolerance: number;
  note?: string; reportOnly: boolean; passed: boolean;
  worst: { x: number; y: number; a: number[]; b: number[] } | null;
}

// WebGPU is the reference. Every fixture must match within its stated tolerance; report-only
// fixtures are printed so a difference is visible, never hidden.
test("WebGL2Renderer matches FrameRenderer on every fixture", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto("/parity.html");
  await expect(page.locator("#status")).toHaveText("ok", { timeout: 90_000 });
  const rows = await page.evaluate(() => (window as unknown as { __parity: Row[] }).__parity);
  const info = await page.evaluate(() => (window as unknown as { __parityInfo: { factoryBackend: string; contextRestore: { overTol: number } } }).__parityInfo);
  expect(info.factoryBackend).toBe("webgpu");
  expect(info.contextRestore.overTol).toBe(0);
  console.log(JSON.stringify(info));
  for (const r of rows) {
    const worst = r.worst ? ` worst@${r.worst.x},${r.worst.y} gpu=${r.worst.a} gl=${r.worst.b}` : "";
    console.log(`${r.passed ? "ok  " : "FAIL"} ${r.name} max=${r.maxDiff} mean=${r.meanAbs} over=${r.overTol}/14400 tol=${r.tolerance}${r.reportOnly ? " report-only" : ""}${worst}`);
  }
  if (process.env.PARITY_REF_OUT) {
    const refs = await page.evaluate(() => (window as unknown as { __parityRefs: () => unknown }).__parityRefs());
    writeFileSync(process.env.PARITY_REF_OUT, JSON.stringify(refs));
  }
  expect(rows.filter((r) => !r.passed).map((r) => r.name)).toEqual([]);
});
