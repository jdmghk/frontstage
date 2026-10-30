import { describe, expect, test } from "vitest";
import {
  addChoreography,
  addScene,
  approveChoreographyToScene,
  emptyProduction,
  ProductionSchema,
  setChoreoShots,
  updateChoreoShot,
  upsertCharacter,
  type Production,
} from "../src/index.js";

const NOW = () => "2026-10-30T00:00:00.000Z";

function setup() {
  let p: Production = emptyProduction();
  const kai = upsertCharacter(p, { name: "Kai" });
  p = kai.production;
  const s = addScene(p, { title: "Duel" });
  p = s.production;
  const c = addChoreography(p, { title: "Rooftop ref", referenceMediaId: "vid1", permission: { attested: true, note: "my own footage" } }, NOW);
  if ("error" in c) throw new Error(c.error);
  return { p: c.production, id: c.choreographyId, sceneId: s.sceneId, kaiId: kai.characterId };
}

describe("choreography", () => {
  test("needs the permission attestation", () => {
    expect(addChoreography(emptyProduction(), { title: "x", referenceMediaId: "v", permission: { attested: false } })).toEqual({
      error: "Confirm you own this video or have permission to use it as a reference.",
    });
  });

  test("records permission with a date and survives a save round trip", () => {
    const { p } = setup();
    expect(p.choreographies[0]!.permission).toEqual({ attested: true, note: "my own footage", date: NOW() });
    expect(ProductionSchema.parse(JSON.parse(JSON.stringify(p)))).toEqual(p);
  });

  test("editing a plan returns it to draft", () => {
    let { p, id } = setup();
    p = setChoreoShots(p, id, [{ action: "jab", durationSec: 2 }]);
    p = { ...p, choreographies: p.choreographies.map((c) => ({ ...c, state: "approved" as const })) };
    p = updateChoreoShot(p, id, p.choreographies[0]!.shots[0]!.id, { camera: "low" });
    expect(p.choreographies[0]).toMatchObject({ state: "draft", shots: [{ camera: "low", action: "jab" }] });
  });

  test("approve appends shots to the chosen scene with cast matched by name", () => {
    let { p, id, sceneId, kaiId } = setup();
    p = setChoreoShots(p, id, [
      { action: "Kai ducks a hook, counters with an elbow", durationSec: 3, characters: ["kai", "Mira"], startPositions: "facing, 2 m apart", impactTimesSec: [1.2], camera: "handheld", framing: "medium", prompt: "p1", continuity: "torn sleeve" },
      { action: "Spinning kick", durationSec: 2 },
    ]);
    const r = approveChoreographyToScene(p, id, sceneId);
    if ("error" in r) throw new Error(r.error);
    expect(r.added).toBe(2);
    const shots = r.production.scenes[0]!.shots;
    expect(shots[0]).toMatchObject({ title: "Kai ducks a hook", durationSec: 3, characterIds: [kaiId], camera: "handheld", prompt: "p1", notes: "torn sleeve", status: "draft" });
    expect(shots[0]!.description).toContain("Start: facing, 2 m apart");
    expect(shots[0]!.description).toContain("Impacts at 1.2s");
    expect(r.production.choreographies[0]).toMatchObject({ state: "approved", sceneId });
  });

  test("approve refuses an empty plan or a missing scene", () => {
    const { p, id, sceneId } = setup();
    expect(approveChoreographyToScene(p, id, sceneId)).toEqual({ error: "Analyze the reference or add shots first." });
    const withShot = setChoreoShots(p, id, [{ action: "x" }]);
    expect(approveChoreographyToScene(withShot, id, "nope")).toEqual({ error: "Choose a scene." });
  });
});
