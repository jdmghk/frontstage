import { describe, expect, test } from "vitest";
import { upsertCharacter, emptyProduction } from "@frontstage/core";
import { CharacterLibrary, createMemoryCharacterStorage } from "../src/production/character-library.js";
import { fakeProductionLibrary } from "./production-fakes.js";

describe("CharacterLibrary", () => {
  test("save from one project and import into another copies images and keeps approvals", async () => {
    const storage = createMemoryCharacterStorage();
    const lib = new CharacterLibrary(storage);
    const projectA = fakeProductionLibrary();
    const [ref, design] = await projectA.importFiles([
      new File(["a"], "front.png", { type: "image/png" }),
      new File(["b"], "turnaround.png", { type: "image/png" }),
    ]);
    const kai = upsertCharacter(emptyProduction(), {
      name: "Kai",
      description: "ronin",
      appearance: { ageRange: "30s", hair: "topknot", clothing: "", build: "", other: "" },
      referenceMediaIds: [ref!.id, design!.id],
      approvedDesignIds: [design!.id],
    }).production.characters[0]!;

    const saved = await lib.saveFromProject(kai, projectA);
    expect(saved.images.map((i) => [i.file, i.approved])).toEqual([["ref-1.png", false], ["ref-2.png", true]]);

    const listed = await lib.list();
    expect(listed.map((c) => c.name)).toEqual(["Kai"]);

    const projectB = fakeProductionLibrary();
    const init = await lib.importIntoProject(listed[0]!, projectB, "folder-1");
    expect(init.libraryId).toBe(saved.id);
    expect(init.appearance?.hair).toBe("topknot");
    expect(init.referenceMediaIds).toHaveLength(2);
    expect(init.approvedDesignIds).toEqual([init.referenceMediaIds![1]]);
    expect(projectB.getSnapshot().entries.every((e) => e.folderId === "folder-1")).toBe(true);
  });

  test("re-saving a library character overwrites the same entry", async () => {
    const lib = new CharacterLibrary(createMemoryCharacterStorage());
    const project = fakeProductionLibrary();
    const c = upsertCharacter(emptyProduction(), { name: "Mei" }).production.characters[0]!;
    const first = await lib.saveFromProject(c, project);
    await lib.saveFromProject({ ...c, libraryId: first.id, description: "updated" }, project);
    const all = await lib.list();
    expect(all).toHaveLength(1);
    expect(all[0]!.description).toBe("updated");
  });

  test("corrupt entries are skipped, not fatal", async () => {
    const storage = createMemoryCharacterStorage();
    await storage.writeFile("broken", "character.json", new TextEncoder().encode("{nope"));
    expect(await new CharacterLibrary(storage).list()).toEqual([]);
  });

  test("non-image references are not saved", async () => {
    const lib = new CharacterLibrary(createMemoryCharacterStorage());
    const project = fakeProductionLibrary();
    const [clip] = await project.importFiles([new File(["v"], "walk.mp4", { type: "video/mp4" })]);
    const c = upsertCharacter(emptyProduction(), { name: "Kai", referenceMediaIds: [clip!.id] }).production.characters[0]!;
    expect((await lib.saveFromProject(c, project)).images).toEqual([]);
  });
});
