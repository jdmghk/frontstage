import { describe, expect, test } from "vitest";
import type { MediaManifestEntry, Production } from "@frontstage/core";
import { addScene, addShot, emptyProduction, upsertCharacter } from "@frontstage/core";
import {
  MorphicGateway,
  RoutingGenGateway,
  mapWaitResult,
  morphicEndpoint,
  parseStartResult,
  type MorphicBridge,
  type MorphicToolResult,
} from "../src/generation/morphic-gateway.js";
import { MorphicStudio, shotPrompt } from "../src/generation/morphic-studio.js";
import { GenerationService, type GenerationHost } from "../src/generation/generation-service.js";
import type { GenJobGateway } from "../src/generation/gen-gateway.js";

const G1 = "019a0000-0000-7000-8000-000000000001";
const G2 = "019a0000-0000-7000-8000-000000000002";
const PROJECT = { id: "019a0000-0000-7000-8000-0000000000aa", name: "Rooftop", updated_at: "2026-10-30T00:00:00Z" };

const ok = (structuredContent: unknown): MorphicToolResult => ({ structuredContent, content: [] });
const toolError = (text: string): MorphicToolResult => ({ isError: true, content: [{ type: "text", text }] });

function gen(id: string, status: string, url: string | null = null, error_message: string | null = null) {
  return { generation_id: id, status, error_message, assets: url ? [{ url }] : [] };
}

/** A scripted Morphic: each tool name maps to a queue of results (the last one repeats). */
function fakeBridge(script: Record<string, MorphicToolResult[]>, opts: { signedIn?: boolean } = {}) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const uploads: string[] = [];
  const uploadProjects: (string | undefined)[] = [];
  const bridge: MorphicBridge = {
    async callTool(name, args) {
      calls.push({ name, args });
      const q = script[name];
      if (!q || q.length === 0) throw new Error(`unexpected tool ${name}`);
      return q.length > 1 ? q.shift()! : q[0]!;
    },
    async uploadFile(_bytes, _type, fileName, projectId) {
      uploads.push(fileName);
      uploadProjects.push(projectId);
      return `019a0000-0000-7000-8000-00000000010${uploads.length}`;
    },
    async download(url) {
      return new TextEncoder().encode(url);
    },
    async isSignedIn() {
      return opts.signedIn ?? true;
    },
  };
  return { bridge, calls, uploads, uploadProjects };
}

function makeHost() {
  const entries = new Map<string, MediaManifestEntry>();
  const events: string[] = [];
  const host: GenerationHost = {
    addPlaceholder: (e) => void entries.set(e.id, e),
    patchEntry: (id, patch) => void entries.set(id, { ...entries.get(id)!, ...patch }),
    finalizeGenerated: (id, bytes) => {
      events.push(`finalize:${id}:${new TextDecoder().decode(bytes)}`);
      entries.set(id, { ...entries.get(id)!, generationStatus: undefined });
    },
    markGenerationFailed: (ids, message) => void events.push(`failed:${ids.join(",")}:${message}`),
    entries: () => [...entries.values()],
  };
  return { host, entries, events };
}

const fastService = (gw: GenJobGateway, host: GenerationHost) =>
  new GenerationService(gw, host, { pollDelay: () => 0, sleep: () => Promise.resolve() });

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("Morphic wire mapping", () => {
  test("start result yields every generation id, falling back to generation_id", () => {
    expect(parseStartResult(ok({ generation_id: G1, generation_ids: [G1, G2] }), "generate_image")).toEqual([G1, G2]);
    expect(parseStartResult(ok({ generation_id: G1, generation_ids: [] }), "generate_video")).toEqual([G1]);
  });

  test("a tool error or a result without ids throws with Morphic's message", () => {
    expect(() => parseStartResult(toolError("Not enough credits"), "generate_video")).toThrow("Not enough credits");
    expect(() => parseStartResult(ok({ generation_ids: [] }), "generate_video")).toThrow("started no generation");
    expect(() => parseStartResult({ content: [] }, "generate_video")).toThrow("no structured result");
  });

  test("wait result maps to queued, running, succeeded (in job order) and failed", () => {
    const ids = [G1, G2];
    expect(mapWaitResult(ok({ all_finished: false, generations: [gen(G1, "queued"), gen(G2, "queued")] }), ids)).toEqual({ status: "queued" });
    expect(mapWaitResult(ok({ all_finished: false, generations: [gen(G1, "succeeded", "u1"), gen(G2, "in_progress")] }), ids).status).toBe("running");
    expect(mapWaitResult(ok({ all_finished: true, generations: [gen(G2, "succeeded", "u2"), gen(G1, "succeeded", "u1")] }), ids)).toEqual({
      status: "succeeded",
      resultUrls: ["u1", "u2"],
    });
    expect(mapWaitResult(ok({ all_finished: true, generations: [gen(G1, "failed", null, "Content policy")] }), [G1])).toEqual({
      status: "failed",
      errorMessage: "Content policy",
    });
    expect(mapWaitResult(ok({ all_finished: true, generations: [gen(G1, "cancelled")] }), [G1]).status).toBe("failed");
  });

  test("a succeeded generation with no asset URL is a failure, never a fake success", () => {
    expect(mapWaitResult(ok({ all_finished: true, generations: [gen(G1, "succeeded")] }), [G1])).toEqual({
      status: "failed",
      errorMessage: "Morphic finished without a downloadable result",
    });
  });
});

describe("MorphicGateway through GenerationService", () => {
  test("success: submit → poll → download → finalize", async () => {
    const { bridge, calls } = fakeBridge({
      generate_video: [ok({ generation_id: G1, generation_ids: [G1] })],
      wait_for_generations: [
        ok({ all_finished: false, generations: [gen(G1, "in_progress")] }),
        ok({ all_finished: true, generations: [gen(G1, "succeeded", "https://cdn.morphic.com/v.mp4")] }),
      ],
    });
    const { host, events } = makeHost();
    const svc = fastService(new MorphicGateway(bridge), host);
    const placeholder = { id: "p1", name: "take", type: "video", duration: 5, source: { kind: "project", relativePath: "media/p1.mp4" }, generationStatus: "preparing" } as MediaManifestEntry;
    host.addPlaceholder(placeholder);
    expect(await svc.startJob({ modelEndpoint: morphicEndpoint("generate_video"), input: { prompt: "x" }, placeholders: [placeholder], model: "m" })).toEqual({ jobId: G1 });
    await settle();
    expect(events).toEqual(["finalize:p1:https://cdn.morphic.com/v.mp4"]);
    expect(calls.filter((c) => c.name === "wait_for_generations")[0]!.args).toEqual({ generation_ids: [G1], wait_seconds: 0 });
  });

  test("tool error at submit marks the placeholder failed", async () => {
    const { bridge } = fakeBridge({ generate_video: [toolError("duration_seconds 7 is not offered by this model")] });
    const { host, events } = makeHost();
    const svc = fastService(new MorphicGateway(bridge), host);
    const p = { id: "p1" } as MediaManifestEntry;
    host.addPlaceholder(p);
    const r = await svc.startJob({ modelEndpoint: morphicEndpoint("generate_video"), input: {}, placeholders: [p], model: "m" });
    expect(r).toEqual({ error: "duration_seconds 7 is not offered by this model" });
    expect(events).toEqual(["failed:p1:duration_seconds 7 is not offered by this model"]);
  });

  test("expired sign-in while polling fails the job with the bridge's message", async () => {
    const { bridge } = fakeBridge({ generate_image: [ok({ generation_id: G1, generation_ids: [G1] })] });
    bridge.callTool = (async (name: string) => {
      if (name === "generate_image") return ok({ generation_id: G1, generation_ids: [G1] });
      throw new Error("Not signed in to Morphic");
    }) as MorphicBridge["callTool"];
    const { host, events } = makeHost();
    const svc = fastService(new MorphicGateway(bridge), host);
    const p = { id: "p1" } as MediaManifestEntry;
    host.addPlaceholder(p);
    await svc.startJob({ modelEndpoint: morphicEndpoint("generate_image"), input: {}, placeholders: [p], model: "m" });
    await settle();
    expect(events).toEqual(["failed:p1:Not signed in to Morphic"]);
  });

  test("refuses endpoints that aren't Morphic generation tools", async () => {
    const { bridge } = fakeBridge({});
    await expect(new MorphicGateway(bridge).submitJob("morphic/list_assets", {})).rejects.toThrow("Not a Morphic generation endpoint");
    await expect(new MorphicGateway(bridge).submitJob("fal-ai/veo3.1/fast", {})).rejects.toThrow("Not a Morphic generation endpoint");
  });

  test("RoutingGenGateway sends morphic/* to Morphic and the rest to fal", async () => {
    const seen: string[] = [];
    const stub = (tag: string): GenJobGateway => ({
      submitJob: async (e) => (seen.push(`${tag}:${e}`), { jobId: tag }),
      jobStatus: async () => ({ status: "queued" }),
      downloadResult: async () => new Uint8Array(),
      uploadFile: async () => tag,
      hasKey: async () => true,
    });
    const router = new RoutingGenGateway(stub("fal"), stub("morphic"));
    await router.submitJob("morphic/generate_video", {});
    await router.submitJob("fal-ai/veo3.1/fast", {});
    expect(seen).toEqual(["morphic:morphic/generate_video", "fal:fal-ai/veo3.1/fast"]);
    expect(await router.uploadFile(new Uint8Array(), "image/png", "a.png")).toBe("fal");
  });
});

describe("MorphicStudio", () => {
  function setup(signedIn = true) {
    let p: Production = emptyProduction();
    const c = upsertCharacter(p, { name: "Kai", description: "street fighter", approvedDesignIds: ["design1"], referenceMediaIds: ["design1", "ref2"] });
    p = c.production;
    const s = addScene(p, { title: "Rooftop duel", continuityNotes: "Night, rain", characterIds: [c.characterId] });
    p = s.production;
    const sh = addShot(p, s.sceneId, { prompt: "Kai lands a spinning kick", camera: "low angle", durationSec: 6.4, characterIds: [c.characterId] });
    p = sh.production;
    const scene = p.scenes[0]!;
    const shot = scene.shots[0]!;
    const library: MediaManifestEntry[] = [
      { id: "design1", name: "kai-design.png", type: "image", duration: 5, source: { kind: "project", relativePath: "media/kai.png" } },
      { id: "ref2", name: "kai-ref.png", type: "image", duration: 5, source: { kind: "project", relativePath: "media/ref.png" } },
    ];
    const { bridge, calls, uploads, uploadProjects } = fakeBridge(
      {
        list_projects: [ok({ projects: [{ ...PROJECT, id: "019a0000-0000-7000-8000-0000000000bb", name: "Old", updated_at: "2025-01-01T00:00:00Z" }, PROJECT] })],
        generate_video: [ok({ generation_id: G1, generation_ids: [G1] })],
        edit_image: [ok({ generation_id: G2, generation_ids: [G2] })],
        generate_image: [ok({ generation_id: G2, generation_ids: [G2] })],
        wait_for_generations: [ok({ all_finished: false, generations: [gen(G1, "queued")] })],
      },
      { signedIn },
    );
    const added: MediaManifestEntry[] = [];
    const starts: Record<string, unknown>[] = [];
    let n = 0;
    const studio = new MorphicStudio({
      bridge,
      generation: {
        addPlaceholder: (e) => void added.push(e),
        startJob: async (args) => (starts.push(args.input), { jobId: "j" }),
      },
      entries: () => library,
      loadBytes: async () => new Uint8Array([1, 2, 3]),
      newId: () => `ph${++n}`,
    });
    return { p, scene, shot, studio, calls, uploads, uploadProjects, added, starts, characterId: c.characterId };
  }

  test("shot take: reference-to-video with the character's approved design, in the newest Morphic project", async () => {
    const { p, scene, shot, studio, uploads, uploadProjects, added, starts } = setup();
    const r = await studio.generateShotTake(p, scene, shot, { name: "Rooftop duel – take", folderId: "f1" });
    expect(r).toEqual({ placeholderId: "ph1", projectName: "Rooftop" });
    expect(uploads).toEqual(["kai-design.png"]);
    expect(uploadProjects).toEqual([PROJECT.id]);
    expect(starts[0]).toMatchObject({ aspect_ratio: "16:9", duration_seconds: 6, project_id: PROJECT.id, reference_image_asset_ids: ["019a0000-0000-7000-8000-000000000101"] });
    expect(starts[0]!.prompt).toBe(shotPrompt(p, scene, shot));
    expect(String(starts[0]!.prompt)).toContain("Kai (street fighter)");
    expect(String(starts[0]!.prompt)).toContain("Continuity: Night, rain");
    expect(added[0]).toMatchObject({ type: "video", folderId: "f1", generationInput: { model: "morphic/generate_video", referenceImageAssetIds: ["design1"] } });
  });

  test("references are uploaded once per session", async () => {
    const { p, scene, shot, studio, uploads } = setup();
    await studio.generateShotTake(p, scene, shot, { name: "a" });
    await studio.generateShotTake(p, scene, shot, { name: "b" });
    expect(uploads).toEqual(["kai-design.png"]);
  });

  test("character design: edit_image over its designs and references", async () => {
    const { p, studio, starts, added } = setup();
    const r = await studio.generateCharacterDesign(p.characters[0]!, { name: "Kai design" });
    expect("placeholderId" in r).toBe(true);
    expect(starts[0]!.image_asset_ids).toHaveLength(2);
    expect(added[0]).toMatchObject({ type: "image", generationInput: { model: "morphic/edit_image", referenceImageAssetIds: ["design1", "ref2"] } });
  });

  test("character without references uses generate_image", async () => {
    const { studio, added } = setup();
    await studio.generateCharacterDesign({ id: "c", name: "Mira", description: "", appearance: { ageRange: "", hair: "", clothing: "", build: "", other: "" }, referenceMediaIds: [], approvedDesignIds: [], continuityNotes: "" }, { name: "Mira design" });
    expect(added[0]!.generationInput!.model).toBe("morphic/generate_image");
  });

  test("not signed in: error, no placeholder, no tool call", async () => {
    const { p, scene, shot, studio, added, calls } = setup(false);
    expect(await studio.generateShotTake(p, scene, shot, { name: "a" })).toEqual({ error: "Sign in to Morphic first (Settings → Generation)." });
    expect(added).toEqual([]);
    expect(calls.filter((c) => c.name !== "list_projects")).toEqual([]);
  });

  test("a shot with no prompt or description is refused before anything is sent", async () => {
    const { p, scene, shot, studio, uploads } = setup();
    const empty = { ...shot, prompt: "", description: "" };
    expect(await studio.generateShotTake(p, scene, empty, { name: "a" })).toEqual({ error: "Write the shot's prompt or description first." });
    expect(uploads).toEqual([]);
  });
});
