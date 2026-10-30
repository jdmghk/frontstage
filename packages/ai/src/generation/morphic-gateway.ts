// Morphic (https://mcp.morphic.com/mcp) as a GenJobGateway. Morphic has no REST API for apps —
// only its hosted MCP server — so jobs are MCP tool calls: generate_* starts one or more
// generations, wait_for_generations polls them. Tool names and result shapes were read from the
// server's tools/list (inputSchema/outputSchema) on 2026-10-30; see docs/morphic.md.
//
// Endpoints are "morphic/<tool>" so a RoutingGenGateway can send them here and everything else to
// fal, and so GenerationService.resumePending (which re-polls by generationInput.model) works.

import type { GenJobGateway, JobStatus } from "./gen-gateway.js";

export const MORPHIC_ENDPOINT_PREFIX = "morphic/";

/** The generation tools this app starts. Each returns generation_id(s) and runs asynchronously. */
export type MorphicGenTool = "generate_image" | "edit_image" | "generate_video";

export function morphicEndpoint(tool: MorphicGenTool): string {
  return MORPHIC_ENDPOINT_PREFIX + tool;
}

export function isMorphicEndpoint(endpoint: string): boolean {
  return endpoint.startsWith(MORPHIC_ENDPOINT_PREFIX);
}

/** An MCP CallToolResult, as the desktop bridge returns it. */
export interface MorphicToolResult {
  structuredContent?: unknown;
  content?: { type: string; text?: string }[];
  isError?: boolean;
}

/** Main-process half (desktop IPC). The OAuth tokens and signed upload URLs never reach the renderer. */
export interface MorphicBridge {
  callTool(name: string, args: Record<string, unknown>): Promise<MorphicToolResult>;
  /** prepare_media_upload → PUT → import_media_from_url; returns the new Morphic asset id. */
  uploadFile(bytes: Uint8Array, contentType: string, fileName: string, projectId?: string): Promise<string>;
  download(url: string): Promise<Uint8Array>;
  isSignedIn(): Promise<boolean>;
}

const GEN_TOOLS: ReadonlySet<string> = new Set<MorphicGenTool>(["generate_image", "edit_image", "generate_video"]);

function errorText(result: MorphicToolResult): string {
  const text = (result.content ?? []).map((c) => c.text ?? "").join(" ").trim();
  return text || "Morphic returned an error";
}

function structured(result: MorphicToolResult, tool: string): Record<string, unknown> {
  if (result.isError) throw new Error(errorText(result));
  const s = result.structuredContent;
  if (!s || typeof s !== "object") throw new Error(`Morphic ${tool} returned no structured result`);
  return s as Record<string, unknown>;
}

/** generation_ids from a generate_* result. A partial_failure still returns the ids that did start. */
export function parseStartResult(result: MorphicToolResult, tool: string): string[] {
  const s = structured(result, tool);
  const ids = Array.isArray(s.generation_ids) ? s.generation_ids.filter((x): x is string => typeof x === "string") : [];
  if (ids.length === 0 && typeof s.generation_id === "string") ids.push(s.generation_id);
  if (ids.length === 0) throw new Error(`Morphic ${tool} started no generation`);
  return ids;
}

interface MorphicGenerationState {
  generation_id: string;
  status: string;
  error_message: string | null;
  assets: { url: string | null }[];
}

/**
 * wait_for_generations → JobStatus. Output order follows the job's generation ids, so each
 * placeholder's outputIndex picks its own generation's first asset. Any failed or cancelled
 * generation fails the job: a missing output must not be reported as generated.
 */
export function mapWaitResult(result: MorphicToolResult, ids: string[]): JobStatus {
  const s = structured(result, "wait_for_generations");
  const gens = Array.isArray(s.generations) ? (s.generations as MorphicGenerationState[]) : [];
  const byId = new Map(gens.map((g) => [g.generation_id, g]));
  const states = ids.map((id) => byId.get(id));
  const failed = states.find((g) => g && (g.status === "failed" || g.status === "cancelled"));
  if (failed) return { status: "failed", errorMessage: failed.error_message || `Morphic generation ${failed.status}` };
  if (states.some((g) => !g || g.status !== "succeeded")) {
    return { status: states.some((g) => g?.status === "in_progress") ? "running" : "queued" };
  }
  const resultUrls = states.map((g) => g!.assets.find((a) => typeof a.url === "string" && a.url)?.url ?? "");
  if (resultUrls.some((u) => !u)) return { status: "failed", errorMessage: "Morphic finished without a downloadable result" };
  return { status: "succeeded", resultUrls };
}

export class MorphicGateway implements GenJobGateway {
  constructor(private readonly bridge: MorphicBridge) {}

  async submitJob(modelEndpoint: string, input: Record<string, unknown>): Promise<{ jobId: string }> {
    const tool = modelEndpoint.slice(MORPHIC_ENDPOINT_PREFIX.length);
    if (!isMorphicEndpoint(modelEndpoint) || !GEN_TOOLS.has(tool)) throw new Error(`Not a Morphic generation endpoint: ${modelEndpoint}`);
    const ids = parseStartResult(await this.bridge.callTool(tool, input), tool);
    return { jobId: ids.join(",") };
  }

  async jobStatus(_modelEndpoint: string, jobId: string): Promise<JobStatus> {
    const ids = jobId.split(",").filter(Boolean);
    return mapWaitResult(await this.bridge.callTool("wait_for_generations", { generation_ids: ids, wait_seconds: 0 }), ids);
  }

  downloadResult(url: string): Promise<Uint8Array> {
    return this.bridge.download(url);
  }

  /** Returns a Morphic asset id (what Morphic's generation tools take), not a URL. */
  uploadFile(bytes: Uint8Array, contentType: string, fileName: string): Promise<string> {
    return this.bridge.uploadFile(bytes, contentType, fileName);
  }

  hasKey(): Promise<boolean> {
    return this.bridge.isSignedIn();
  }
}

/** Sends "morphic/*" jobs to Morphic and everything else to the default (fal) gateway. */
export class RoutingGenGateway implements GenJobGateway {
  constructor(
    private readonly fallback: GenJobGateway,
    private readonly morphic: GenJobGateway,
  ) {}

  private pick(endpoint: string): GenJobGateway {
    return isMorphicEndpoint(endpoint) ? this.morphic : this.fallback;
  }

  submitJob(modelEndpoint: string, input: Record<string, unknown>) {
    return this.pick(modelEndpoint).submitJob(modelEndpoint, input);
  }

  jobStatus(modelEndpoint: string, jobId: string) {
    return this.pick(modelEndpoint).jobStatus(modelEndpoint, jobId);
  }

  // Result URLs aren't tagged with their provider; the fallback's download is a plain fetch.
  downloadResult(url: string) {
    return this.fallback.downloadResult(url);
  }

  uploadFile(bytes: Uint8Array, contentType: string, fileName: string) {
    return this.fallback.uploadFile(bytes, contentType, fileName);
  }

  hasKey() {
    return this.fallback.hasKey();
  }
}
