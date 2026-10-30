import { describe, expect, test } from "vitest";
import type { Production } from "@frontstage/core";
import { addScene, addShot, attachTake, emptyProduction, upsertCharacter, updateStory } from "@frontstage/core";
import {
  charactersTask,
  continuityTask,
  dialogueTask,
  outlineTask,
  productionContext,
  runWriterTask,
  sceneScriptTask,
  shotListTask,
  shotPromptTask,
  type ClaudeGateway,
  type ClaudeStudioRequest,
  type ClaudeStudioResult,
} from "../src/studio/writer.js";
import { buildFlowPack } from "../src/studio/flow-handoff.js";

function gateway(result: ClaudeStudioResult) {
  const seen: ClaudeStudioRequest[] = [];
  const gw: ClaudeGateway = { run: async (r) => (seen.push(r), result), hasKey: async () => true };
  return { gw, seen };
}

function fixture() {
  let p: Production = updateStory(emptyProduction(), { idea: "Two rivals settle a debt on a rain-soaked rooftop" });
  const kai = upsertCharacter(p, { name: "Kai", description: "street fighter", appearance: { ageRange: "late 20s", hair: "", clothing: "", build: "", other: "" } });
  p = kai.production;
  const s = addScene(p, { title: "Rooftop duel", synopsis: "Kai faces Mira", characterIds: [kai.characterId] });
  p = s.production;
  const sh = addShot(p, s.sceneId, { title: "Kick", description: "Kai spins", characterIds: [kai.characterId] });
  p = sh.production;
  return { p, kaiId: kai.characterId, sceneId: s.sceneId, shotId: sh.shotId! };
}
const sceneOf = (p: Production) => p.scenes[0]!;

describe("requests", () => {
  test("every task asks for strict JSON: object schema, all keys required, no extra keys", () => {
    const { p } = fixture();
    const scene = sceneOf(p);
    const tasks = [outlineTask(p), sceneScriptTask(p, scene), charactersTask(p), shotListTask(p, scene), shotPromptTask(p, scene, scene.shots[0]!), dialogueTask(p, scene), continuityTask(p, scene)];
    const check = (s: Record<string, unknown>) => {
      if (s.type === "object") {
        expect(s.additionalProperties).toBe(false);
        expect(s.required).toEqual(Object.keys(s.properties as object));
        for (const v of Object.values(s.properties as Record<string, Record<string, unknown>>)) check(v);
      }
      if (s.type === "array") check(s.items as Record<string, unknown>);
    };
    for (const t of tasks) {
      expect(t.request.model).toBe("claude-opus-5-5");
      check(t.request.schema);
    }
  });

  test("context carries the idea, cast and scene list", () => {
    const { p } = fixture();
    const ctx = productionContext(p);
    expect(ctx).toContain("rain-soaked rooftop");
    expect(ctx).toContain("- Kai: street fighter [late 20s]");
    expect(ctx).toContain("1. Rooftop duel: Kai faces Mira");
  });
});

describe("runWriterTask", () => {
  test("a refusal or API error comes back as the gateway's message and changes nothing", async () => {
    const { p } = fixture();
    const { gw } = gateway({ ok: false, kind: "refusal", error: "Claude declined this request" });
    expect(await runWriterTask(gw, sceneScriptTask(p, sceneOf(p)), () => p)).toEqual({ error: "Claude declined this request" });
  });

  test("a reply in the wrong shape is rejected", async () => {
    const { p } = fixture();
    const { gw } = gateway({ ok: true, json: { scenes: "nope" } });
    const r = await runWriterTask(gw, outlineTask(p), () => p);
    expect("error" in r && r.error).toMatch(/didn't match the expected shape/);
  });

  test("applies to the latest production, not the one the task was built from", async () => {
    const { p } = fixture();
    const later = { ...p, story: { ...p.story, logline: "edited meanwhile" } };
    const { gw } = gateway({ ok: true, json: { script: "INT. ROOF - NIGHT" } });
    const r = await runWriterTask(gw, sceneScriptTask(p, sceneOf(p)), () => later);
    if ("error" in r) throw new Error(r.error);
    expect(r.production.story.logline).toBe("edited meanwhile");
    expect(sceneOf(r.production)).toMatchObject({ script: "INT. ROOF - NIGHT", scriptState: "draft" });
  });
});

describe("apply rules", () => {
  test("outline creates scenes only when there are none", () => {
    const reply = { logline: "L", outline: "O", scenes: [{ title: "A", synopsis: "a" }, { title: "B", synopsis: "b" }] };
    const fresh = outlineTask(emptyProduction()).apply(emptyProduction(), reply);
    expect(fresh.scenes.map((s) => s.title)).toEqual(["A", "B"]);
    const { p } = fixture();
    const kept = outlineTask(p).apply(p, reply);
    expect(kept.scenes.map((s) => s.title)).toEqual(["Rooftop duel"]);
    expect(kept.story).toMatchObject({ logline: "L", outline: "O", outlineState: "draft" });
  });

  test("shot list keeps shots with takes and maps names to cast", () => {
    let { p, shotId } = fixture();
    p = attachTake(p, shotId, { mediaId: "m1" });
    const reply = { shots: [{ title: "Wide", description: "d", durationSec: 70, camera: "crane", framing: "wide", characters: ["kai", "Nobody"] }] };
    const next = shotListTask(p, sceneOf(p)).apply(p, reply);
    const shots = sceneOf(next).shots;
    expect(shots.map((s) => s.title)).toEqual(["Kick", "Wide"]);
    expect(shots[1]).toMatchObject({ durationSec: 60, characterIds: [p.characters[0]!.id] });
  });

  test("characters: new ones added, existing ones only get empty fields filled", () => {
    const { p } = fixture();
    const reply = {
      characters: [
        { name: "KAI", description: "ignored", ageRange: "ignored", hair: "black topknot", clothing: "", build: "", other: "", continuityNotes: "" },
        { name: "Mira", description: "rival", ageRange: "30s", hair: "", clothing: "red coat", build: "", other: "", continuityNotes: "coat always red" },
      ],
    };
    const next = charactersTask(p).apply(p, reply);
    expect(next.characters).toHaveLength(2);
    expect(next.characters[0]).toMatchObject({ name: "Kai", description: "street fighter", appearance: { ageRange: "late 20s", hair: "black topknot" } });
    expect(next.characters[1]).toMatchObject({ name: "Mira", appearance: { clothing: "red coat" }, continuityNotes: "coat always red" });
  });

  test("dialogue maps Narrator and known names; unknown speakers keep their name", () => {
    const { p, kaiId } = fixture();
    const next = dialogueTask(p, sceneOf(p)).apply(p, {
      lines: [
        { speaker: "Narrator", text: "Midnight.", direction: "low" },
        { speaker: "kai", text: "You owe me.", direction: "cold" },
        { speaker: "Stranger", text: "Hey!", direction: "" },
      ],
    });
    expect(sceneOf(next).dialogue.map((l) => l.speaker)).toEqual(["narrator", kaiId, "Stranger"]);
    expect(sceneOf(next).dialogueState).toBe("draft");
  });

  test("continuity: scene notes replaced, character notes appended once", () => {
    const { p } = fixture();
    const t = continuityTask(p, sceneOf(p));
    const reply = { sceneNotes: "Night, rain", characterNotes: [{ name: "Kai", note: "cut on left cheek" }] };
    const once = t.apply(p, reply);
    const twice = t.apply(once, reply);
    expect(sceneOf(twice).continuityNotes).toBe("Night, rain");
    expect(twice.characters[0]!.continuityNotes).toBe("cut on left cheek");
  });

  test("shot prompt sets a draft prompt on that shot only", () => {
    const { p } = fixture();
    const scene = sceneOf(p);
    const next = shotPromptTask(p, scene, scene.shots[0]!).apply(p, { prompt: "Low angle, rain, a man in a grey gi spins" });
    expect(sceneOf(next).shots[0]).toMatchObject({ prompt: "Low angle, rain, a man in a grey gi spins", promptState: "draft" });
    expect(next.characters).toBe(p.characters);
  });
});

describe("buildFlowPack", () => {
  test("prompt, shot sheet and up to three image references, designs first", () => {
    let { p, kaiId } = fixture();
    p = upsertCharacter(p, { ...p.characters[0]!, referenceMediaIds: ["r1", "r2", "r3", "d1"], approvedDesignIds: ["d1"] }).production;
    const scene = sceneOf(p);
    const pack = buildFlowPack(p, scene, scene.shots[0]!, new Set(["r1", "r2", "d1"]));
    expect(pack.folderName).toBe("01-01 Rooftop duel - Kick");
    expect(pack.referenceIds).toEqual(["d1"]);
    expect(pack.files.map((f) => f.name)).toEqual(["prompt.txt", "shot.md"]);
    expect(pack.files[0]!.text).toContain("Kai spins");
    expect(pack.files[1]!.text).toContain("images ref-1 as ingredients");
    expect(pack.files[1]!.text).toContain('"Google Flow (manual)"');
    expect(kaiId).toBeTruthy();
  });

  test("never more than three references and only images", () => {
    let { p } = fixture();
    p = upsertCharacter(p, { ...p.characters[0]!, referenceMediaIds: ["a", "b", "c", "d", "v"], approvedDesignIds: [] }).production;
    const scene = sceneOf(p);
    expect(buildFlowPack(p, scene, scene.shots[0]!, new Set(["a", "b", "c", "d"])).referenceIds).toEqual(["a", "b", "c"]);
  });
});
