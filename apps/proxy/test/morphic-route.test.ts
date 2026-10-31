import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProxyServer } from "../src/server.js";
import { MorphicProxy, fileTokenStore } from "../src/morphic.js";

const ORIGIN = "https://app.example.com";
let server: http.Server | null = null;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

function fakeModule(opts: { signedIn?: boolean } = {}) {
  const calls: string[] = [];
  const authRequired = Object.assign(new Error("Not signed in to Morphic"), { name: "MorphicAuthRequired" });
  const mod = {
    RENDERER_TOOLS: new Set(["generate_video", "list_projects"]),
    createMorphicClient: ({ store, openBrowser }: { store: { save(v: unknown): void; load(): unknown; clear(): void }; openBrowser: (u: string) => Promise<void> }) => ({
      async signIn() {
        await openBrowser("https://api.morphic.com/v1/oauth/authorize?x=1");
        await new Promise((r) => setTimeout(r, 10));
        store.save({ tokens: { access_token: "a" } });
      },
      async signOut() { store.clear(); },
      isSignedIn: () => !!store.load(),
      async callTool(name: string) {
        calls.push(name);
        if (!store.load() && !opts.signedIn) throw authRequired;
        return { structuredContent: { ok: name }, content: [], isError: false };
      },
      async uploadFile(bytes: Uint8Array, type: string, name: string) { calls.push(`upload:${name}:${type}:${bytes.length}`); return "asset-1"; },
    }),
  };
  return { mod, calls };
}

async function start(m: MorphicProxy): Promise<number> {
  server = createProxyServer({ apiKey: "or", allowOrigin: ORIGIN, proxyToken: "t", morphic: m });
  return new Promise((r) => server!.listen(0, "127.0.0.1", () => r((server!.address() as { port: number }).port)));
}
const H = { Authorization: "Bearer t", "Content-Type": "application/json" };
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "morphic-proxy-")), "tokens.json");

describe("proxy /morphic/*", () => {
  it("sign-in returns the authorization URL, then status reads signed in; tokens file is private", async () => {
    const file = tmpFile();
    const { mod } = fakeModule();
    const port = await start(new MorphicProxy(fileTokenStore(file), async () => mod as never));
    const r = await (await fetch(`http://127.0.0.1:${port}/morphic/sign-in`, { method: "POST", headers: H })).json();
    expect(r).toEqual({ authorizationUrl: "https://api.morphic.com/v1/oauth/authorize?x=1" });
    await new Promise((res) => setTimeout(res, 30));
    expect(await (await fetch(`http://127.0.0.1:${port}/morphic/status`, { headers: H })).json()).toMatchObject({ signedIn: true });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("calls only allowlisted tools and maps sign-in errors to 401", async () => {
    const { mod, calls } = fakeModule();
    const port = await start(new MorphicProxy(fileTokenStore(tmpFile()), async () => mod as never));
    const call = (name: string) => fetch(`http://127.0.0.1:${port}/morphic/call`, { method: "POST", headers: H, body: JSON.stringify({ name, args: {} }) });
    expect((await call("filmlab_edit")).status).toBe(400);
    expect((await call("list_projects")).status).toBe(401);
    expect(calls).toEqual(["list_projects"]);
  });

  it("uploads raw bytes with type and name, rejecting non-media types", async () => {
    const { mod, calls } = fakeModule({ signedIn: true });
    const port = await start(new MorphicProxy(fileTokenStore(tmpFile()), async () => mod as never));
    const ok = await fetch(`http://127.0.0.1:${port}/morphic/upload?contentType=image%2Fpng&fileName=kai.png`, { method: "POST", headers: { Authorization: "Bearer t" }, body: new Uint8Array([1, 2, 3]) });
    expect(await ok.json()).toEqual({ assetId: "asset-1" });
    expect(calls).toEqual(["upload:kai.png:image/png:3"]);
    const bad = await fetch(`http://127.0.0.1:${port}/morphic/upload?contentType=text%2Fhtml&fileName=x`, { method: "POST", headers: { Authorization: "Bearer t" }, body: "x" });
    expect(bad.status).toBe(400);
  });

  it("the proxy can load the desktop app's real Morphic module", async () => {
    const m = new MorphicProxy(fileTokenStore(tmpFile()));
    await expect(m.call("filmlab_edit", {})).rejects.toThrow("not allowed");
  }, 30_000); // first load pulls in the MCP SDK, slow under a fully parallel turbo run
});
