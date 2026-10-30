import { expect, test } from "@playwright/test";

// Inject __pickSaveFile BEFORE the app bootstraps so WebExportGateway uses an OPFS file handle.
// showSaveFilePicker can't run headless — this seam returns a real OPFS FileSystemFileHandle.
test("WebExportGateway: File→Export writes a valid .mp4 to OPFS", async ({ page }) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    (window as any).__pickSaveFile = async (_suggestedName: string): Promise<FileSystemFileHandle> => {
      const root = await navigator.storage.getDirectory();
      return await root.getFileHandle("export-out.mp4", { create: true });
    };
  });

  await page.goto("/");
  // Wait for preview canvas + engine ready
  await expect(page.locator('[data-testid="preview-canvas"]')).toBeVisible({ timeout: 15_000 });
  await page.waitForSelector('[data-testid="preview-canvas"][data-engine-ready="1"]', { timeout: 15_000 });

  // Shrink the timeline to 3 frames so the export completes fast.
  // Keep the clip.mp4 track (available in the sample library) but trim to 3 frames only.
  await page.evaluate(() => {
    type Store = {
      getSnapshot(): { timeline: { tracks: unknown[] } };
      load(timeline: {
        fps: number;
        width: number;
        height: number;
        settingsConfigured: boolean;
        tracks: unknown[];
      }): void;
    };
    const store = (window as unknown as { __frontstageStore: Store }).__frontstageStore;
    const snap = store.getSnapshot();
    // Preserve the first track (clip.mp4) but reduce its clip to 3 frames
    const tracks = (snap.timeline.tracks as Array<{ clips: Array<Record<string, unknown>> }>).map((t) => ({
      ...t,
      clips: t.clips.map((c) => ({ ...c, durationFrames: 3, trimStartFrame: 0, trimEndFrame: 0 })),
    }));
    store.load({ fps: 30, width: 320, height: 240, settingsConfigured: true, tracks });
  });

  // Click File menu → Export
  await page.locator('[data-testid="file-menu"]').click();
  await page.locator('[data-testid="file-export-video"]').click();
  // The web editor asks for an export size first (timeline size is preselected).
  await page.locator('[data-testid="export-preset-continue"]').click();

  // Wait for export-progress to appear (required — proves the export started)
  const progressLocator = page.locator('[data-testid="export-progress"]');
  await progressLocator.waitFor({ state: "visible", timeout: 10_000 });

  // Wait for export-progress to disappear (export complete)
  await progressLocator.waitFor({ state: "hidden", timeout: 60_000 });

  // Read the OPFS file back and verify it's a valid MP4
  const result = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle("export-out.mp4");
    const file = await fh.getFile();
    const size = file.size;

    // Read bytes 4..8 to check the "ftyp" MP4 box signature
    const sliceText = await file.slice(4, 8).text();

    return { size, ftyp: sliceText };
  });

  expect(result.size).toBeGreaterThan(0);
  expect(result.ftyp).toBe("ftyp");
});

test("WebExportGateway: cancel (null handle) does not start export", async ({ page }) => {
  await page.addInitScript(() => {
    // Return null to simulate user cancel
    (window as any).__pickSaveFile = async (): Promise<null> => null;
  });

  await page.goto("/");
  await expect(page.locator('[data-testid="preview-canvas"]')).toBeVisible({ timeout: 15_000 });
  await page.waitForSelector('[data-testid="preview-canvas"][data-engine-ready="1"]', { timeout: 15_000 });

  await page.locator('[data-testid="file-menu"]').click();
  await page.locator('[data-testid="file-export-video"]').click();
  // The web editor asks for an export size first (timeline size is preselected).
  await page.locator('[data-testid="export-preset-continue"]').click();

  // Progress overlay must NOT appear (export was cancelled)
  const progressLocator = page.locator('[data-testid="export-progress"]');
  // Give a short window — if it appears within 2s the test fails
  await expect(progressLocator).not.toBeVisible({ timeout: 2_000 });
});

test("WebExportGateway: YouTube 1080p preset upscales a 16:9 timeline with H.264 High", async ({ page }) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    (window as any).__pickSaveFile = async (): Promise<FileSystemFileHandle> => {
      const root = await navigator.storage.getDirectory();
      return await root.getFileHandle("export-yt.mp4", { create: true });
    };
  });
  await page.goto("/");
  await page.waitForSelector('[data-testid="preview-canvas"][data-engine-ready="1"]', { timeout: 15_000 });
  await page.evaluate(() => {
    const store = (window as any).__frontstageStore;
    const snap = store.getSnapshot();
    const tracks = snap.timeline.tracks.map((t: any) => ({ ...t, clips: t.clips.map((c: any) => ({ ...c, durationFrames: 3, trimStartFrame: 0, trimEndFrame: 0 })) }));
    store.load({ fps: 30, width: 640, height: 360, settingsConfigured: true, tracks });
  });
  await page.locator('[data-testid="file-menu"]').click();
  await page.locator('[data-testid="file-export-video"]').click();
  await page.locator('[data-testid="export-preset-youtube-1080p"]').check();
  await page.locator('[data-testid="export-preset-continue"]').click();
  const progress = page.locator('[data-testid="export-progress"]');
  await progress.waitFor({ state: "visible", timeout: 10_000 });
  await progress.waitFor({ state: "hidden", timeout: 90_000 });

  const r = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const bytes = new Uint8Array(await (await (await root.getFileHandle("export-yt.mp4")).getFile()).arrayBuffer());
    const find = (s: string, from = 0) => {
      const pat = [...s].map((c) => c.charCodeAt(0));
      outer: for (let i = from; i < bytes.length - pat.length; i++) {
        for (let j = 0; j < pat.length; j++) if (bytes[i + j] !== pat[j]) continue outer;
        return i;
      }
      return -1;
    };
    const avcC = find("avcC");
    // The sample entry inside stsd (the ftyp box also lists "avc1" as a brand).
    const avc1 = find("avc1", find("stsd"));
    // avc1 sample entry: width/height are 2-byte fields 24 and 26 bytes after the box type.
    const w = (bytes[avc1 + 28]! << 8) | bytes[avc1 + 29]!;
    const h = (bytes[avc1 + 30]! << 8) | bytes[avc1 + 31]!;
    return { profile: bytes[avcC + 5], w, h };
  });
  expect(r.profile).toBe(0x64); // H.264 High
  expect([r.w, r.h]).toEqual([1920, 1080]);
});
