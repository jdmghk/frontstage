import { _electron as electron, test, expect } from "@playwright/test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// A 1x1 PNG: enough for a character reference image.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

test("Production + Characters: production.json on disk and the cross-project character library", async () => {
  const projectDir = mkdtempSync(path.join(os.tmpdir(), "frontstage-production-"));
  // The character library lives under ~/.frontstage/characters — point HOME at a temp dir so the
  // test never touches the real one.
  const home = mkdtempSync(path.join(os.tmpdir(), "frontstage-home-"));

  const app = await electron.launch({
    args: [path.join(__dirname, "../src/main/index.cjs")],
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, HOME: home, RENDERER_PORT: "5190", FRONTSTAGE_E2E: "1" },
  });

  try {
    const page = await app.firstWindow();
    page.on("pageerror", (err) => console.error("[renderer pageerror]", err.message));
    await page.waitForSelector('[data-testid="top-bar-title"]', { timeout: 30_000 });
    await page.waitForFunction(() => (window as any).__projectSession && (window as any).desktopCharacters, { timeout: 15_000 });

    await page.getByTestId("media-tab-production").click();
    await page.getByTestId("production-add-scene").click();
    await page.getByTestId("scene-0-title").fill("Rooftop duel");
    await page.getByTestId("scene-0-add-shot").click();

    await page.getByTestId("media-tab-characters").click();
    await page.getByTestId("characters-add").click();
    await page.getByTestId("character-0-name").fill("Kai");
    await page.getByTestId("character-0-refs-input").setInputFiles({ name: "kai.png", mimeType: "image/png", buffer: PNG });
    await expect(page.getByTestId("character-0-ref-0")).toBeVisible({ timeout: 10_000 });

    // Save to the cross-project library (desktop: ~/.frontstage/characters via IPC).
    await page.getByTestId("character-0-save-library").click();
    await expect(page.getByTestId("character-0-message")).toContainText("Saved to library", { timeout: 10_000 });
    const charRoot = path.join(home, ".frontstage", "characters");
    const ids = readdirSync(charRoot);
    expect(ids).toHaveLength(1);
    const record = JSON.parse(readFileSync(path.join(charRoot, ids[0]!, "character.json"), "utf8"));
    expect(record.name).toBe("Kai");
    expect(record.images).toHaveLength(1);
    expect(existsSync(path.join(charRoot, ids[0]!, record.images[0].file))).toBe(true);

    // Save As writes production.json beside project.json.
    await page.evaluate(async (dir: string) => (window as any).desktopProject.__setNextPick(dir), projectDir);
    // macOS uses the native File menu (no in-app one), so drive Save As through the session.
    await page.evaluate(() => (window as any).__projectSession.saveAs());
    await expect.poll(() => existsSync(path.join(projectDir, "production.json")), { timeout: 15_000 }).toBe(true);
    const saved = JSON.parse(readFileSync(path.join(projectDir, "production.json"), "utf8"));
    expect(saved.scenes[0].title).toBe("Rooftop duel");
    expect(saved.scenes[0].shots).toHaveLength(1);
    expect(saved.characters[0].libraryId).toBe(ids[0]);

    // A fresh project can pull Kai back out of the library, images included.
    await page.evaluate(() => (window as any).__projectSession.newProject(async () => true));
    await page.getByTestId("media-tab-characters").click();
    await page.getByTestId("characters-open-library").click();
    await page.getByTestId(`characters-library-add-${ids[0]}`).click();
    await expect(page.getByTestId("character-0-name")).toHaveValue("Kai");
    await expect(page.getByTestId("character-0-ref-0")).toBeVisible({ timeout: 10_000 });
  } finally {
    await app.close();
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
