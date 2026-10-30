// MCP client for Morphic's hosted server (https://mcp.morphic.com/mcp). Morphic signs apps in
// with OAuth 2.1 + PKCE and identifies them by a Client ID Metadata Document (no dynamic
// registration, no API keys), so client_id is the URL of a JSON file we publish. No `electron`
// import: main injects the browser opener and the encrypted token store.

import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";

export const MORPHIC_MCP_URL = "https://mcp.morphic.com/mcp";
// Published from the fork's gh-pages branch; its redirect_uris must list REDIRECT_URL exactly.
export const MORPHIC_CLIENT_METADATA_URL = "https://jdmghk.github.io/frontstage/morphic/client.json";
export const MORPHIC_REDIRECT_PORT = 53917;
export const MORPHIC_REDIRECT_PATH = "/morphic/callback";
export const MORPHIC_REDIRECT_URL = `http://127.0.0.1:${MORPHIC_REDIRECT_PORT}${MORPHIC_REDIRECT_PATH}`;
export const MORPHIC_SCOPES = "projects:read assets:read assets:write generations:write";
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;

// The only tools the renderer may call through IPC: generation starts, status and read-only
// listings. Uploads go through uploadFile so signed upload URLs stay in main.
export const RENDERER_TOOLS = new Set([
  "generate_image",
  "edit_image",
  "generate_video",
  "wait_for_generations",
  "get_generation_status",
  "list_projects",
  "list_assets",
  "list_characters",
  "list_models",
  "get_credit_balance",
]);

function structuredOrThrow(result, tool) {
  if (result.isError) {
    const text = (result.content ?? []).map((c) => c.text ?? "").join(" ").trim();
    throw new Error(text || `Morphic ${tool} failed`);
  }
  if (!result.structuredContent || typeof result.structuredContent !== "object") throw new Error(`Morphic ${tool} returned no structured result`);
  return result.structuredContent;
}

// prepare_media_upload → PUT the bytes (with exactly the returned headers, no Morphic auth) →
// import_media_from_url. Returns the new asset's id. The signed URLs are credentials: not logged.
export async function uploadToMorphic(callTool, bytes, contentType, fileName, projectId, fetchImpl = fetch) {
  const prepArgs = { filename: fileName, content_type: contentType, size_bytes: bytes.byteLength };
  if (projectId) prepArgs.project_id = projectId;
  const prep = structuredOrThrow(await callTool("prepare_media_upload", prepArgs), "prepare_media_upload");
  const put = await fetchImpl(prep.upload_url, { method: "PUT", headers: prep.headers, body: bytes });
  if (!put.ok) throw new Error(`Morphic upload failed (HTTP ${put.status})`);
  const imported = structuredOrThrow(
    await callTool("import_media_from_url", { url: prep.import_url, name: prep.name, project_id: prep.project_id }),
    "import_media_from_url",
  );
  const id = imported.asset?.id;
  if (typeof id !== "string") throw new Error("Morphic import returned no asset id");
  return id;
}

// store: { load(): object|null, save(obj): void, clear(): void } — persists { tokens }.
export function createMorphicAuthProvider({ store, openBrowser, metadataUrl = MORPHIC_CLIENT_METADATA_URL }) {
  let codeVerifier = null;
  return {
    clientMetadataUrl: metadataUrl,
    get redirectUrl() {
      return MORPHIC_REDIRECT_URL;
    },
    get clientMetadata() {
      return {
        client_name: "Frontstage Studio",
        redirect_uris: [MORPHIC_REDIRECT_URL],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: MORPHIC_SCOPES,
      };
    },
    clientInformation() {
      return { client_id: metadataUrl };
    },
    tokens() {
      return store.load()?.tokens ?? undefined;
    },
    saveTokens(tokens) {
      store.save({ tokens });
    },
    redirectToAuthorization(url) {
      return openBrowser(url.toString());
    },
    saveCodeVerifier(v) {
      codeVerifier = v;
    },
    codeVerifier() {
      if (!codeVerifier) throw new Error("Morphic sign-in was not started");
      return codeVerifier;
    },
    invalidateCredentials(scope) {
      if (scope === "all" || scope === "tokens") store.clear();
      if (scope === "all" || scope === "verifier") codeVerifier = null;
    },
  };
}

// Listens once on the loopback redirect and resolves with the authorization code.
export function waitForAuthCode({ port = MORPHIC_REDIRECT_PORT, timeoutMs = SIGN_IN_TIMEOUT_MS } = {}) {
  let server;
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("Morphic sign-in timed out")), timeoutMs);
    function finish(err, code) {
      clearTimeout(timer);
      server.close();
      if (err) reject(err);
      else resolve(code);
    }
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      if (url.pathname !== MORPHIC_REDIRECT_PATH) {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        code
          ? "<p>Signed in to Morphic. You can close this tab and return to Frontstage.</p>"
          : "<p>Morphic sign-in did not complete. Return to Frontstage and try again.</p>",
      );
      if (code) finish(null, code);
      else finish(new Error("Morphic sign-in failed: " + (url.searchParams.get("error_description") || error || "no code")));
    });
    server.on("error", (e) => finish(e.code === "EADDRINUSE" ? new Error(`Port ${port} is in use; close the other app using it and try again`) : e));
    server.listen(port, "127.0.0.1");
  });
  return { done, close: () => server?.close() };
}

// One live MCP session. connect({ interactive }) signs in through the browser only when allowed;
// a non-interactive connect with no (or expired) tokens throws MorphicAuthRequired.
export class MorphicAuthRequired extends Error {
  constructor() {
    super("Not signed in to Morphic");
    this.name = "MorphicAuthRequired";
  }
}

export function createMorphicClient({ store, openBrowser, serverUrl = MORPHIC_MCP_URL, makeClient, makeTransport, waitForCode = waitForAuthCode }) {
  let client = null;
  const newClient = makeClient ?? (() => new Client({ name: "frontstage-studio", version: "0.2.0" }));
  const newTransport = makeTransport ?? ((authProvider) => new StreamableHTTPClientTransport(new URL(serverUrl), { authProvider }));

  async function connect({ interactive = false } = {}) {
    if (client) return client;
    let pendingCode = null;
    const authProvider = createMorphicAuthProvider({
      store,
      openBrowser: async (url) => {
        if (!interactive) throw new MorphicAuthRequired();
        pendingCode = waitForCode();
        await openBrowser(url);
      },
    });
    let transport = newTransport(authProvider);
    let c = newClient();
    try {
      await c.connect(transport);
    } catch (e) {
      if (e instanceof MorphicAuthRequired || (e instanceof UnauthorizedError && !pendingCode)) {
        pendingCode?.close();
        throw new MorphicAuthRequired();
      }
      if (!(e instanceof UnauthorizedError)) throw e;
      const code = await pendingCode.done;
      await transport.finishAuth(code);
      transport = newTransport(authProvider);
      c = newClient();
      await c.connect(transport);
    }
    client = c;
    return client;
  }

  async function withClient(fn) {
    const c = await connect();
    try {
      return await fn(c);
    } catch (e) {
      if (e instanceof UnauthorizedError) {
        await disconnect();
        throw new MorphicAuthRequired();
      }
      throw e;
    }
  }

  async function disconnect() {
    const c = client;
    client = null;
    await c?.close().catch(() => {});
  }

  return {
    signIn: () => connect({ interactive: true }).then(() => undefined),
    async signOut() {
      await disconnect();
      store.clear();
    },
    isSignedIn: () => !!store.load()?.tokens,
    listTools: () => withClient(async (c) => (await c.listTools()).tools),
    callTool: (name, args) => withClient((c) => c.callTool({ name, arguments: args ?? {} })),
    uploadFile: (bytes, contentType, fileName, projectId) =>
      uploadToMorphic((name, args) => withClient((c) => c.callTool({ name, arguments: args })), bytes, contentType, fileName, projectId),
    disconnect,
  };
}
