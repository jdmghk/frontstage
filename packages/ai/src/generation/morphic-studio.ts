// Production-tab actions on top of MorphicGateway: turn a shot or a character into a Morphic
// generation, with the character's approved designs as reference images, and run it through the
// normal GenerationService placeholder flow so the result lands in the media library.

import type { Character, GenerationInput, MediaManifestEntry, Production, Scene, Shot } from "@frontstage/core";
import { createPlaceholderEntry, shotReferenceMediaIds } from "@frontstage/core";
import type { StartJobArgs } from "./generation-service.js";
import { mimeForEntry } from "./entry-url.js";
import { morphicEndpoint, type MorphicBridge, type MorphicGenTool } from "./morphic-gateway.js";

// Morphic's per-model caps vary (list_models); these are the tool-level maxima from its schemas.
const MAX_VIDEO_REFS = 30;
const MAX_IMAGE_REFS = 14;
const IMAGE_PLACEHOLDER_SECONDS = 5;

export interface MorphicStudioDeps {
  bridge: MorphicBridge;
  generation: {
    addPlaceholder(entry: MediaManifestEntry): void;
    startJob(args: StartJobArgs): Promise<{ jobId: string } | { error: string }>;
  };
  entries(): MediaManifestEntry[];
  /** The entry's bytes from memory or the project folder; undefined if unavailable. */
  loadBytes(entry: MediaManifestEntry): Promise<Uint8Array | undefined>;
  newId(): string;
}

export type MorphicStartResult = { placeholderId: string; projectName: string } | { error: string };

function line(label: string, value: string): string | null {
  return value.trim() ? `${label}: ${value.trim()}` : null;
}

export function characterBrief(c: Character): string {
  const a = c.appearance;
  const parts = [c.description, a.ageRange && `age ${a.ageRange}`, a.build, a.hair && `hair: ${a.hair}`, a.clothing && `wearing ${a.clothing}`, a.other]
    .map((s) => (s ?? "").trim())
    .filter(Boolean);
  return parts.length ? `${c.name} (${parts.join("; ")})` : c.name;
}

/** The shot's prompt (or description) plus camera, framing, cast and continuity. */
export function shotPrompt(p: Production, scene: Scene, shot: Shot): string {
  const cast = p.characters.filter((c) => shot.characterIds.includes(c.id));
  return [
    shot.prompt.trim() || shot.description.trim(),
    line("Camera", shot.camera),
    line("Framing", shot.framing),
    cast.length ? `Characters: ${cast.map(characterBrief).join(". ")}` : null,
    line("Continuity", [scene.continuityNotes, ...cast.map((c) => c.continuityNotes)].filter((s) => s.trim()).join(" ")),
  ]
    .filter(Boolean)
    .join("\n");
}

export function characterDesignPrompt(c: Character): string {
  return [
    `Character design reference sheet of ${characterBrief(c)}.`,
    "Full body, neutral pose, plain background, consistent lighting.",
    line("Continuity", c.continuityNotes),
  ]
    .filter(Boolean)
    .join("\n");
}

interface Prepared {
  project: { id: string; name: string } | null;
  refs: { assetIds: string[]; usedIds: string[] };
}

export class MorphicStudio {
  // Library entry id → Morphic asset id, so a reference is uploaded once per session.
  private readonly uploaded = new Map<string, string>();
  private project: { id: string; name: string } | null = null;

  constructor(private readonly deps: MorphicStudioDeps) {}

  /** Morphic requires a project when the account has more than one; use the most recently updated. */
  private async resolveProject(): Promise<{ id: string; name: string } | null> {
    if (this.project) return this.project;
    const res = await this.deps.bridge.callTool("list_projects", {});
    if (res.isError) throw new Error((res.content ?? []).map((c) => c.text ?? "").join(" ") || "Could not list Morphic projects");
    const projects = ((res.structuredContent as { projects?: { id: string; name: string; updated_at: string }[] })?.projects ?? []).slice();
    projects.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    this.project = projects[0] ? { id: projects[0].id, name: projects[0].name } : null;
    return this.project;
  }

  /** Uploads image references (skipping other media) and returns Morphic asset ids with the library ids used. */
  private async uploadReferences(mediaIds: string[], max: number, projectId: string | undefined): Promise<{ assetIds: string[]; usedIds: string[] }> {
    const assetIds: string[] = [];
    const usedIds: string[] = [];
    for (const id of mediaIds) {
      if (assetIds.length >= max) break;
      const cached = this.uploaded.get(id);
      if (cached) {
        assetIds.push(cached);
        usedIds.push(id);
        continue;
      }
      const entry = this.deps.entries().find((e) => e.id === id);
      if (!entry || entry.type !== "image") continue;
      const bytes = await this.deps.loadBytes(entry);
      if (!bytes || bytes.length === 0) throw new Error(`Reference "${entry.name}" isn't available yet`);
      const fileName = entry.name.replace(/[/\\\r\n]/g, "_").slice(0, 100) || "reference";
      const assetId = await this.deps.bridge.uploadFile(bytes, mimeForEntry(entry), fileName, projectId);
      this.uploaded.set(id, assetId);
      assetIds.push(assetId);
      usedIds.push(id);
    }
    return { assetIds, usedIds };
  }

  /** Signed-in check, project, then reference uploads — everything that can fail before a placeholder exists. */
  private async prepare(refIds: string[], max: number): Promise<Prepared | { error: string }> {
    try {
      if (!(await this.deps.bridge.isSignedIn())) return { error: "Sign in to Morphic first (Settings → Generation)." };
      const project = await this.resolveProject();
      return { project, refs: await this.uploadReferences(refIds, max, project?.id) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  private async start(
    tool: MorphicGenTool,
    input: Record<string, unknown>,
    project: Prepared["project"],
    placeholder: { type: "video" | "image"; name: string; duration: number; folderId?: string; prompt: string; referenceIds: string[] },
  ): Promise<MorphicStartResult> {
    const endpoint = morphicEndpoint(tool);
    const genInput: GenerationInput = {
      prompt: placeholder.prompt,
      model: endpoint,
      duration: placeholder.duration,
      aspectRatio: String(input.aspect_ratio ?? ""),
      referenceImageAssetIds: placeholder.referenceIds,
      outputIndex: 0,
      createdAt: new Date().toISOString(),
    };
    const entry = createPlaceholderEntry({
      id: this.deps.newId(),
      type: placeholder.type,
      name: placeholder.name,
      duration: placeholder.duration,
      ext: placeholder.type === "video" ? "mp4" : "png",
      genInput,
      folderId: placeholder.folderId,
    });
    this.deps.generation.addPlaceholder(entry);
    const result = await this.deps.generation.startJob({
      modelEndpoint: endpoint,
      input: project ? { ...input, project_id: project.id } : input,
      placeholders: [entry],
      model: endpoint,
      costCredits: null,
    });
    if ("error" in result) return { error: result.error };
    return { placeholderId: entry.id, projectName: project?.name ?? "" };
  }

  /** One new take for a shot: reference-to-video with the cast's designs/references, else text-to-video. */
  async generateShotTake(p: Production, scene: Scene, shot: Shot, opts: { name: string; folderId?: string }): Promise<MorphicStartResult> {
    if (!shot.prompt.trim() && !shot.description.trim()) return { error: "Write the shot's prompt or description first." };
    const prompt = shotPrompt(p, scene, shot);
    const prep = await this.prepare(shotReferenceMediaIds(p, shot), MAX_VIDEO_REFS);
    if ("error" in prep) return prep;
    const { refs } = prep;
    const input: Record<string, unknown> = {
      prompt,
      aspect_ratio: "16:9",
      duration_seconds: Math.max(1, Math.min(60, Math.round(shot.durationSec))),
    };
    if (refs.assetIds.length > 0) input.reference_image_asset_ids = refs.assetIds;
    return this.start("generate_video", input, prep.project, {
      type: "video",
      name: opts.name,
      duration: shot.durationSec,
      folderId: opts.folderId,
      prompt,
      referenceIds: refs.usedIds,
    });
  }

  /** A new design image for a character, conditioned on its existing references when it has any. */
  async generateCharacterDesign(c: Character, opts: { name: string; folderId?: string }): Promise<MorphicStartResult> {
    const prompt = characterDesignPrompt(c);
    const refIds = [...c.approvedDesignIds, ...c.referenceMediaIds.filter((id) => !c.approvedDesignIds.includes(id))];
    const prep = await this.prepare(refIds, MAX_IMAGE_REFS);
    if ("error" in prep) return prep;
    const { refs } = prep;
    const tool: MorphicGenTool = refs.assetIds.length > 0 ? "edit_image" : "generate_image";
    const input: Record<string, unknown> = { prompt, aspect_ratio: "3:4" };
    if (refs.assetIds.length > 0) input.image_asset_ids = refs.assetIds;
    return this.start(tool, input, prep.project, {
      type: "image",
      name: opts.name,
      duration: IMAGE_PLACEHOLDER_SECONDS,
      folderId: opts.folderId,
      prompt,
      referenceIds: refs.usedIds,
    });
  }
}
