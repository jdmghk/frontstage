import { describe, expect, test } from "vitest";
import type { MediaManifestEntry, Production } from "@frontstage/core";
import { addScene, addShot, emptyProduction, upsertCharacter } from "@frontstage/core";
import { VeoStudio, VEO_REFERENCE_ENDPOINT } from "../src/studio/veo-studio.js";
import type { StartJobArgs } from "../src/generation/generation-service.js";

const img = (id: string): MediaManifestEntry => ({ id, name: `${id}.png`, type: "image", duration: 5, source: { kind: "project", relativePath: `media/${id}.png` } });

function setup(opts: { refs?: string[]; durationSec?: number; hasKey?: boolean } = {}) {
  let p: Production = emptyProduction();
  const kai = upsertCharacter(p, { name: "Kai", approvedDesignIds: opts.refs ?? [], referenceMediaIds: opts.refs ?? [] });
  p = kai.production;
  const s = addScene(p, { title: "Duel" });
  p = addShot(s.production, s.sceneId, { prompt: "Kai kicks", characterIds: [kai.characterId], durationSec: opts.durationSec ?? 5 }).production;
  const jobs: StartJobArgs[] = [];
  const studio = new VeoStudio({
    generation: { hasKey: async () => opts.hasKey ?? true, addPlaceholder: () => {}, startJob: async (a) => (jobs.push(a), { jobId: "j" }) },
    entryUrl: async (id) => `https://fal.media/${id}`,
    entries: () => ["d1", "d2", "d3", "d4"].map(img),
    newId: () => "ph",
  });
  const scene = p.scenes[0]!;
  return { p, scene, shot: scene.shots[0]!, studio, jobs };
}

describe("VeoStudio", () => {
  test("with designs: reference-to-video, at most 3 images, 8 s 1080p, $3.20 estimate", async () => {
    const { p, scene, shot, studio, jobs } = setup({ refs: ["d1", "d2", "d3", "d4"] });
    const plan = studio.plan(p, scene, shot);
    expect(plan).toMatchObject({ endpoint: VEO_REFERENCE_ENDPOINT, durationSec: 8, estimateUsd: 3.2, referenceIds: ["d1", "d2", "d3"] });
    await studio.generate(p, scene, shot, { name: "n" });
    expect(jobs[0]).toMatchObject({
      modelEndpoint: VEO_REFERENCE_ENDPOINT,
      input: { duration: "8s", resolution: "1080p", aspect_ratio: "16:9", image_urls: ["https://fal.media/d1", "https://fal.media/d2", "https://fal.media/d3"] },
    });
  });

  test("without references: Veo 3.1 Fast text-to-video at the nearest allowed duration", () => {
    const { p, scene, shot, studio } = setup({ durationSec: 5 });
    expect(studio.plan(p, scene, shot)).toMatchObject({ endpoint: "fal-ai/veo3.1/fast", durationSec: 4, input: { duration: "4s" } });
  });

  test("no fal key → refused before anything is created", async () => {
    const { p, scene, shot, studio, jobs } = setup({ hasKey: false });
    expect(await studio.generate(p, scene, shot, { name: "n" })).toEqual({ error: "Add a fal.ai key in Settings → Generation to use Veo." });
    expect(jobs).toEqual([]);
  });
});
