// Claude (Anthropic Messages API) for the Production tab's writing actions. The renderer sends a
// ClaudeStudioRequest (see packages/ai/src/studio/writer.ts); main checks it, adds the key and
// server-side fallbacks, streams the reply and returns the structured JSON. No `electron` import.

import Anthropic from "@anthropic-ai/sdk";

export const ALLOWED_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5"]);
const EFFORTS = new Set(["low", "medium", "high"]);
const MAX_TOKENS_CAP = 64000;
const MAX_IMAGES = 20;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
// Refused requests re-run server-side on the model Anthropic recommends for the refusal category.
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** Validates the renderer's request and builds Messages API params. Throws on anything unexpected. */
export function buildParams(req) {
  if (!req || typeof req !== "object") throw new Error("invalid request");
  const { model, system, prompt, schema, effort, maxTokens, images = [] } = req;
  if (!ALLOWED_MODELS.has(model)) throw new Error(`model not allowed: ${model}`);
  if (typeof system !== "string" || typeof prompt !== "string" || !prompt.trim()) throw new Error("system and prompt are required");
  if (!schema || typeof schema !== "object" || schema.type !== "object") throw new Error("schema must be a JSON object schema");
  if (!EFFORTS.has(effort)) throw new Error(`effort not allowed: ${effort}`);
  if (!Number.isInteger(maxTokens) || maxTokens < 256 || maxTokens > MAX_TOKENS_CAP) throw new Error("maxTokens out of range");
  if (!Array.isArray(images) || images.length > MAX_IMAGES) throw new Error("too many images");
  const imageBlocks = images.map((img) => {
    if (!IMAGE_TYPES.has(img?.mediaType) || typeof img?.base64 !== "string") throw new Error("invalid image");
    return { type: "image", source: { type: "base64", media_type: img.mediaType, data: img.base64 } };
  });
  return {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: [...imageBlocks, { type: "text", text: prompt }] }],
    output_config: { effort, format: { type: "json_schema", schema } },
    betas: [FALLBACK_BETA],
    fallbacks: "default",
  };
}

/** Maps the final message to { ok, json } or a typed failure; never returns partial text as success. */
export function interpretMessage(message) {
  if (message.stop_reason === "refusal") {
    const category = message.stop_details?.category;
    return { ok: false, kind: "refusal", error: `Claude declined this request${category ? ` (${category})` : ""}. Rephrase the idea or scene and try again.` };
  }
  if (message.stop_reason === "max_tokens") {
    return { ok: false, kind: "truncated", error: "Claude's answer was cut off before it finished. Try a shorter scene or fewer shots." };
  }
  const text = (message.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
  try {
    return { ok: true, json: JSON.parse(text) };
  } catch {
    return { ok: false, kind: "invalid", error: "Claude's answer wasn't valid JSON." };
  }
}

export function classifyError(err) {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return { ok: false, kind: "auth", error: "The Anthropic API key was rejected. Check it in Settings → Agent → Anthropic." };
  }
  if (err instanceof Anthropic.RateLimitError) return { ok: false, kind: "rate-limit", error: "Anthropic rate limit reached. Wait a minute and try again." };
  if (err instanceof Anthropic.BadRequestError) return { ok: false, kind: "api", error: `Anthropic rejected the request: ${err.message}` };
  if (err instanceof Anthropic.APIError) return { ok: false, kind: "api", error: `Anthropic API error${err.status ? ` ${err.status}` : ""}: ${err.message}` };
  return { ok: false, kind: "api", error: `Could not reach Anthropic: ${err && err.message ? err.message : String(err)}` };
}

/** Runs one request. `makeClient` is injectable for tests. */
export async function runClaudeStudio(apiKey, req, makeClient = (key) => new Anthropic({ apiKey: key, maxRetries: 3 })) {
  if (!apiKey) return { ok: false, kind: "no-key", error: "Add your Anthropic API key in Settings → Agent → Anthropic." };
  let params;
  try {
    params = buildParams(req);
  } catch (e) {
    return { ok: false, kind: "invalid", error: String(e.message ?? e) };
  }
  try {
    // Streaming keeps long scripts clear of HTTP timeouts; finalMessage() assembles the reply.
    const message = await makeClient(apiKey).beta.messages.stream(params).finalMessage();
    return interpretMessage(message);
  } catch (err) {
    return classifyError(err);
  }
}
