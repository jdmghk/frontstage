// Local stand-in for OpenRouter, fal, Anthropic and Morphic for the smoke run. Nothing in the smoke
// run talks to a real provider. Prints its port, then serves until killed.
const http = require("node:http");

const json = (res, status, v, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(v));
};

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    const base = `http://127.0.0.1:${server.address().port}`;
    const path = req.url.split("?")[0];
    console.error(`${req.method} ${path}`);
    if (path === "/chat/completions") {
      const parsed = JSON.parse(body);
      if (req.headers.authorization !== "Bearer smoke-or-key") return json(res, 401, {});
      if (parsed.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"a":1}\n\n');
        return setTimeout(() => res.end("data: [DONE]\n\n"), 30);
      }
      return json(res, 200, { id: "image-reply" });
    }
    if (path === "/v1/messages") {
      if (req.headers["x-api-key"] !== "smoke-anthropic-key") return json(res, 401, { type: "error" });
      res.writeHead(200, { "content-type": "text/event-stream" });
      const ev = (n, d) => res.write(`event: ${n}\ndata: ${JSON.stringify(d)}\n\n`);
      ev("message_start", { type: "message_start", message: { id: "m", role: "assistant", content: [], stop_reason: null } });
      ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: '{"script":' } });
      ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: '"INT. DOJO"}' } });
      ev("content_block_stop", { type: "content_block_stop", index: 0 });
      ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" } });
      ev("message_stop", { type: "message_stop" });
      return res.end();
    }
    if (path === "/fal-ai/test/x") return req.headers.authorization === "Key smoke-fal-key" ? json(res, 200, { request_id: "job-1" }) : json(res, 401, {});
    if (path === "/fal-ai/test/requests/job-1/status") return json(res, 200, { status: "COMPLETED" });
    if (path === "/fal-ai/test/requests/job-1") return json(res, 200, { video: { url: "https://v3.fal.media/x.mp4" } });
    if (path === "/storage/upload/initiate") return json(res, 200, { upload_url: "https://evil.example/put", file_url: "https://v3.fal.media/f" });

    // Morphic: OAuth plus MCP.
    if (path === "/.well-known/oauth-protected-resource/mcp") return json(res, 200, { resource: `${base}/mcp`, authorization_servers: [`${base}/`], scopes_supported: ["assets:read"] });
    if (path === "/.well-known/oauth-authorization-server") return json(res, 200, { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"] });
    if (path === "/token") return json(res, 200, { access_token: "tok", token_type: "bearer", refresh_token: "r" });
    if (path === "/put") return res.writeHead(200).end();
    if (path === "/mcp") {
      if (req.headers.authorization !== "Bearer tok") return res.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` }).end();
      if (req.method !== "POST") return res.writeHead(405).end();
      const msg = JSON.parse(body);
      const reply = (result, headers) => json(res, 200, { jsonrpc: "2.0", id: msg.id, result }, headers);
      if (msg.method === "initialize") return reply({ protocolVersion: msg.params.protocolVersion, capabilities: {}, serverInfo: { name: "mock", version: "1" } }, { "mcp-session-id": "s1" });
      if (msg.method === "notifications/initialized") return res.writeHead(202).end();
      if (msg.method === "tools/call") {
        const n = msg.params.name;
        if (n === "prepare_media_upload") return reply({ structuredContent: { upload_url: `${base}/put`, headers: { "x-a": "b" }, import_url: "https://i", name: "n", project_id: "proj" }, content: [] });
        if (n === "import_media_from_url") return reply({ structuredContent: { asset: { id: "asset-1" } }, content: [] });
        return reply({ structuredContent: { projects: [] }, content: [], isError: false });
      }
    }
    res.writeHead(404).end();
  });
});

server.listen(0, "127.0.0.1", () => console.log(server.address().port));
