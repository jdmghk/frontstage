import { describe, expect, test } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { EditorStore, defaultTimeline, findShot, upsertCharacter } from "@frontstage/core";
import { ProductionTab } from "../src/production/ProductionTab.js";
import { CharactersTab } from "../src/production/CharactersTab.js";
import { ProductionStore } from "../src/production/production-store.js";
import { CharacterLibrary, createMemoryCharacterStorage } from "../src/production/character-library.js";
import { fakeProductionLibrary } from "./production-fakes.js";
import type { StudioMorphic } from "../src/production/morphic.js";

function setup() {
  const production = new ProductionStore();
  const library = fakeProductionLibrary();
  const store = new EditorStore(defaultTimeline());
  render(<ProductionTab production={production} library={library} store={store} />);
  return { production, library, store };
}

function firstShotId(production: ProductionStore): string {
  return production.getSnapshot().scenes[0]!.shots[0]!.id;
}

async function addSceneWithShot() {
  fireEvent.click(screen.getByTestId("production-add-scene"));
  fireEvent.click(screen.getByTestId("scene-0-add-shot"));
  fireEvent.click(screen.getByTestId("shot-0-0-toggle"));
}

describe("ProductionTab", () => {
  test("adds a scene and a shot, and edits persist to the store", async () => {
    const { production } = setup();
    expect(screen.getByTestId("production-empty")).toBeTruthy();
    await addSceneWithShot();
    fireEvent.change(screen.getByTestId("shot-0-0-prompt"), { target: { value: "rain-soaked rooftop, wide" } });
    const shot = production.getSnapshot().scenes[0]!.shots[0]!;
    expect(shot.prompt).toBe("rain-soaked rooftop, wide");
    expect(shot.promptState).toBe("draft");
    fireEvent.click(screen.getByTestId("shot-0-0-prompt-approval"));
    expect(production.getSnapshot().scenes[0]!.shots[0]!.promptState).toBe("approved");
    expect(screen.getByTestId("scene-0-status").dataset.status).toBe("in-progress");
  });

  test("editing the script reverts an approved script to draft", async () => {
    const { production } = setup();
    fireEvent.click(screen.getByTestId("production-add-scene"));
    fireEvent.click(screen.getByTestId("scene-0-script-approval"));
    expect(production.getSnapshot().scenes[0]!.scriptState).toBe("approved");
    fireEvent.change(screen.getByTestId("scene-0-script"), { target: { value: "INT. DOJO - NIGHT" } });
    expect(production.getSnapshot().scenes[0]!.scriptState).toBe("draft");
  });

  test("import a take into the shot's folder, approve, place, then replace with a new take", async () => {
    const { production, library, store } = setup();
    await addSceneWithShot();
    const input = screen.getByTestId("shot-0-0-import-input") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { files: [new File(["v1"], "take1.mp4", { type: "video/mp4" })] } });
    });
    await waitFor(() => expect(production.getSnapshot().scenes[0]!.shots[0]!.takes).toHaveLength(1));
    const folders = library.getSnapshot().folders.map((f) => f.name);
    expect(folders).toEqual(["Production", "01 Scene 1", "01 Shot 1"]);
    expect(screen.getByTestId("shot-0-0-place")).toHaveProperty("disabled", true);

    fireEvent.click(screen.getByTestId("shot-0-0-take-0-approve"));
    fireEvent.click(screen.getByTestId("shot-0-0-place"));
    const shotId = firstShotId(production);
    const clipId = findShot(production.getSnapshot(), shotId)!.shot.timelineClipId!;
    expect(store.getSnapshot().timeline.tracks[0]!.clips.map((c) => c.id)).toEqual([clipId]);

    // A regenerated take: attach, approve, replace — the clip id and position stay put.
    await act(async () => {
      fireEvent.change(screen.getByTestId("shot-0-0-import-input"), {
        target: { files: [new File(["v2"], "take2.mp4", { type: "video/mp4" })] },
      });
    });
    await waitFor(() => expect(production.getSnapshot().scenes[0]!.shots[0]!.takes).toHaveLength(2));
    fireEvent.click(screen.getByTestId("shot-0-0-take-1-approve"));
    fireEvent.click(screen.getByTestId("shot-0-0-replace"));
    const clip = store.getSnapshot().timeline.tracks[0]!.clips[0]!;
    expect(clip.id).toBe(clipId);
    expect(clip.mediaRef).toBe(production.getSnapshot().scenes[0]!.shots[0]!.takes[1]!.mediaId);
    expect(clip.startFrame).toBe(0);
  });

  test("flow imports are recorded with their provider", async () => {
    const { production } = setup();
    await addSceneWithShot();
    fireEvent.change(screen.getByTestId("shot-0-0-import-source"), { target: { value: "flow-manual" } });
    await act(async () => {
      fireEvent.change(screen.getByTestId("shot-0-0-import-input"), {
        target: { files: [new File(["v"], "flow.mp4", { type: "video/mp4" })] },
      });
    });
    await waitFor(() => expect(production.getSnapshot().scenes[0]!.shots[0]!.takes[0]?.provider).toBe("flow-manual"));
  });

  test("a take that is still importing can be approved but not placed", async () => {
    const production = new ProductionStore();
    const library = fakeProductionLibrary([], { pendingImports: true });
    render(<ProductionTab production={production} library={library} store={new EditorStore(defaultTimeline())} />);
    await addSceneWithShot();
    await act(async () => {
      fireEvent.change(screen.getByTestId("shot-0-0-import-input"), { target: { files: [new File(["v"], "t.mp4", { type: "video/mp4" })] } });
    });
    fireEvent.click(screen.getByTestId("shot-0-0-take-0-approve"));
    expect(screen.getByTestId("shot-0-0-take-0-pending").textContent).toMatch(/Downloading/);
    expect(screen.getByTestId("shot-0-0-place")).toHaveProperty("disabled", true);
    expect(screen.getByTestId("shot-0-0-pending")).toBeTruthy();
    act(() => library.finishImports());
    expect(screen.getByTestId("shot-0-0-place")).toHaveProperty("disabled", false);
  });

  test("deleting the placed clip turns Replace back into Place", async () => {
    const { production, store } = setup();
    await addSceneWithShot();
    await act(async () => {
      fireEvent.change(screen.getByTestId("shot-0-0-import-input"), { target: { files: [new File(["v"], "t.mp4", { type: "video/mp4" })] } });
    });
    await waitFor(() => expect(production.getSnapshot().scenes[0]!.shots[0]!.takes).toHaveLength(1));
    fireEvent.click(screen.getByTestId("shot-0-0-take-0-approve"));
    fireEvent.click(screen.getByTestId("shot-0-0-place"));
    expect(screen.getByTestId("shot-0-0-replace")).toBeTruthy();
    act(() => store.undo());
    expect(screen.getByTestId("shot-0-0-place")).toBeTruthy();
  });
});

describe("CharactersTab", () => {
  test("adds a character, edits appearance, adds references and marks a design", async () => {
    const production = new ProductionStore();
    const library = fakeProductionLibrary();
    render(<CharactersTab production={production} library={library} />);
    fireEvent.click(screen.getByTestId("characters-add"));
    fireEvent.change(screen.getByTestId("character-0-hair"), { target: { value: "silver braid" } });
    expect(production.getSnapshot().characters[0]!.appearance.hair).toBe("silver braid");
    await act(async () => {
      fireEvent.change(screen.getByTestId("character-0-refs-input"), {
        target: { files: [new File(["i"], "front.png", { type: "image/png" })] },
      });
    });
    await waitFor(() => expect(production.getSnapshot().characters[0]!.referenceMediaIds).toHaveLength(1));
    expect(library.getSnapshot().folders.map((f) => f.name)).toEqual(["Characters", "Character 1"]);
    fireEvent.click(screen.getByTestId("character-0-ref-0-design"));
    const c = production.getSnapshot().characters[0]!;
    expect(c.approvedDesignIds).toEqual(c.referenceMediaIds);
  });

  test("library actions are hidden without a character library, and round-trip with one", async () => {
    const production = new ProductionStore();
    production.update((p) => upsertCharacter(p, { name: "Kai" }).production);
    const library = fakeProductionLibrary();
    const characterLibrary = new CharacterLibrary(createMemoryCharacterStorage());
    const { unmount } = render(<CharactersTab production={production} library={library} />);
    expect(screen.queryByTestId("characters-open-library")).toBeNull();
    unmount();

    render(<CharactersTab production={production} library={library} characterLibrary={characterLibrary} />);
    await act(async () => fireEvent.click(screen.getByTestId("character-0-save-library")));
    await waitFor(() => expect(production.getSnapshot().characters[0]!.libraryId).toBeTruthy());

    await act(async () => fireEvent.click(screen.getByTestId("characters-open-library")));
    const id = production.getSnapshot().characters[0]!.libraryId!;
    await act(async () => fireEvent.click(screen.getByTestId(`characters-library-add-${id}`)));
    expect(screen.getByTestId("characters-message").textContent).toMatch(/already in this project/);
  });
});

describe("Morphic actions", () => {
  function setupMorphic(result: (lib: ReturnType<typeof fakeProductionLibrary>) => Promise<{ placeholderId: string; projectName: string } | { error: string }>) {
    const production = new ProductionStore();
    const library = fakeProductionLibrary();
    production.attachLibrary(library);
    const calls: string[] = [];
    const morphic: StudioMorphic = {
      account: { isSignedIn: async () => true, signIn: async () => {}, signOut: async () => {} },
      generateShotTake: async (_p, _scene, shot, opts) => (calls.push(`shot:${shot.id}:${opts.name}`), result(library)),
      generateCharacterDesign: async (c, opts) => (calls.push(`design:${c.name}:${opts.name}`), result(library)),
    };
    return { production, library, morphic, calls };
  }

  test("shot: generating until the take lands, then generated; the take is recorded as Morphic", async () => {
    const { production, library, morphic, calls } = setupMorphic(async (lib) => ({ placeholderId: lib.addPlaceholder("t", "video").id, projectName: "Rooftop" }));
    render(<ProductionTab production={production} library={library} morphic={morphic} />);
    await addSceneWithShot();
    await act(async () => fireEvent.click(screen.getByTestId("shot-0-0-morphic")));
    const shot = () => production.getSnapshot().scenes[0]!.shots[0]!;
    expect(calls[0]).toMatch(/^shot:.+:01 Shot 1 · Morphic take 1$/);
    expect(shot().status).toBe("generating");
    expect(shot().takes[0]).toMatchObject({ provider: "morphic" });
    expect(screen.getByTestId("shot-0-0-message").textContent).toContain('project "Rooftop"');
    expect((screen.getByTestId("shot-0-0-morphic") as HTMLButtonElement).disabled).toBe(true);
    act(() => library.finishImports());
    expect(shot().status).toBe("generated");
  });

  test("shot: a failed generation marks the shot failed with Morphic's message", async () => {
    const { production, library, morphic } = setupMorphic(async (lib) => ({ placeholderId: lib.addPlaceholder("t", "video").id, projectName: "" }));
    render(<ProductionTab production={production} library={library} morphic={morphic} />);
    await addSceneWithShot();
    await act(async () => fireEvent.click(screen.getByTestId("shot-0-0-morphic")));
    const id = production.getSnapshot().scenes[0]!.shots[0]!.takes[0]!.mediaId;
    act(() => library.failEntry(id, "Content policy"));
    expect(production.getSnapshot().scenes[0]!.shots[0]!).toMatchObject({ status: "failed", lastError: "Content policy" });
    expect(screen.getByTestId("shot-0-0-error").textContent).toBe("Content policy");
  });

  test("shot: a refused start changes nothing and shows the reason", async () => {
    const { production, library, morphic } = setupMorphic(async () => ({ error: "Sign in to Morphic first (Settings → Generation)." }));
    render(<ProductionTab production={production} library={library} morphic={morphic} />);
    await addSceneWithShot();
    await act(async () => fireEvent.click(screen.getByTestId("shot-0-0-morphic")));
    expect(production.getSnapshot().scenes[0]!.shots[0]!).toMatchObject({ status: "draft", takes: [] });
    expect(screen.getByTestId("shot-0-0-message").textContent).toContain("Sign in to Morphic first");
  });

  test("no Morphic host → no Morphic buttons", async () => {
    setup();
    await addSceneWithShot();
    expect(screen.queryByTestId("shot-0-0-morphic")).toBeNull();
  });

  test("character: the new design is added as a reference, not auto-approved", async () => {
    const { production, library, morphic, calls } = setupMorphic(async (lib) => ({ placeholderId: lib.addPlaceholder("d", "image").id, projectName: "" }));
    production.update((p) => upsertCharacter(p, { name: "Kai" }).production);
    render(<CharactersTab production={production} library={library} morphic={morphic} />);
    await act(async () => fireEvent.click(screen.getByTestId("character-0-morphic")));
    expect(calls).toEqual(["design:Kai:Kai design 1"]);
    const kai = production.getSnapshot().characters[0]!;
    expect(kai.referenceMediaIds).toHaveLength(1);
    expect(kai.approvedDesignIds).toEqual([]);
    expect(screen.getByTestId("character-0-ref-0-pending")).toBeTruthy();
    expect(library.getSnapshot().folders.map((f) => f.name)).toEqual(["Characters", "Kai"]);
  });
});
