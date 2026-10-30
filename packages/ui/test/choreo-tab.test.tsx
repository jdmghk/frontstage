import { describe, expect, test } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { addScene, upsertCharacter } from "@frontstage/core";
import { ChoreoTab, type FrameSampler } from "../src/production/ChoreoTab.js";
import { ProductionStore } from "../src/production/production-store.js";
import type { StudioWriter } from "../src/production/writer-ui.js";
import { fakeProductionLibrary } from "./production-fakes.js";

const PLAN = {
  shots: [
    { durationSec: 3, characters: ["Kai"], startPositions: "2 m apart", action: "Kai slips a jab, counters", camera: "handheld", framing: "medium", transitions: "cut on impact", impactTimesSec: [1.5], continuity: "rain", prompt: "p1" },
    { durationSec: 2, characters: ["Kai"], startPositions: "close", action: "Spinning kick", camera: "low", framing: "wide", transitions: "", impactTimesSec: [], continuity: "", prompt: "p2" },
  ],
};

function setup(opts: { writer?: StudioWriter; sampler?: FrameSampler } = {}) {
  const production = new ProductionStore();
  const library = fakeProductionLibrary();
  production.update((p) => addScene(upsertCharacter(p, { name: "Kai" }).production, { title: "Duel" }).production);
  render(<ChoreoTab production={production} library={library} writer={opts.writer} sampleFrames={opts.sampler} />);
  return { production, library };
}

async function addReference(permission: boolean) {
  fireEvent.click(screen.getByTestId("choreo-add"));
  await act(async () => {
    fireEvent.change(screen.getByTestId("choreo-new-file"), { target: { files: [new File(["v"], "ref.mp4", { type: "video/mp4" })] } });
  });
  if (permission) fireEvent.click(screen.getByTestId("choreo-new-permission"));
  await act(async () => fireEvent.click(screen.getByTestId("choreo-new-create")));
}

describe("ChoreoTab", () => {
  test("says plainly that motion guidance isn't an exact copy", () => {
    setup();
    expect(screen.getByTestId("choreo-disclaimer").textContent).toContain("it isn't an exact copy");
  });

  test("a reference can't be added without the permission confirmation", async () => {
    const { production } = setup();
    await addReference(false);
    expect((screen.getByTestId("choreo-new-create") as HTMLButtonElement).disabled).toBe(true);
    expect(production.getSnapshot().choreographies).toEqual([]);
  });

  test("analyze → editable draft plan → approve adds the shots to the scene", async () => {
    const asked: number[] = [];
    const writer: StudioWriter = { gateway: { run: async (req) => (asked.push(req.images?.length ?? 0), { ok: true, json: PLAN }), hasKey: async () => true }, model: () => "claude-opus-5-5" };
    const sampler: FrameSampler = async () => ({ frames: [0, 0.5, 1].map((t) => ({ timeSec: t, mediaType: "image/jpeg" as const, base64: "AA" })) });
    const { production } = setup({ writer, sampler });
    await addReference(true);
    await act(async () => fireEvent.click(screen.getByTestId("choreo-0-analyze")));
    expect(asked).toEqual([3]);
    expect(production.getSnapshot().choreographies[0]).toMatchObject({ state: "draft", shots: [{ action: "Kai slips a jab, counters" }, { action: "Spinning kick" }] });
    fireEvent.change(screen.getByTestId("choreo-0-shot-1-camera"), { target: { value: "crane down" } });
    expect(production.getSnapshot().choreographies[0]!.shots[1]!.camera).toBe("crane down");
    fireEvent.click(screen.getByTestId("choreo-0-approve"));
    const p = production.getSnapshot();
    expect(p.scenes[0]!.shots.map((s) => s.camera)).toEqual(["handheld", "crane down"]);
    expect(p.scenes[0]!.shots[0]!.characterIds).toEqual([p.characters[0]!.id]);
    expect(p.choreographies[0]!.state).toBe("approved");
  });

  test("a frame-sampling failure is shown and Claude is not called", async () => {
    let called = false;
    const writer: StudioWriter = { gateway: { run: async () => ((called = true), { ok: true, json: PLAN }), hasKey: async () => true }, model: () => "claude-opus-5-5" };
    setup({ writer, sampler: async () => ({ error: "Save the project first so the reference video is on disk." }) });
    await addReference(true);
    await act(async () => fireEvent.click(screen.getByTestId("choreo-0-analyze")));
    expect(called).toBe(false);
    expect(screen.getByTestId("choreo-0-message").textContent).toContain("Save the project first");
  });
});
