import { createProxyServer } from "./server.js";
import { MorphicProxy, defaultTokenFile, fileTokenStore } from "./morphic.js";

// CLI entry point.
// Env vars:
//   OPENROUTER_API_KEY  [required]  Upstream API key forwarded to OpenRouter.
//   ALLOW_ORIGIN        [required]  Exact origin the proxy allows, e.g. https://app.example.com.
//   PROXY_TOKEN         [recommended] Shared secret; clients send Authorization: Bearer <token>.
//   FAL_KEY             [optional]  fal.ai queue API key; enables the /fal/* routes.
//   FAL_UPSTREAM        [optional]  fal queue base URL (default: https://queue.fal.run).
//   FAL_REST_UPSTREAM   [optional]  fal REST base URL for storage uploads (default: https://rest.fal.ai).
//   ANTHROPIC_API_KEY   [optional]  Enables /anthropic/* (Claude writing in the web editor).
//   MORPHIC             [optional]  "1" enables /morphic/* (Morphic in the web editor; run the
//                                   proxy on the same computer as the browser — sign-in uses a
//                                   loopback redirect). MORPHIC_TOKEN_FILE overrides the token file.
//   HOST                [optional]  Bind address (default: 127.0.0.1).
//   PORT                [optional]  Bind port (default: 8787).

const apiKey = process.env["OPENROUTER_API_KEY"];
if (!apiKey) {
  console.error("OPENROUTER_API_KEY is required");
  process.exit(1);
}

const allowOrigin = process.env["ALLOW_ORIGIN"];
if (!allowOrigin) {
  console.error("ALLOW_ORIGIN is required (e.g. https://your-app.com)");
  process.exit(1);
}

const proxyToken = process.env["PROXY_TOKEN"];
if (!proxyToken) {
  console.warn("Warning: PROXY_TOKEN is not set — the proxy is unauthenticated. Only bind to localhost or a trusted network.");
}

const falKey = process.env["FAL_KEY"];
const falUpstream = process.env["FAL_UPSTREAM"];
const falRestUpstream = process.env["FAL_REST_UPSTREAM"];

const port = Number(process.env["PORT"] ?? 8787);
const host = process.env["HOST"] ?? "127.0.0.1";

const anthropicKey = process.env["ANTHROPIC_API_KEY"];

const morphic = process.env["MORPHIC"] === "1" ? new MorphicProxy(fileTokenStore(defaultTokenFile())) : undefined;

const server = createProxyServer({ apiKey, allowOrigin, proxyToken, falKey, falUpstream, falRestUpstream, anthropicKey, morphic });
server.listen(port, host, () => {
  console.log(`Proxy listening on http://${host}:${port}`);
});
