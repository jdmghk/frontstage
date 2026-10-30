// Server half of Claude writing, shared by the self-host proxy and the cloud relay (both call the
// Anthropic SDK with these params). Dependency-free so a Worker can import it without the rest of
// @frontstage/ai. The desktop main process has the same logic in apps/desktop/src/main/
// claude-studio.mjs (CJS main can't import TS) — keep the two in sync; both are unit-tested.

export type ClaudeStudioErrorKind = "no-key" | "refusal" | "truncated" | "auth" | "rate-limit" | "api" | "invalid";
export type ClaudeStudioResult = { ok: true; json: unknown } | { ok: false; kind: ClaudeStudioErrorKind; error: string };

export const CLAUDE_ALLOWED_MODELS: ReadonlySet<string> = new Set(["claude-opus-5-5", "claude-sonnet-5-5"]);
const EFFORTS = new Set(["low", "medium", "high"]);
const MAX_TOKENS_CAP = 64000;
const MAX_IMAGES = 20;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
/** Refused requests re-run server-side on the model Anthropic recommends for the refusal category. */
export const CLAUDE_FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** Validates an untrusted ClaudeStudioRequest and builds beta Messages API params. Throws on anything unexpected. */
export function buildClaudeParams(req: unknown): Record<string, unknown> {
  if (!req || typeof req !== "object") throw new Error("invalid request");
  const { model, system, prompt, schema, effort, maxTokens, images = [] } = req as Record<string, unknown>;
  if (typeof model !== "string" || !CLAUDE_ALLOWED_MODELS.has(model)) throw new Error(`model not allowed: ${String(model)}`);
  if (typeof system !== "string" || typeof prompt !== "string" || !prompt.trim()) throw new Error("system and prompt are required");
  if (!schema || typeof schema !== "object" || (schema as { type?: unknown }).type !== "object") throw new Error("schema must be a JSON object schema");
  if (typeof effort !== "string" || !EFFORTS.has(effort)) throw new Error(`effort not allowed: ${String(effort)}`);
  if (typeof maxTokens !== "number" || !Number.isInteger(maxTokens) || maxTokens < 256 || maxTokens > MAX_TOKENS_CAP) throw new Error("maxTokens out of range");
  if (!Array.isArray(images) || images.length > MAX_IMAGES) throw new Error("too many images");
  const imageBlocks = images.map((img: { mediaType?: unknown; base64?: unknown }) => {
    if (typeof img?.mediaType !== "string" || !IMAGE_TYPES.has(img.mediaType) || typeof img.base64 !== "string") throw new Error("invalid image");
    return { type: "image", source: { type: "base64", media_type: img.mediaType, data: img.base64 } };
  });
  return {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: [...imageBlocks, { type: "text", text: prompt }] }],
    output_config: { effort, format: { type: "json_schema", schema } },
    betas: [CLAUDE_FALLBACK_BETA],
    fallbacks: "default",
  };
}

interface MessageLike {
  stop_reason?: string | null;
  stop_details?: { category?: string | null } | null;
  content?: { type: string; text?: string }[];
}

/** Final message → { ok, json } or a typed failure; partial text is never returned as success. */
export function interpretClaudeMessage(message: MessageLike): ClaudeStudioResult {
  if (message.stop_reason === "refusal") {
    const category = message.stop_details?.category;
    return { ok: false, kind: "refusal", error: `Claude declined this request${category ? ` (${category})` : ""}. Rephrase the idea or scene and try again.` };
  }
  if (message.stop_reason === "max_tokens") {
    return { ok: false, kind: "truncated", error: "Claude's answer was cut off before it finished. Try a shorter scene or fewer shots." };
  }
  const text = (message.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
  try {
    return { ok: true, json: JSON.parse(text) };
  } catch {
    return { ok: false, kind: "invalid", error: "Claude's answer wasn't valid JSON." };
  }
}

/** Maps an SDK error's HTTP status to a user-facing failure (SDK errors carry `status`). */
export function claudeErrorResult(err: unknown): ClaudeStudioResult {
  const status = typeof (err as { status?: unknown })?.status === "number" ? (err as { status: number }).status : undefined;
  const message = err instanceof Error ? err.message : String(err);
  const fail = (kind: ClaudeStudioErrorKind, error: string): ClaudeStudioResult => ({ ok: false, kind, error });
  if (status === 401 || status === 403) return fail("auth", "The Anthropic API key was rejected. Check it in Settings.");
  if (status === 429) return fail("rate-limit", "Anthropic rate limit reached. Wait a minute and try again.");
  if (status === 400) return fail("api", `Anthropic rejected the request: ${message}`);
  if (status !== undefined) return fail("api", `Anthropic API error ${status}: ${message}`);
  return fail("api", `Could not reach Anthropic: ${message}`);
}
