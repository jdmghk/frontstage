import { describe, expect, it } from "vitest";
import { handleClaudeRun } from "./claude.js";

const schema = { type: "object", properties: { s: { type: "string" } }, required: ["s"], additionalProperties: false };
const body = { model: "claude-sonnet-5-5", system: "sys", prompt: "go", schema, effort: "medium", maxTokens: 4000 };
const req = (headers: Record<string, string>, payload: unknown = body) =>
  new Request("https://site/api/anthropic/run", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(payload) });
const client = (result: unknown, keys: string[] = []) => (key: string) =>
  (keys.push(key), { beta: { messages: { stream: () => ({ finalMessage: async () => (result instanceof Error ? Promise.reject(result) : result) }) } } }) as never;

describe("relay /anthropic/run", () => {
  it("uses the caller's own key for this request", async () => {
    const keys: string[] = [];
    const r = await handleClaudeRun(req({ "X-Anthropic-Key": "sk-user" }), client({ stop_reason: "end_turn", content: [{ type: "text", text: '{"s":"x"}' }] }, keys));
    expect(await r.json()).toEqual({ ok: true, json: { s: "x" } });
    expect(keys).toEqual(["sk-user"]);
  });

  it("no key → 401; invalid request → 400; API error → typed result", async () => {
    expect((await handleClaudeRun(req({}), client({}))).status).toBe(401);
    expect((await handleClaudeRun(req({ "X-Anthropic-Key": "k" }, { ...body, model: "x" }), client({}))).status).toBe(400);
    const r = await handleClaudeRun(req({ "X-Anthropic-Key": "k" }), client(Object.assign(new Error("bad"), { status: 401 })));
    expect(await r.json()).toMatchObject({ ok: false, kind: "auth" });
  });
});
