import { describe, expect, test } from "vitest";
import { buildClaudeParams, claudeErrorResult, interpretClaudeMessage } from "../src/studio/claude-wire.js";

const schema = { type: "object", properties: { s: { type: "string" } }, required: ["s"], additionalProperties: false };
const req = { model: "claude-opus-5-5", system: "sys", prompt: "go", schema, effort: "high", maxTokens: 16000 };

describe("claude-wire (proxy/relay twin of the desktop main module)", () => {
  test("structured output + default fallbacks; rejects anything off-list", () => {
    expect(buildClaudeParams(req)).toMatchObject({ output_config: { effort: "high", format: { type: "json_schema", schema } }, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" });
    expect(() => buildClaudeParams({ ...req, model: "x" })).toThrow("model not allowed");
    expect(() => buildClaudeParams({ ...req, maxTokens: 10 })).toThrow("maxTokens");
    expect(() => buildClaudeParams({ ...req, images: [{ mediaType: "text/html", base64: "x" }] })).toThrow("invalid image");
  });

  test("refusal, truncation and bad JSON are failures", () => {
    expect(interpretClaudeMessage({ stop_reason: "refusal", stop_details: { category: "bio" }, content: [] })).toMatchObject({ ok: false, kind: "refusal" });
    expect(interpretClaudeMessage({ stop_reason: "max_tokens", content: [] })).toMatchObject({ kind: "truncated" });
    expect(interpretClaudeMessage({ stop_reason: "end_turn", content: [{ type: "text", text: "{" }] })).toMatchObject({ kind: "invalid" });
    expect(interpretClaudeMessage({ stop_reason: "end_turn", content: [{ type: "text", text: '{"s":"x"}' }] })).toEqual({ ok: true, json: { s: "x" } });
  });

  test("errors map by HTTP status", () => {
    expect(claudeErrorResult(Object.assign(new Error("no"), { status: 401 }))).toMatchObject({ kind: "auth" });
    expect(claudeErrorResult(Object.assign(new Error("slow"), { status: 429 }))).toMatchObject({ kind: "rate-limit" });
    expect(claudeErrorResult(new Error("ECONNRESET"))).toMatchObject({ kind: "api", error: expect.stringContaining("Could not reach") });
  });
});
