import { describe, expect, test } from "vitest";
import {
  addScene,
  addVoiceProfile,
  approveLineTake,
  attachLineTake,
  dropMediaRefs,
  emptyProduction,
  findLine,
  removeVoiceProfile,
  setCharacterVoice,
  setNarratorVoice,
  syncGeneratingLines,
  updateScene,
  upsertCharacter,
  voiceForLine,
  type Production,
} from "../src/index.js";

const NOW = () => "2026-10-30T00:00:00.000Z";

function withVoice() {
  let p: Production = emptyProduction();
  const kai = upsertCharacter(p, { name: "Kai" });
  p = kai.production;
  const v = addVoiceProfile(p, { name: "Kai voice", referenceMediaId: "ref1", consent: { attested: true, note: "my own voice" } }, NOW);
  if ("error" in v) throw new Error(v.error);
  p = setCharacterVoice(v.production, kai.characterId, v.voiceId);
  const s = addScene(p, { title: "A" });
  p = updateScene(s.production, s.sceneId, {
    dialogue: [
      { id: "l1", speaker: kai.characterId, text: "You owe me.", direction: "", takes: [], status: "draft" },
      { id: "l2", speaker: "narrator", text: "Midnight.", direction: "", takes: [], status: "draft" },
    ],
  });
  return { p, voiceId: v.voiceId, kaiId: kai.characterId };
}

describe("voice profiles", () => {
  test("refused without the consent attestation", () => {
    const r = addVoiceProfile(emptyProduction(), { name: "x", referenceMediaId: "r", consent: { attested: false } });
    expect(r).toEqual({ error: "Confirm that this is your voice or that you have the speaker's permission." });
  });

  test("records consent with a date and the note", () => {
    const { p } = withVoice();
    expect(p.voices[0]).toMatchObject({ name: "Kai voice", language: "english", expressiveness: 0.5, consent: { attested: true, note: "my own voice", date: NOW() } });
  });

  test("a line's voice comes from its character or the narrator", () => {
    const { p, voiceId } = withVoice();
    expect(voiceForLine(p, findLine(p, "l1")!.line)?.id).toBe(voiceId);
    expect(voiceForLine(p, findLine(p, "l2")!.line)).toBeUndefined();
    expect(voiceForLine(setNarratorVoice(p, voiceId), findLine(p, "l2")!.line)?.id).toBe(voiceId);
  });

  test("removing a voice unlinks it but keeps recorded takes", () => {
    let { p, voiceId } = withVoice();
    p = attachLineTake(setNarratorVoice(p, voiceId), "l1", "t1");
    const next = removeVoiceProfile(p, voiceId);
    expect(next.voices).toEqual([]);
    expect(next.narratorVoiceId).toBeUndefined();
    expect(next.characters[0]!.voiceProfileId).toBeUndefined();
    expect(findLine(next, "l1")!.line.takes).toEqual(["t1"]);
  });

  test("deleting the reference recording removes the voice", () => {
    const { p } = withVoice();
    const next = dropMediaRefs(p, new Set(["ref1"]));
    expect(next.voices).toEqual([]);
    expect(next.characters[0]!.voiceProfileId).toBeUndefined();
  });
});

describe("line takes", () => {
  test("regenerating one line keeps its other takes and leaves the other lines alone", () => {
    let { p } = withVoice();
    p = attachLineTake(p, "l1", "t1");
    p = syncGeneratingLines(p, () => ({ kind: "ready" }));
    p = approveLineTake(p, "l1", "t1");
    const other = findLine(p, "l2")!.line;
    p = attachLineTake(p, "l1", "t2");
    expect(findLine(p, "l1")!.line).toMatchObject({ takes: ["t1", "t2"], approvedTakeId: "t1", status: "generating" });
    expect(findLine(p, "l2")!.line).toBe(other);
    p = syncGeneratingLines(p, () => ({ kind: "ready" }));
    expect(findLine(p, "l1")!.line.status).toBe("approved");
  });

  test("a failed generation marks the line failed with the message", () => {
    let { p } = withVoice();
    p = attachLineTake(p, "l1", "t1");
    p = syncGeneratingLines(p, () => ({ kind: "failed", message: "Invalid reference audio" }));
    expect(findLine(p, "l1")!.line).toMatchObject({ status: "failed", lastError: "Invalid reference audio" });
  });

  test("deleting the approved take drops the approval", () => {
    let { p } = withVoice();
    p = approveLineTake(attachLineTake(p, "l1", "t1"), "l1", "t1");
    expect(findLine(dropMediaRefs(p, new Set(["t1"])), "l1")!.line).toMatchObject({ takes: [], approvedTakeId: undefined, status: "draft" });
  });
});
