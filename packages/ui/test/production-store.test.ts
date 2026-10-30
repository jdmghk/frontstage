import { describe, expect, test, vi } from "vitest";
import { addScene, addShot, approveTake, attachTake, emptyProduction, findShot, upsertCharacter } from "@frontstage/core";
import { ProductionStore, ensureFolderPath, numbered } from "../src/production/production-store.js";
import { createEditorHost } from "../src/editor/editor-host.js";
import { EditorStore, defaultTimeline, emptyMediaManifest, emptyGenerationLog, InMemoryProjectGateway } from "@frontstage/core";
import { MediaLibrary } from "../src/media/media-library.js";
import { fakeProductionLibrary } from "./production-fakes.js";

describe("ProductionStore", () => {
  test("update notifies; a same-reference result does not", () => {
    const s = new ProductionStore();
    const cb = vi.fn();
    s.subscribe(cb);
    s.update((p) => p);
    expect(cb).not.toHaveBeenCalled();
    s.update((p) => addScene(p).production);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  test("deleting a library asset drops it from takes and character references", async () => {
    const lib = fakeProductionLibrary();
    const s = new ProductionStore();
    s.attachLibrary(lib);
    await lib.importFiles([new File(["a"], "a.mp4", { type: "video/mp4" }), new File(["b"], "b.png", { type: "image/png" })]);
    const [a, b] = lib.getSnapshot().entries;
    let shotId = "";
    s.update((p) => {
      const sc = addScene(p);
      const sh = addShot(sc.production, sc.sceneId);
      shotId = sh.shotId!;
      const withTake = approveTake(attachTake(sh.production, shotId, { mediaId: a!.id }), shotId, a!.id);
      return upsertCharacter(withTake, { name: "Kai", referenceMediaIds: [b!.id] }).production;
    });
    lib.deleteEntries([a!.id, b!.id]);
    const p = s.getSnapshot();
    expect(findShot(p, shotId)!.shot.takes).toEqual([]);
    expect(findShot(p, shotId)!.shot.approvedTakeId).toBeUndefined();
    expect(p.characters[0]!.referenceMediaIds).toEqual([]);
  });
});

describe("ensureFolderPath", () => {
  test("creates the chain once and reuses it", () => {
    const lib = fakeProductionLibrary();
    const leaf = ensureFolderPath(lib, ["Production", numbered(0, "Opening", "Scene"), numbered(1, "", "Shot")]);
    expect(lib.getSnapshot().folders.map((f) => f.name)).toEqual(["Production", "01 Opening", "02 Shot"]);
    expect(ensureFolderPath(lib, ["Production", "01 Opening", "02 Shot"])).toBe(leaf);
    expect(lib.getSnapshot().folders).toHaveLength(3);
  });
});

describe("editor host", () => {
  test("production loads from the doc and new projects start empty", () => {
    const store = new EditorStore(defaultTimeline());
    const { host, production } = createEditorHost(store, new MediaLibrary(), new InMemoryProjectGateway());
    const scene = addScene(emptyProduction(), { title: "Opening" }).production;
    host.loadDoc({ timeline: defaultTimeline(), manifest: emptyMediaManifest(), generationLog: emptyGenerationLog(), production: scene });
    expect(production.getSnapshot()).toBe(scene);
    expect(host.getProduction!()).toBe(scene);
    host.loadDoc({ timeline: defaultTimeline(), manifest: emptyMediaManifest(), generationLog: emptyGenerationLog() });
    expect(production.getSnapshot()).toEqual(emptyProduction());
  });
});
