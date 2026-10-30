// Direct Veo 3.1 (Google's model, the one behind Google Flow) through fal.ai with the existing fal
// key. Labelled "Veo 3.1 (fal)", never "Flow": Flow itself has no public API. Schema verified
// 2026-10-30 at fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/veo3.1/reference-to-video:
// prompt, image_urls[], aspect_ratio 16:9|9:16, duration "8s" only, resolution 720p|1080p|4k,
// generate_audio; output video.url. Price (fal model page): $0.40/s at 720p/1080p with audio.

import type { GenerationInput, MediaManifestEntry, Production, Scene, Shot } from "@frontstage/core";
import { createPlaceholderEntry, shotReferenceMediaIds } from "@frontstage/core";
import type { StartJobArgs } from "../generation/generation-service.js";
import { genModel } from "../generation/gen-catalog.js";
import { shotPrompt } from "../generation/morphic-studio.js";

export const VEO_REFERENCE_ENDPOINT = "fal-ai/veo3.1/reference-to-video";
export const VEO_MAX_REFERENCES = 3;
const REFERENCE_SECONDS = 8;
const FAST_DURATIONS = [4, 6, 8];

export interface VeoPlan {
  endpoint: string;
  input: Record<string, unknown>;
  durationSec: number;
  referenceIds: string[];
  /** Estimated cost in US dollars, shown before anything is sent. */
  estimateUsd: number;
  summary: string;
}

export interface VeoStudioDeps {
  generation: {
    hasKey(): Promise<boolean>;
    addPlaceholder(entry: MediaManifestEntry): void;
    startJob(args: StartJobArgs): Promise<{ jobId: string } | { error: string }>;
  };
  entryUrl(mediaRef: string): Promise<string | undefined>;
  entries(): MediaManifestEntry[];
  newId(): string;
}

const nearest = (xs: number[], v: number) => xs.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));

export class VeoStudio {
  constructor(private readonly deps: VeoStudioDeps) {}

  /** What would be sent (and roughly what it costs) — no upload, no charge. */
  plan(p: Production, scene: Scene, shot: Shot): VeoPlan | { error: string } {
    if (!shot.prompt.trim() && !shot.description.trim()) return { error: "Write the shot's prompt or description first." };
    const prompt = shotPrompt(p, scene, shot);
    const images = new Set(this.deps.entries().filter((e) => e.type === "image" && !e.generationStatus).map((e) => e.id));
    const referenceIds = shotReferenceMediaIds(p, shot).filter((id) => images.has(id)).slice(0, VEO_MAX_REFERENCES);
    if (referenceIds.length > 0) {
      return {
        endpoint: VEO_REFERENCE_ENDPOINT,
        input: { prompt, aspect_ratio: "16:9", duration: "8s", resolution: "1080p", generate_audio: true },
        durationSec: REFERENCE_SECONDS,
        referenceIds,
        estimateUsd: REFERENCE_SECONDS * 0.4,
        summary: `Veo 3.1 with ${referenceIds.length} reference image${referenceIds.length > 1 ? "s" : ""}, 8 s at 1080p with sound`,
      };
    }
    const fast = genModel("veo3.1-fast")!;
    const durationSec = nearest(FAST_DURATIONS, shot.durationSec);
    return {
      endpoint: fast.endpoint,
      input: fast.buildInput({ prompt, duration: durationSec, aspectRatio: "16:9", resolution: "1080p" }),
      durationSec,
      referenceIds: [],
      estimateUsd: durationSec * 0.15,
      summary: `Veo 3.1 Fast (no references), ${durationSec} s at 1080p with sound`,
    };
  }

  async generate(p: Production, scene: Scene, shot: Shot, opts: { name: string; folderId?: string }): Promise<{ placeholderId: string } | { error: string }> {
    const plan = this.plan(p, scene, shot);
    if ("error" in plan) return plan;
    if (!(await this.deps.generation.hasKey())) return { error: "Add a fal.ai key in Settings → Generation to use Veo." };
    const urls: string[] = [];
    for (const id of plan.referenceIds) {
      const url = await this.deps.entryUrl(id).catch(() => undefined);
      if (url) urls.push(url);
    }
    if (plan.referenceIds.length > 0 && urls.length === 0) return { error: "The reference images couldn't be uploaded to fal." };
    const input = urls.length ? { ...plan.input, image_urls: urls } : plan.input;
    const genInput: GenerationInput = {
      prompt: String(plan.input.prompt),
      model: plan.endpoint,
      duration: plan.durationSec,
      aspectRatio: "16:9",
      resolution: "1080p",
      referenceImageAssetIds: plan.referenceIds,
      outputIndex: 0,
      createdAt: new Date().toISOString(),
    };
    const entry = createPlaceholderEntry({ id: this.deps.newId(), type: "video", name: opts.name, duration: plan.durationSec, ext: "mp4", genInput, folderId: opts.folderId });
    this.deps.generation.addPlaceholder(entry);
    const r = await this.deps.generation.startJob({
      modelEndpoint: plan.endpoint,
      input,
      placeholders: [entry],
      model: plan.endpoint,
      costCredits: Math.round(plan.estimateUsd * 100),
    });
    if ("error" in r) return { error: r.error };
    return { placeholderId: entry.id };
  }
}
