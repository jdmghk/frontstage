import { expect, test, type Page } from "@playwright/test";

async function waitForReady(page: Page) {
  await page.waitForSelector('[data-testid="preview-canvas"][data-engine-ready="1"]', { timeout: 15_000 });
}

async function injectOpfsPicker(page: Page) {
  await page.addInitScript(() => {
    (window as any).__opfsHandles = [] as FileSystemDirectoryHandle[];
    (window as any).__pickDirectory = async () => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle("prod-proj-" + Date.now() + "-" + Math.random(), { create: true });
      (window as any).__opfsHandles.push(dir);
      return dir;
    };
  });
}

async function pngBytes(page: Page): Promise<Buffer> {
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 8;
    canvas.height = 8;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "teal";
    ctx.fillRect(0, 0, 8, 8);
    const blob = await new Promise<Blob>((r, j) => canvas.toBlob((b) => (b ? r(b) : j(new Error("toBlob"))), "image/png"));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  return Buffer.from(bytes);
}

test("production: scene → shot → take → place → character → save → reopen", async ({ page }) => {
  await injectOpfsPicker(page);
  await page.goto("/");
  await waitForReady(page);

  // Production tab: one scene with one shot.
  await page.getByTestId("media-tab-production").click();
  await page.getByTestId("production-add-scene").click();
  await page.getByTestId("scene-0-add-shot").click();
  await page.getByTestId("shot-0-0-toggle").click();
  await page.getByTestId("shot-0-0-prompt").fill("rain-soaked rooftop, wide establishing shot");

  // Import a take recorded as a Google Flow manual import. A PNG still stands in for the clip:
  // Playwright's Chromium ships without H.264, so an .mp4 import never finishes probing there.
  await page.getByTestId("shot-0-0-import-source").selectOption("flow-manual");
  await page.getByTestId("shot-0-0-import-input").setInputFiles({ name: "flow-take.png", mimeType: "image/png", buffer: await pngBytes(page) });
  await expect(page.getByTestId("shot-0-0-take-0")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("shot-0-0-take-0-pending")).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByTestId("shot-0-0-status")).toHaveAttribute("data-status", "generated");

  // Approve and place it on the timeline.
  await page.getByTestId("shot-0-0-take-0-approve").click();
  await expect(page.getByTestId("shot-0-0-status")).toHaveAttribute("data-status", "approved");
  const before = await page.evaluate(() => (window as any).__frontstageStore.getSnapshot().timeline.tracks.flatMap((t: any) => t.clips).length);
  await page.getByTestId("shot-0-0-place").click();
  await expect(page.getByTestId("shot-0-0-replace")).toBeVisible();
  const placed = await page.evaluate(() => {
    const clips = (window as any).__frontstageStore.getSnapshot().timeline.tracks.flatMap((t: any) => t.clips);
    return { count: clips.length, refs: clips.map((c: any) => c.mediaRef) };
  });
  expect(placed.count).toBeGreaterThan(before);

  // Characters tab: one character with a reference image marked as the approved design.
  await page.getByTestId("media-tab-characters").click();
  await page.getByTestId("characters-add").click();
  await page.getByTestId("character-0-name").fill("Kai");
  await page.getByTestId("character-0-hair").fill("black topknot");
  await page.getByTestId("character-0-refs-input").setInputFiles({ name: "kai-front.png", mimeType: "image/png", buffer: await pngBytes(page) });
  await expect(page.getByTestId("character-0-ref-0")).toBeVisible({ timeout: 8_000 });
  await page.getByTestId("character-0-ref-0-design").click();

  // Production edits alone make the project dirty.
  expect(await page.evaluate(() => (window as any).__projectSession.isDirty())).toBe(true);

  // Save As writes production.json next to project.json.
  await page.getByTestId("file-menu").click();
  await page.getByTestId("file-save-as").click();
  await page.waitForFunction(() => (window as any).__projectSession.getState().ref !== null, { timeout: 8_000 });
  const saved = await page.evaluate(async () => {
    const dir = (window as any).__opfsHandles[0] as FileSystemDirectoryHandle;
    const text = await (await (await dir.getFileHandle("production.json")).getFile()).text();
    return JSON.parse(text);
  });
  expect(saved.scenes).toHaveLength(1);
  expect(saved.scenes[0].shots[0].prompt).toBe("rain-soaked rooftop, wide establishing shot");
  expect(saved.scenes[0].shots[0].takes[0].provider).toBe("flow-manual");
  expect(saved.scenes[0].shots[0].timelineClipId).toBeTruthy();
  expect(saved.characters[0].name).toBe("Kai");
  expect(saved.characters[0].approvedDesignIds).toHaveLength(1);
  expect(await page.evaluate(() => (window as any).__projectSession.isDirty())).toBe(false);

  // New project clears it; reopening restores scenes and characters.
  const ref = await page.evaluate(() => (window as any).__projectSession.getState().ref);
  await page.evaluate(() => (window as any).__projectSession.newProject(async () => true));
  await page.getByTestId("media-tab-production").click();
  await expect(page.getByTestId("production-empty")).toBeVisible();
  await page.evaluate((r) => (window as any).__projectGateway.enqueueOpen(r), ref);
  await page.getByTestId("file-menu").click();
  await page.getByTestId("file-open").click();
  await page.waitForFunction((id: string) => (window as any).__projectSession.getState().ref?.id === id, ref.id, { timeout: 8_000 });
  await page.getByTestId("media-tab-production").click();
  await expect(page.getByTestId("scene-0")).toBeVisible();
  await page.getByTestId("media-tab-characters").click();
  await expect(page.getByTestId("character-0-name")).toHaveValue("Kai");
});
