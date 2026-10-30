import { describe, expect, test } from "vitest";
import type { MediaManifestEntry, Production } from "@frontstage/core";
import { addScene, addVoiceProfile, emptyProduction, setCharacterVoice, updateScene, upsertCharacter } from "@frontstage/core";
import { CHATTERBOX_ENDPOINT, VoiceStudio } from "../src/studio/voice-studio.js";
import type { StartJobArgs } from "../src/generation/generation-service.js";

function setup(opts: { voiced?: boolean; hasKey?: boolean; text?: string; url?: string | undefined } = {}) {
  let p: Production = emptyProduction();
  const kai = upsertCharacter(p, { name: "Kai" });
  p = kai.production;
  if (opts.voiced !== false) {
    const v = addVoiceProfile(p, { name: "Kai voice", referenceMediaId: "ref1", language: "french", expressiveness: 0.8, consent: { attested: true } });
    if ("error" in v) throw new Error(v.error);
    p = setCharacterVoice(v.production, kai.characterId, v.voiceId);
  }
  const s = addScene(p, {});
  p = updateScene(s.production, s.sceneId, { dialogue: [{ id: "l1", speaker: kai.characterId, text: opts.text ?? "Tu me dois.", direction: "", takes: [], status: "draft" }] });
  const added: MediaManifestEntry[] = [];
  const jobs: StartJobArgs[] = [];
  const studio = new VoiceStudio({
    generation: {
      hasKey: async () => opts.hasKey ?? true,
      addPlaceholder: (e) => void added.push(e),
      startJob: async (a) => (jobs.push(a), { jobId: "j1" }),
    },
    entryUrl: async () => ("url" in opts ? opts.url : "https://fal.media/ref1.wav"),
    newId: () => "ph1",
  });
  return { p, studio, added, jobs };
}

describe("VoiceStudio", () => {
  test("sends the line in the character's voice and language through fal Chatterbox", async () => {
    const { p, studio, added, jobs } = setup();
    expect(await studio.generateLine(p, "l1", { name: "S01 L01 Kai", folderId: "f" })).toEqual({ placeholderId: "ph1" });
    expect(jobs[0]).toMatchObject({
      modelEndpoint: CHATTERBOX_ENDPOINT,
      input: { text: "Tu me dois.", voice: "https://fal.media/ref1.wav", custom_audio_language: "french", exaggeration: 0.8 },
    });
    expect(added[0]).toMatchObject({ type: "audio", folderId: "f", generationInput: { referenceAudioAssetIds: ["ref1"] } });
  });

  test("refusals happen before anything is created or charged", async () => {
    for (const [opts, msg] of [
      [{ voiced: false }, "Kai has no voice yet"],
      [{ hasKey: false }, "fal.ai key"],
      [{ text: "x".repeat(301) }, "at most 300 characters"],
      [{ text: "   " }, "Write the line first"],
      [{ url: undefined }, "isn't available"],
    ] as const) {
      const { p, studio, added, jobs } = setup(opts);
      const r = await studio.generateLine(p, "l1", { name: "n" });
      expect("error" in r && r.error).toContain(msg);
      expect(added).toEqual([]);
      expect(jobs).toEqual([]);
    }
  });
});
