import { describe, expect, test } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { buildParams, interpretMessage, runClaudeStudio } from "../src/main/claude-studio.mjs";

const schema = { type: "object", properties: { script: { type: "string" } }, required: ["script"], additionalProperties: false };
const req = { model: "claude-opus-5-5", system: "sys", prompt: "Write it", schema, effort: "high", maxTokens: 16000 };

function fakeClient(result: unknown | Error, seen: unknown[] = []) {
  return () =>
    ({
      beta: {
        messages: {
          stream: (params: unknown) => {
            seen.push(params);
            return { finalMessage: async () => (result instanceof Error ? Promise.reject(result) : result) };
          },
        },
      },
    }) as unknown as Anthropic;
}

const textMessage = (text: string, stop_reason = "end_turn") => ({ stop_reason, stop_details: null, content: [{ type: "text", text }] });

describe("buildParams", () => {
  test("structured output, effort, default fallbacks and the fallback beta", () => {
    const p = buildParams({ ...req, images: [{ mediaType: "image/png", base64: "AAAA" }] });
    expect(p).toMatchObject({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      output_config: { effort: "high", format: { type: "json_schema", schema } },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    expect(p.messages[0].content[0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } });
    expect(p.messages[0].content[1]).toEqual({ type: "text", text: "Write it" });
    expect(p).not.toHaveProperty("thinking");
  });

  test("rejects other models, efforts, oversized budgets and odd images", () => {
    expect(() => buildParams({ ...req, model: "gpt-x" })).toThrow("model not allowed");
    expect(() => buildParams({ ...req, effort: "max" })).toThrow("effort not allowed");
    expect(() => buildParams({ ...req, maxTokens: 999999 })).toThrow("maxTokens");
    expect(() => buildParams({ ...req, images: [{ mediaType: "application/pdf", base64: "x" }] })).toThrow("invalid image");
    expect(() => buildParams({ ...req, schema: { type: "string" } })).toThrow("schema");
  });
});

describe("interpretMessage", () => {
  test("parses the JSON text", () => {
    expect(interpretMessage(textMessage('{"script":"INT. DOJO"}'))).toEqual({ ok: true, json: { script: "INT. DOJO" } });
  });
  test("a refusal is an error naming the category, never partial content", () => {
    const r = interpretMessage({ stop_reason: "refusal", stop_details: { category: "cyber" }, content: [{ type: "text", text: '{"script":"partial' }] });
    expect(r).toMatchObject({ ok: false, kind: "refusal" });
    expect(r.error).toContain("cyber");
  });
  test("max_tokens is reported as truncated", () => {
    expect(interpretMessage(textMessage('{"scr', "max_tokens"))).toMatchObject({ ok: false, kind: "truncated" });
  });
  test("non-JSON text is invalid", () => {
    expect(interpretMessage(textMessage("sorry"))).toMatchObject({ ok: false, kind: "invalid" });
  });
});

describe("runClaudeStudio", () => {
  test("no key → no-key error and no request", async () => {
    const seen: unknown[] = [];
    expect(await runClaudeStudio(null, req, fakeClient(textMessage("{}"), seen))).toMatchObject({ ok: false, kind: "no-key" });
    expect(seen).toEqual([]);
  });

  test("success streams once and returns the JSON", async () => {
    const seen: unknown[] = [];
    expect(await runClaudeStudio("sk", req, fakeClient(textMessage('{"script":"x"}'), seen))).toEqual({ ok: true, json: { script: "x" } });
    expect(seen).toHaveLength(1);
  });

  test("typed API errors map to user-facing kinds", async () => {
    const headers = new Headers();
    expect(await runClaudeStudio("sk", req, fakeClient(new Anthropic.AuthenticationError(401, {}, "bad key", headers)))).toMatchObject({ kind: "auth" });
    expect(await runClaudeStudio("sk", req, fakeClient(new Anthropic.RateLimitError(429, {}, "slow down", headers)))).toMatchObject({ kind: "rate-limit" });
    expect(await runClaudeStudio("sk", req, fakeClient(new Anthropic.BadRequestError(400, {}, "bad schema", headers)))).toMatchObject({ kind: "api" });
    expect(await runClaudeStudio("sk", req, fakeClient(new Error("ECONNRESET")))).toMatchObject({ kind: "api", error: expect.stringContaining("ECONNRESET") });
  });

  test("an invalid request never reaches the API", async () => {
    const seen: unknown[] = [];
    expect(await runClaudeStudio("sk", { ...req, model: "x" }, fakeClient(textMessage("{}"), seen))).toMatchObject({ kind: "invalid" });
    expect(seen).toEqual([]);
  });
});
