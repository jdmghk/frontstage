import { describe, expect, test } from "vitest";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  MORPHIC_CLIENT_METADATA_URL,
  MORPHIC_REDIRECT_URL,
  MorphicAuthRequired,
  RENDERER_TOOLS,
  createMorphicAuthProvider,
  createMorphicClient,
  uploadToMorphic,
  waitForAuthCode,
} from "../src/main/morphic-client.mjs";

const ok = (structuredContent: unknown) => ({ structuredContent, content: [] });

function memoryStore(initial: unknown = null) {
  let v = initial as { tokens?: unknown } | null;
  return { load: () => v, save: (x: { tokens?: unknown }) => void (v = x), clear: () => void (v = null) };
}

describe("uploadToMorphic", () => {
  const prep = {
    upload_url: "https://upload.example/put",
    method: "PUT",
    headers: { "x-amz-acl": "private", "content-type": "image/png" },
    import_url: "https://import.example/i",
    project_id: "proj",
    name: "kai.png",
  };

  test("prepare → PUT with exactly the returned headers → import; returns the asset id", async () => {
    const calls: [string, Record<string, unknown>][] = [];
    const puts: { url: string; init: RequestInit }[] = [];
    const callTool = async (name: string, args: Record<string, unknown>) => {
      calls.push([name, args]);
      return name === "prepare_media_upload" ? ok(prep) : ok({ asset: { id: "asset-1" } });
    };
    const fetchImpl = (async (url: string, init: RequestInit) => (puts.push({ url, init }), { ok: true, status: 200 })) as unknown as typeof fetch;
    const id = await uploadToMorphic(callTool, new Uint8Array([1, 2, 3]), "image/png", "kai.png", "proj", fetchImpl);
    expect(id).toBe("asset-1");
    expect(calls[0]).toEqual(["prepare_media_upload", { filename: "kai.png", content_type: "image/png", size_bytes: 3, project_id: "proj" }]);
    expect(puts[0]!.url).toBe(prep.upload_url);
    expect(puts[0]!.init.headers).toEqual(prep.headers);
    expect(calls[1]).toEqual(["import_media_from_url", { url: prep.import_url, name: "kai.png", project_id: "proj" }]);
  });

  test("a failed PUT stops before import", async () => {
    const calls: string[] = [];
    const callTool = async (name: string) => (calls.push(name), ok(prep));
    const fetchImpl = (async () => ({ ok: false, status: 403 })) as unknown as typeof fetch;
    await expect(uploadToMorphic(callTool, new Uint8Array([1]), "image/png", "a.png", undefined, fetchImpl)).rejects.toThrow("HTTP 403");
    expect(calls).toEqual(["prepare_media_upload"]);
  });

  test("Morphic's tool error text is surfaced", async () => {
    const callTool = async () => ({ isError: true, content: [{ type: "text", text: "File too large" }] });
    await expect(uploadToMorphic(callTool, new Uint8Array([1]), "image/png", "a.png")).rejects.toThrow("File too large");
  });
});

describe("auth provider", () => {
  test("identifies the app by its client metadata URL and loopback redirect", () => {
    const p = createMorphicAuthProvider({ store: memoryStore(), openBrowser: () => {} });
    expect(p.clientMetadataUrl).toBe(MORPHIC_CLIENT_METADATA_URL);
    expect(p.clientInformation()).toEqual({ client_id: MORPHIC_CLIENT_METADATA_URL });
    expect(p.redirectUrl).toBe(MORPHIC_REDIRECT_URL);
    expect(p.clientMetadata.redirect_uris).toEqual([MORPHIC_REDIRECT_URL]);
  });

  test("tokens round-trip through the injected store and are cleared on invalidate", () => {
    const store = memoryStore();
    const p = createMorphicAuthProvider({ store, openBrowser: () => {} });
    p.saveTokens({ access_token: "a", token_type: "bearer" });
    expect(p.tokens()).toEqual({ access_token: "a", token_type: "bearer" });
    p.invalidateCredentials("tokens");
    expect(p.tokens()).toBeUndefined();
  });
});

describe("tool allowlist", () => {
  test("renderer may start generations and read, but not delete, edit timelines or upload directly", () => {
    for (const t of ["generate_video", "edit_image", "wait_for_generations", "list_projects"]) expect(RENDERER_TOOLS.has(t)).toBe(true);
    for (const t of ["prepare_media_upload", "import_media_from_url", "filmlab_edit", "morphic_3d_replace_scene"]) expect(RENDERER_TOOLS.has(t)).toBe(false);
  });
});

describe("waitForAuthCode", () => {
  const port = 53000 + Math.floor(Math.random() * 900);

  test("resolves with the code from the loopback redirect", async () => {
    const w = waitForAuthCode({ port, timeoutMs: 5000 });
    await new Promise((r) => setTimeout(r, 50));
    const res = await fetch(`http://127.0.0.1:${port}/morphic/callback?code=abc&state=s`);
    expect(await res.text()).toContain("Signed in to Morphic");
    await expect(w.done).resolves.toBe("abc");
  });

  test("rejects with Morphic's error description when sign-in is denied", async () => {
    const w = waitForAuthCode({ port: port + 1, timeoutMs: 5000 });
    const rejected = expect(w.done).rejects.toThrow("access denied by user");
    await new Promise((r) => setTimeout(r, 50));
    await fetch(`http://127.0.0.1:${port + 1}/morphic/callback?error=access_denied&error_description=access%20denied%20by%20user`);
    await rejected;
  });

  test("times out", async () => {
    await expect(waitForAuthCode({ port: port + 2, timeoutMs: 30 }).done).rejects.toThrow("timed out");
  });
});

describe("createMorphicClient", () => {
  function fakeClient(connect: () => Promise<void>) {
    return () => ({
      connect,
      close: async () => {},
      listTools: async () => ({ tools: [{ name: "generate_video" }] }),
      callTool: async () => ok({}),
    });
  }

  test("a non-interactive call with no valid sign-in reports MorphicAuthRequired and opens no browser", async () => {
    let opened = false;
    const m = createMorphicClient({
      store: memoryStore(),
      openBrowser: async () => void (opened = true),
      makeClient: fakeClient(async () => {
        throw new UnauthorizedError("no token");
      }),
      makeTransport: () => ({}),
    });
    await expect(m.listTools()).rejects.toBeInstanceOf(MorphicAuthRequired);
    expect(opened).toBe(false);
    expect(m.isSignedIn()).toBe(false);
  });

  test("signed in: tools are listed over the connected session", async () => {
    const m = createMorphicClient({
      store: memoryStore({ tokens: { access_token: "a" } }),
      openBrowser: async () => {},
      makeClient: fakeClient(async () => {}),
      makeTransport: () => ({}),
    });
    expect(m.isSignedIn()).toBe(true);
    expect(await m.listTools()).toEqual([{ name: "generate_video" }]);
  });

  test("signOut clears the stored tokens", async () => {
    const store = memoryStore({ tokens: { access_token: "a" } });
    const m = createMorphicClient({ store, openBrowser: async () => {}, makeClient: fakeClient(async () => {}), makeTransport: () => ({}) });
    await m.signOut();
    expect(store.load()).toBeNull();
  });
});
