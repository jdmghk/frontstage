import { describe, expect, test } from "vitest";
import {
  addScene,
  addShot,
  approveTake,
  attachTake,
  dropMediaRefs,
  emptyProduction,
  findShot,
  markNeedsRegen,
  moveScene,
  moveShot,
  ProductionSchema,
  removeCharacter,
  sceneStatus,
  setShotStatus,
  shotReferenceMediaIds,
  syncGeneratingShots,
  replaceDraftShots,
  updateStory,
  updateShot,
  upsertCharacter,
  type Production,
} from "../src/production/production.js";

function twoScenes(): { p: Production; s1: string; s2: string; a: string; b: string; c: string } {
  let p = emptyProduction();
  const r1 = addScene(p, { title: "Opening" });
  const r2 = addScene(r1.production, { title: "Fight" });
  p = r2.production;
  const a = addShot(p, r1.sceneId, { title: "A" });
  const b = addShot(a.production, r1.sceneId, { title: "B" });
  const c = addShot(b.production, r2.sceneId, { title: "C" });
  return { p: c.production, s1: r1.sceneId, s2: r2.sceneId, a: a.shotId!, b: b.shotId!, c: c.shotId! };
}

describe("production schema", () => {
  test("parses an empty object to defaults", () => {
    expect(ProductionSchema.parse({})).toEqual({ version: 1, story: { idea: "", logline: "", outline: "", outlineState: "draft" }, scenes: [], characters: [] });
  });

  test("fills shot defaults and keeps unknown-free round trip", () => {
    const { p } = twoScenes();
    const round = ProductionSchema.parse(JSON.parse(JSON.stringify(p)));
    expect(round).toEqual(p);
    expect(round.scenes[0]!.shots[0]!.status).toBe("draft");
    expect(round.scenes[0]!.shots[0]!.durationSec).toBe(5);
  });

  test("rejects an unknown shot status", () => {
    expect(() => ProductionSchema.parse({ scenes: [{ shots: [{ status: "done" }] }] })).toThrow();
  });
});

describe("scene and shot ops", () => {
  test("addShot to a missing scene is a no-op", () => {
    const p = emptyProduction();
    const r = addShot(p, "nope");
    expect(r.production).toBe(p);
    expect(r.shotId).toBeNull();
  });

  test("moveScene and moveShot reorder; same position returns same reference", () => {
    const { p, s2, a, b } = twoScenes();
    const moved = moveScene(p, s2, 0);
    expect(moved.scenes.map((s) => s.title)).toEqual(["Fight", "Opening"]);
    expect(moveShot(p, a, 0)).toBe(p);
    const swapped = moveShot(p, b, 0);
    expect(swapped.scenes[0]!.shots.map((s) => s.title)).toEqual(["B", "A"]);
  });

  test("updating one shot leaves every other scene and shot object untouched", () => {
    const { p, a } = twoScenes();
    const next = updateShot(p, a, { prompt: "wide establishing shot" });
    expect(next.scenes[0]!.shots[0]!.prompt).toBe("wide establishing shot");
    expect(next.scenes[0]!.shots[1]).toBe(p.scenes[0]!.shots[1]);
    expect(next.scenes[1]).toBe(p.scenes[1]);
  });

  test("failed status keeps the error; other statuses clear it", () => {
    const { p, a } = twoScenes();
    const failed = setShotStatus(p, a, "failed", "quota exceeded");
    expect(findShot(failed, a)!.shot.lastError).toBe("quota exceeded");
    expect(findShot(setShotStatus(failed, a, "ready"), a)!.shot.lastError).toBeUndefined();
  });
});

describe("takes and regeneration", () => {
  test("a new take never changes the approved take or timeline link", () => {
    const { p, a } = twoScenes();
    let next = attachTake(p, a, { mediaId: "m1", provider: "flow-manual" });
    next = approveTake(next, a, "m1");
    next = updateShot(next, a, { timelineClipId: "clip-1" });
    next = markNeedsRegen(next, a, "hands look wrong");
    next = attachTake(next, a, { mediaId: "m2", provider: "fal-veo" });
    const shot = findShot(next, a)!.shot;
    expect(shot.takes.map((t) => t.mediaId)).toEqual(["m1", "m2"]);
    expect(shot.approvedTakeId).toBe("m1");
    expect(shot.timelineClipId).toBe("clip-1");
    expect(shot.status).toBe("generated");
    expect(shot.notes).toBe("hands look wrong");
  });

  test("attaching the same media twice is a no-op", () => {
    const { p, a } = twoScenes();
    const once = attachTake(p, a, { mediaId: "m1" });
    expect(attachTake(once, a, { mediaId: "m1" })).toBe(once);
  });

  test("approving a media that is not a take is refused", () => {
    const { p, a } = twoScenes();
    expect(approveTake(p, a, "stranger")).toBe(p);
  });

  test("regenerating one shot leaves the other scene's shots identical", () => {
    const { p, a, c } = twoScenes();
    const approvedC = approveTake(attachTake(p, c, { mediaId: "mc" }), c, "mc");
    const regen = attachTake(markNeedsRegen(approvedC, a), a, { mediaId: "ma2" });
    expect(regen.scenes[1]).toBe(approvedC.scenes[1]);
  });
});

describe("sceneStatus", () => {
  test("derives empty / in-progress / attention / complete", () => {
    const { p, s1, a, b } = twoScenes();
    const scene = () => p.scenes.find((s) => s.id === s1)!;
    expect(sceneStatus({ ...scene(), shots: [] })).toBe("empty");
    expect(sceneStatus(scene())).toBe("in-progress");
    let done = approveTake(attachTake(p, a, { mediaId: "x" }), a, "x");
    done = approveTake(attachTake(done, b, { mediaId: "y" }), b, "y");
    expect(sceneStatus(done.scenes[0]!)).toBe("complete");
    expect(sceneStatus(markNeedsRegen(done, b).scenes[0]!)).toBe("attention");
  });
});

describe("characters", () => {
  test("removeCharacter strips scene and shot references", () => {
    const { p, s1, a } = twoScenes();
    const { production, characterId } = upsertCharacter(p, { name: "Kai" });
    let next = updateShot(production, a, { characterIds: [characterId] });
    next = { ...next, scenes: next.scenes.map((s) => (s.id === s1 ? { ...s, characterIds: [characterId] } : s)) };
    const removed = removeCharacter(next, characterId);
    expect(removed.characters).toEqual([]);
    expect(removed.scenes[0]!.characterIds).toEqual([]);
    expect(findShot(removed, a)!.shot.characterIds).toEqual([]);
  });

  test("upsert replaces by id", () => {
    const first = upsertCharacter(emptyProduction(), { name: "Kai" });
    const second = upsertCharacter(first.production, { id: first.characterId, name: "Kai", description: "ronin" });
    expect(second.production.characters).toHaveLength(1);
    expect(second.production.characters[0]!.description).toBe("ronin");
  });

  test("shot references prefer approved designs over raw references", () => {
    const { p, a } = twoScenes();
    const kai = upsertCharacter(p, { name: "Kai", referenceMediaIds: ["r1", "r2"], approvedDesignIds: ["d1"] });
    const mei = upsertCharacter(kai.production, { name: "Mei", referenceMediaIds: ["r3"] });
    const next = updateShot(mei.production, a, { referenceMediaIds: ["own"], characterIds: [kai.characterId, mei.characterId] });
    expect(shotReferenceMediaIds(next, findShot(next, a)!.shot)).toEqual(["own", "d1", "r3"]);
  });
});

describe("dropMediaRefs", () => {
  test("removing the approved take's media un-approves the shot", () => {
    const { p, a } = twoScenes();
    const next = approveTake(attachTake(attachTake(p, a, { mediaId: "m1" }), a, { mediaId: "m2" }), a, "m1");
    const dropped = dropMediaRefs(next, new Set(["m1"]));
    const shot = findShot(dropped, a)!.shot;
    expect(shot.takes.map((t) => t.mediaId)).toEqual(["m2"]);
    expect(shot.approvedTakeId).toBeUndefined();
    expect(shot.status).toBe("generated");
  });

  test("unrelated ids return the same reference", () => {
    const { p } = twoScenes();
    expect(dropMediaRefs(p, new Set(["zzz"]))).toBe(p);
  });
});

describe("syncGeneratingShots", () => {
  function generatingShot() {
    let p = emptyProduction();
    const s = addScene(p, { title: "A" });
    p = s.production;
    const sh = addShot(p, s.sceneId, { title: "S" });
    const shotId = sh.shotId!;
    p = attachTake(sh.production, shotId, { mediaId: "m1", provider: "morphic" });
    return { p: setShotStatus(p, shotId, "generating"), shotId };
  }
  const shotOf = (p: Production) => p.scenes[0]!.shots[0]!;

  test("pending media leaves the shot generating (same reference)", () => {
    const { p } = generatingShot();
    expect(syncGeneratingShots(p, () => ({ kind: "pending" }))).toBe(p);
  });

  test("ready media → generated; failed → failed with the provider message", () => {
    const { p } = generatingShot();
    expect(shotOf(syncGeneratingShots(p, () => ({ kind: "ready" }))).status).toBe("generated");
    const failed = shotOf(syncGeneratingShots(p, () => ({ kind: "failed", message: "Content policy" })));
    expect(failed).toMatchObject({ status: "failed", lastError: "Content policy" });
  });

  test("shots that aren't generating are never touched", () => {
    const { p, shotId } = generatingShot();
    const approved = approveTake(p, shotId, "m1");
    expect(syncGeneratingShots(approved, () => ({ kind: "failed", message: "x" }))).toBe(approved);
  });
});

describe("story, dialogue and shot-list replacement", () => {
  test("old production.json (no story/dialogue) still parses with defaults", () => {
    const p = ProductionSchema.parse({ scenes: [{ title: "A", shots: [] }] });
    expect(p.story).toEqual({ idea: "", logline: "", outline: "", outlineState: "draft" });
    expect(p.scenes[0]!.dialogue).toEqual([]);
    expect(p.scenes[0]!.dialogueState).toBe("draft");
  });

  test("replaceDraftShots keeps shots with takes and replaces the rest", () => {
    let p = emptyProduction();
    const s = addScene(p, { title: "A" });
    p = s.production;
    const keep = addShot(p, s.sceneId, { title: "has take" });
    p = attachTake(keep.production, keep.shotId!, { mediaId: "m1" });
    p = addShot(p, s.sceneId, { title: "empty draft" }).production;
    p = replaceDraftShots(p, s.sceneId, [{ title: "new 1", durationSec: 4 }, { title: "new 2" }]);
    expect(p.scenes[0]!.shots.map((x) => x.title)).toEqual(["has take", "new 1", "new 2"]);
    expect(p.scenes[0]!.shots[0]!.id).toBe(keep.shotId);
  });

  test("updateStory merges", () => {
    const p = updateStory(emptyProduction(), { idea: "two rivals on a rooftop" });
    expect(updateStory(p, { logline: "x" }).story).toMatchObject({ idea: "two rivals on a rooftop", logline: "x" });
  });
});
