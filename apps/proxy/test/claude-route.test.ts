import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createProxyServer } from "../src/server.js";

const ORIGIN = "https://app.example.com";
const schema = { type: "object", properties: { s: { type: "string" } }, required: ["s"], additionalProperties: false };
const body = { model: "claude-opus-5-5", system: "sys", prompt: "go", schema, effort: "high", maxTokens: 4000 };

let server: http.Server | null = null;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

function start(opts: Partial<Parameters<typeof createProxyServer>[0]>): Promise<number> {
  server = createProxyServer({ apiKey: "or", allowOrigin: ORIGIN, proxyToken: "t", ...opts });
  return new Promise((r) => server!.listen(0, "127.0.0.1", () => r((server!.address() as { port: number }).port)));
}

function fakeAnthropic(result: unknown, seen: unknown[] = []) {
  return () =>
    ({ beta: { messages: { stream: (p: unknown) => (seen.push(p), { finalMessage: async () => (result instanceof Error ? Promise.reject(result) : result) }) } } }) as never;
}

const post = (port: number, payload: unknown, token = "t") =>
  fetch(`http://127.0.0.1:${port}/anthropic/run`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) });

describe("proxy /anthropic/*", () => {
  it("reports whether Claude is configured", async () => {
    const port = await start({ anthropicKey: "sk" });
    const r = await fetch(`http://127.0.0.1:${port}/anthropic/enabled`, { headers: { Authorization: "Bearer t" } });
    expect(await r.json()).toEqual({ enabled: true });
  });

  it("runs a structured request with default fallbacks and returns the JSON", async () => {
    const seen: unknown[] = [];
    const port = await start({ anthropicKey: "sk", makeAnthropic: fakeAnthropic({ stop_reason: "end_turn", content: [{ type: "text", text: '{"s":"ok"}' }] }, seen) });
    const r = await post(port, body);
    expect(await r.json()).toEqual({ ok: true, json: { s: "ok" } });
    expect(seen[0]).toMatchObject({ fallbacks: "default", betas: ["server-side-fallback-2026-07-01"] });
  });

  it("rejects bad requests, wrong tokens and a missing key", async () => {
    const port = await start({ anthropicKey: "sk", makeAnthropic: fakeAnthropic({}) });
    expect((await post(port, { ...body, model: "gpt" })).status).toBe(400);
    expect((await post(port, body, "wrong")).status).toBe(401);
    server!.close();
    const port2 = await start({});
    const r = await post(port2, body);
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ kind: "no-key" });
  });

  it("maps API errors to user-facing results", async () => {
    const port = await start({ anthropicKey: "sk", makeAnthropic: fakeAnthropic(Object.assign(new Error("slow"), { status: 429 })) });
    expect(await (await post(port, body)).json()).toMatchObject({ ok: false, kind: "rate-limit" });
  });
});
