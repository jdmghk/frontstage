//! The local MCP server (stateless Streamable HTTP on 127.0.0.1 only) and the single-use nonces that
//! bind project:authorizePath to an in-flight tool call. Tool logic stays in the renderer: each
//! request crosses the bridge to it.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

use crate::util::{blocking, random_hex};
use crate::Ctx;

pub const DEFAULT_PORT: u16 = 19789;
const SUPPORTED_VERSIONS: [&str; 5] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];
const MAX_BODY: u64 = 256 * 1024 * 1024;

// ── Nonces ──────────────────────────────────────────────────────────────────

#[derive(Default)]
pub struct NonceGuard(Mutex<HashSet<String>>);

impl NonceGuard {
    pub fn mint(&self) -> Result<String, String> {
        let n = random_hex(16)?;
        self.0.lock().unwrap().insert(n.clone());
        Ok(n)
    }
    /// Single-use: a second check of the same nonce always fails.
    pub fn consume(&self, nonce: Option<&str>) -> bool {
        match nonce {
            Some(n) => self.0.lock().unwrap().remove(n),
            None => false,
        }
    }
    /// Called when the owning tool call settles, so unused nonces don't linger.
    pub fn release(&self, nonce: &str) {
        self.0.lock().unwrap().remove(nonce);
    }
    pub fn size(&self) -> usize {
        self.0.lock().unwrap().len()
    }
}

// ── HTTP auth ───────────────────────────────────────────────────────────────

/// Non-browser clients send no Origin; the token is their gate.
pub fn is_localhost_origin(origin: Option<&str>) -> bool {
    let Some(origin) = origin.filter(|o| !o.is_empty()) else { return true };
    let Ok(u) = url::Url::parse(origin) else { return false };
    matches!(u.scheme(), "http" | "https") && matches!(u.host_str(), Some("127.0.0.1" | "localhost" | "[::1]" | "::1"))
}

pub fn is_localhost_host(host: Option<&str>) -> bool {
    let Some(host) = host.filter(|h| !h.is_empty()) else { return false };
    let h = if host.starts_with('[') {
        match host.find(']') {
            Some(i) => &host[..=i],
            None => return false,
        }
    } else {
        host.split(':').next().unwrap_or("")
    };
    matches!(h, "127.0.0.1" | "localhost" | "[::1]" | "::1")
}

/// Constant time over the token's length.
pub fn token_matches(auth_header: Option<&str>, token: &str) -> bool {
    let Some(given) = auth_header.and_then(|h| h.strip_prefix("Bearer ")).filter(|g| !g.is_empty()) else { return false };
    let (a, b) = (given.as_bytes(), token.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// None when allowed, otherwise the status to answer with.
pub fn check_auth(host: Option<&str>, origin: Option<&str>, authorization: Option<&str>, token: &str) -> Option<u16> {
    if !is_localhost_host(host) || !is_localhost_origin(origin) {
        return Some(403);
    }
    if !token_matches(authorization, token) {
        return Some(401);
    }
    None
}

// ── JSON-RPC ────────────────────────────────────────────────────────────────

pub trait Bridge: Send + Sync {
    fn call(&self, kind: &str, payload: Option<Value>) -> Result<Value, String>;
}

fn to_mcp_result(result: &Value) -> Value {
    let empty = vec![];
    let blocks = result.get("blocks").and_then(Value::as_array).unwrap_or(&empty);
    let content: Vec<Value> = blocks
        .iter()
        .map(|b| {
            if b.get("kind").and_then(Value::as_str) == Some("image") {
                json!({ "type": "image", "data": b.get("base64"), "mimeType": b.get("mediaType") })
            } else {
                json!({ "type": "text", "text": b.get("text") })
            }
        })
        .collect();
    json!({ "content": content, "isError": result.get("isError").and_then(Value::as_bool).unwrap_or(false) })
}

fn rpc_error(id: &Value, code: i64, message: impl Into<String>) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message.into() } })
}

/// One JSON-RPC message; None for notifications.
pub fn handle_message(msg: &Value, bridge: &dyn Bridge) -> Option<Value> {
    let id = msg.get("id")?;
    let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
    let params = msg.get("params").cloned().unwrap_or(Value::Null);
    let outcome: Result<Value, (i64, String)> = match method {
        "initialize" => {
            let requested = params.get("protocolVersion").and_then(Value::as_str).unwrap_or("");
            let version = if SUPPORTED_VERSIONS.contains(&requested) { requested } else { SUPPORTED_VERSIONS[0] };
            Ok(json!({ "protocolVersion": version, "capabilities": { "tools": {}, "resources": {} }, "serverInfo": { "name": "frontstage", "version": "0.1.0" } }))
        }
        "ping" => Ok(json!({})),
        "tools/list" => bridge.call("listTools", None).map(|t| json!({ "tools": t })).map_err(|e| (-32603, e)),
        "tools/call" => match params.get("name").and_then(Value::as_str) {
            None => Err((-32602, "tools/call needs a tool name".to_string())),
            Some(name) => {
                let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
                Ok(match bridge.call("callTool", Some(json!({ "name": name, "args": args }))) {
                    Ok(r) => to_mcp_result(&r),
                    Err(e) => json!({ "content": [{ "type": "text", "text": format!("editor not ready: Error: {e}") }], "isError": true }),
                })
            }
        },
        "resources/list" => bridge.call("listResources", None).map(|r| json!({ "resources": r })).map_err(|e| (-32603, e)),
        "resources/read" => bridge.call("readResource", Some(json!({ "uri": params.get("uri") }))).map_err(|e| (-32603, e)),
        other => Err((-32601, format!("Method not found: {other}"))),
    };
    Some(match outcome {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err((code, message)) => rpc_error(id, code, message),
    })
}

// ── Server ──────────────────────────────────────────────────────────────────

pub struct Server {
    http: Arc<tiny_http::Server>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Server {
    /// Binds 127.0.0.1 only, never 0.0.0.0.
    pub fn start(port: u16, token: String, bridge: Arc<dyn Bridge>) -> Result<Server, String> {
        let listener = bind_loopback(port).map_err(|e| format!("couldn't start the MCP server on port {port}: {e}"))?;
        let http = Arc::new(tiny_http::Server::from_listener(listener, None).map_err(|e| e.to_string())?);
        let stop = Arc::new(AtomicBool::new(false));
        let (h, s) = (http.clone(), stop.clone());
        let thread = std::thread::spawn(move || {
            while !s.load(Ordering::SeqCst) {
                let Ok(req) = h.recv() else { break };
                let (t, b) = (token.clone(), bridge.clone());
                // A tool call can wait 30 s on the renderer; requests mustn't queue behind it.
                std::thread::spawn(move || serve(req, &t, b.as_ref()));
            }
        });
        Ok(Server { http, stop, thread: Some(thread) })
    }

    pub fn close(mut self) {
        self.stop.store(true, Ordering::SeqCst);
        self.http.unblock();
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// tiny_http's accept thread lets go of the socket shortly after close() returns, so rebinding at once
/// (regenerating the token, toggling the server) can briefly find the port still in use. A port some
/// other program holds is reported after this short wait.
fn bind_loopback(port: u16) -> std::io::Result<TcpListener> {
    let mut tries = 0;
    loop {
        match TcpListener::bind(("127.0.0.1", port)) {
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse && tries < 40 => {
                tries += 1;
                std::thread::sleep(Duration::from_millis(50));
            }
            other => return other,
        }
    }
}

fn header_of<'a>(req: &'a tiny_http::Request, name: &'static str) -> Option<&'a str> {
    req.headers().iter().find(|h| h.field.equiv(name)).map(|h| h.value.as_str())
}

fn respond(req: tiny_http::Request, status: u16, content_type: &str, body: Vec<u8>) {
    let mut r = tiny_http::Response::from_data(body).with_status_code(status);
    if !content_type.is_empty() {
        r.add_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], content_type.as_bytes()).unwrap());
    }
    let _ = req.respond(r);
}

fn serve(mut req: tiny_http::Request, token: &str, bridge: &dyn Bridge) {
    if let Some(status) = check_auth(header_of(&req, "Host"), header_of(&req, "Origin"), header_of(&req, "Authorization"), token) {
        return respond(req, status, "", vec![]);
    }
    let method = req.method().clone();
    let path = req.url().split('?').next().unwrap_or("").to_string();
    if method == tiny_http::Method::Get && path == "/healthz" {
        return respond(req, 200, "text/plain", b"ok".to_vec());
    }
    if path != "/mcp" {
        return respond(req, 404, "", vec![]);
    }
    match method {
        tiny_http::Method::Post => {}
        // Stateless: no server-initiated stream and no session to delete. The spec has clients
        // treat 405 as "not offered".
        tiny_http::Method::Get | tiny_http::Method::Delete => {
            let mut r = tiny_http::Response::empty(405);
            r.add_header(tiny_http::Header::from_bytes(&b"Allow"[..], &b"POST"[..]).unwrap());
            let _ = req.respond(r);
            return;
        }
        _ => return respond(req, 404, "", vec![]),
    }
    let accept = header_of(&req, "Accept").unwrap_or("");
    if !(accept.contains("application/json") && accept.contains("text/event-stream")) {
        return respond(req, 406, "application/json", rpc_error(&Value::Null, -32000, "Not Acceptable: Client must accept both application/json and text/event-stream").to_string().into_bytes());
    }
    if !header_of(&req, "Content-Type").unwrap_or("").contains("application/json") {
        return respond(req, 415, "application/json", rpc_error(&Value::Null, -32000, "Unsupported Media Type: Content-Type must be application/json").to_string().into_bytes());
    }
    if let Some(v) = header_of(&req, "mcp-protocol-version").map(str::to_string) {
        if !SUPPORTED_VERSIONS.contains(&v.as_str()) {
            return respond(req, 400, "application/json", rpc_error(&Value::Null, -32000, format!("Bad Request: Unsupported protocol version: {v}")).to_string().into_bytes());
        }
    }
    let mut body = Vec::new();
    if req.as_reader().take(MAX_BODY + 1).read_to_end(&mut body).is_err() || body.len() as u64 > MAX_BODY {
        return respond(req, 413, "", vec![]);
    }
    let parsed: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => return respond(req, 400, "application/json", rpc_error(&Value::Null, -32700, "Parse error").to_string().into_bytes()),
    };
    let reply = match &parsed {
        Value::Array(batch) => {
            let out: Vec<Value> = batch.iter().filter_map(|m| handle_message(m, bridge)).collect();
            if out.is_empty() { None } else { Some(Value::Array(out)) }
        }
        one => handle_message(one, bridge),
    };
    match reply {
        Some(v) => respond(req, 200, "application/json", v.to_string().into_bytes()),
        None => respond(req, 202, "", vec![]),
    }
}

// ── Bridge to the renderer ──────────────────────────────────────────────────

type Pending = Mutex<HashMap<u64, Sender<Result<Value, String>>>>;

/// `emit` delivers { id, kind, payload } to the renderer. A nonce is minted only for callTool.
pub struct RendererBridge {
    emit: Box<dyn Fn(Value) -> Result<(), String> + Send + Sync>,
    pending: Pending,
    seq: AtomicU64,
    nonces: Arc<NonceGuard>,
    timeout: Duration,
}

impl RendererBridge {
    pub fn new(emit: Box<dyn Fn(Value) -> Result<(), String> + Send + Sync>, nonces: Arc<NonceGuard>, timeout: Duration) -> Self {
        RendererBridge { emit, pending: Mutex::new(HashMap::new()), seq: AtomicU64::new(0), nonces, timeout }
    }

    pub fn respond(&self, id: u64, result: Option<Value>, error: Option<String>) {
        if let Some(tx) = self.pending.lock().unwrap().remove(&id) {
            let _ = tx.send(match error {
                Some(e) => Err(e),
                None => Ok(result.unwrap_or(Value::Null)),
            });
        }
    }
}

impl Bridge for RendererBridge {
    fn call(&self, kind: &str, payload: Option<Value>) -> Result<Value, String> {
        let id = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        let nonce = if kind == "callTool" { Some(self.nonces.mint()?) } else { None };
        let mut body = json!({ "id": id, "kind": kind });
        match (payload, &nonce) {
            (Some(mut p), Some(n)) => {
                p["__authNonce"] = json!(n);
                body["payload"] = p;
            }
            (Some(p), None) => body["payload"] = p,
            (None, _) => {}
        }
        let (tx, rx) = channel();
        self.pending.lock().unwrap().insert(id, tx);
        let settled = (|| {
            (self.emit)(body)?;
            rx.recv_timeout(self.timeout).map_err(|_| "bridge timeout".to_string())?
        })();
        self.pending.lock().unwrap().remove(&id);
        if let Some(n) = &nonce {
            self.nonces.release(n);
        }
        settled
    }
}

// ── State and commands ──────────────────────────────────────────────────────

pub struct McpState {
    server: Mutex<Option<Server>>,
    token: Mutex<String>,
    pub bridge: Mutex<Option<Arc<RendererBridge>>>,
    pub port: u16,
    dir: PathBuf,
}

fn token_file(dir: &Path) -> PathBuf {
    dir.join("mcp-token")
}

fn enabled_file(dir: &Path) -> PathBuf {
    dir.join("mcp-enabled")
}

fn write_private(path: &Path, text: &str) {
    if let Some(p) = path.parent() {
        let _ = fs::create_dir_all(p);
    }
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let opened = fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(path);
        if let Ok(mut f) = opened {
            let _ = f.write_all(text.as_bytes());
        }
    }
    #[cfg(not(unix))]
    let _ = fs::write(path, text);
}

pub fn load_or_create_token(dir: &Path) -> Result<String, String> {
    if let Ok(existing) = fs::read_to_string(token_file(dir)) {
        let t = existing.trim();
        if !t.is_empty() {
            return Ok(t.to_string());
        }
    }
    let token = random_hex(32)?;
    write_private(&token_file(dir), &token);
    Ok(token)
}

impl McpState {
    pub fn new(dir: &Path, port: u16) -> Result<Self, String> {
        Ok(McpState { server: Mutex::new(None), token: Mutex::new(load_or_create_token(dir)?), bridge: Mutex::new(None), port, dir: dir.to_path_buf() })
    }

    fn bridge(&self) -> Result<Arc<RendererBridge>, String> {
        self.bridge.lock().unwrap().clone().ok_or_else(|| "editor not ready".to_string())
    }

    fn start(&self) -> Result<Server, String> {
        Server::start(self.port, self.token.lock().unwrap().clone(), self.bridge()?)
    }

    /// Previously enabled: start at launch. A failure here isn't fatal.
    pub fn restore(&self) {
        let on = fs::read_to_string(enabled_file(&self.dir)).map(|s| s.trim() == "1").unwrap_or(false);
        if on {
            if let Ok(s) = self.start() {
                *self.server.lock().unwrap() = Some(s);
            }
        }
    }

    pub fn set_enabled(&self, on: bool) -> Result<bool, String> {
        let mut server = self.server.lock().unwrap();
        if on && server.is_none() {
            *server = Some(self.start()?);
            write_private(&enabled_file(&self.dir), "1");
        } else if !on {
            if let Some(s) = server.take() {
                s.close();
                write_private(&enabled_file(&self.dir), "0");
            }
        }
        Ok(server.is_some())
    }

    pub fn regenerate_token(&self) -> Result<String, String> {
        let token = random_hex(32)?;
        *self.token.lock().unwrap() = token.clone();
        write_private(&token_file(&self.dir), &token);
        let mut server = self.server.lock().unwrap();
        if let Some(s) = server.take() {
            s.close();
            *server = Some(self.start()?);
        }
        Ok(token)
    }

    pub fn status(&self) -> Value {
        let running = self.server.lock().unwrap().is_some();
        json!({ "enabled": running, "running": running, "url": format!("http://127.0.0.1:{}/mcp", self.port), "token": self.token.lock().unwrap().clone() })
    }

    pub fn shutdown(&self) {
        if let Some(s) = self.server.lock().unwrap().take() {
            s.close();
        }
    }
}

pub fn renderer_bridge(app: AppHandle, nonces: Arc<NonceGuard>) -> Arc<RendererBridge> {
    Arc::new(RendererBridge::new(Box::new(move |body| app.emit_to("main", "mcp:request", body).map_err(|e| e.to_string())), nonces, Duration::from_secs(30)))
}

#[tauri::command]
pub async fn mcp_get_status(ctx: State<'_, Ctx>) -> Result<Value, String> {
    Ok(ctx.mcp.status())
}

#[tauri::command]
pub async fn mcp_set_enabled(on: bool, ctx: State<'_, Ctx>) -> Result<Value, String> {
    let enabled = blocking(|| ctx.mcp.set_enabled(on))?;
    Ok(json!({ "enabled": enabled }))
}

#[tauri::command]
pub async fn mcp_regenerate_token(ctx: State<'_, Ctx>) -> Result<String, String> {
    blocking(|| ctx.mcp.regenerate_token())
}

#[tauri::command]
pub async fn mcp_response(id: u64, result: Option<Value>, error: Option<String>, ctx: State<'_, Ctx>) -> Result<(), String> {
    ctx.mcp.bridge()?.respond(id, result, error);
    Ok(())
}

#[cfg(test)]
mod tests {
    //! Port of apps/desktop/test/mcp-auth-nonce.test.ts and mcp-server.test.ts, plus negative HTTP tests.
    use super::*;
    use crate::util::testutil::TempDir;

    // ── Nonces, same cases as the vitest file ──
    #[test]
    fn mint_returns_fresh_non_empty_strings() {
        let g = NonceGuard::default();
        let (a, b) = (g.mint().unwrap(), g.mint().unwrap());
        assert!(!a.is_empty());
        assert_ne!(a, b);
    }

    #[test]
    fn consume_succeeds_for_a_minted_nonce() {
        let g = NonceGuard::default();
        let n = g.mint().unwrap();
        assert!(g.consume(Some(&n)));
    }

    #[test]
    fn consume_is_single_use() {
        let g = NonceGuard::default();
        let n = g.mint().unwrap();
        assert!(g.consume(Some(&n)));
        assert!(!g.consume(Some(&n)));
    }

    #[test]
    fn consume_fails_for_an_unknown_nonce() {
        assert!(!NonceGuard::default().consume(Some("not-a-real-nonce")));
    }

    #[test]
    fn consume_fails_for_null_and_empty() {
        let g = NonceGuard::default();
        assert!(!g.consume(None));
        assert!(!g.consume(Some("")));
    }

    #[test]
    fn nonces_from_different_guards_do_not_cross_validate() {
        let (a, b) = (NonceGuard::default(), NonceGuard::default());
        let n = a.mint().unwrap();
        assert!(!b.consume(Some(&n)));
    }

    #[test]
    fn release_removes_a_nonce() {
        let g = NonceGuard::default();
        let n = g.mint().unwrap();
        assert_eq!(g.size(), 1);
        g.release(&n);
        assert_eq!(g.size(), 0);
        assert!(!g.consume(Some(&n)));
    }

    #[test]
    fn release_of_an_unknown_nonce_is_harmless() {
        let g = NonceGuard::default();
        g.release("never-minted");
        let n = g.mint().unwrap();
        g.consume(Some(&n));
        g.release(&n);
    }

    #[test]
    fn size_counts_only_pending_nonces() {
        let g = NonceGuard::default();
        g.mint().unwrap();
        g.mint().unwrap();
        assert_eq!(g.size(), 2);
        let third = g.mint().unwrap();
        g.consume(Some(&third));
        assert_eq!(g.size(), 2);
    }

    // ── Auth predicates ──
    #[test]
    fn origin_check() {
        for ok in [None, Some(""), Some("http://127.0.0.1:3000"), Some("https://localhost"), Some("http://[::1]:9")] {
            assert!(is_localhost_origin(ok), "{ok:?}");
        }
        for bad in [Some("https://evil.com"), Some("http://127.0.0.1.evil.com"), Some("http://localhost.evil.com"), Some("null"), Some("file:///x"), Some("tauri://localhost"), Some("garbage")] {
            assert!(!is_localhost_origin(bad), "{bad:?}");
        }
    }

    #[test]
    fn host_check_stops_dns_rebinding() {
        for ok in ["127.0.0.1:19789", "localhost:19789", "127.0.0.1", "[::1]:19789", "[::1]"] {
            assert!(is_localhost_host(Some(ok)), "{ok}");
        }
        for bad in ["", "evil.com", "evil.com:19789", "127.0.0.1.evil.com:19789", "localhost.evil.com", "[::2]:1", "[::1"] {
            assert!(!is_localhost_host(Some(bad)), "{bad}");
        }
        assert!(!is_localhost_host(None));
    }

    #[test]
    fn token_check_needs_exactly_the_bearer_token() {
        assert!(token_matches(Some("Bearer abc"), "abc"));
        for bad in [None, Some(""), Some("abc"), Some("Bearer "), Some("bearer abc"), Some("Bearer abd"), Some("Bearer abcd"), Some("Bearer ab"), Some("Basic abc")] {
            assert!(!token_matches(bad, "abc"), "{bad:?}");
        }
    }

    // ── Real server ──
    struct Echo {
        calls: Mutex<Vec<Value>>,
    }

    impl Bridge for Echo {
        fn call(&self, kind: &str, payload: Option<Value>) -> Result<Value, String> {
            match kind {
                "listTools" => Ok(json!([{ "name": "echo", "description": "echoes payload length", "inputSchema": { "type": "object", "properties": { "payload": { "type": "string" } }, "required": ["payload"] } }])),
                "callTool" => {
                    let p = payload.unwrap();
                    self.calls.lock().unwrap().push(p.clone());
                    if p["name"] == "boom" {
                        return Err("renderer gone".into());
                    }
                    let n = p["args"]["payload"].as_str().unwrap_or("").len();
                    Ok(json!({ "blocks": [{ "kind": "text", "text": n.to_string() }, { "kind": "image", "base64": "AA", "mediaType": "image/png" }], "isError": false }))
                }
                "listResources" => Ok(json!([])),
                "readResource" => Ok(json!({ "contents": [] })),
                other => Err(format!("unexpected bridge kind: {other}")),
            }
        }
    }

    fn free_port() -> u16 {
        TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
    }

    fn start() -> (Server, u16, Arc<Echo>) {
        let port = free_port();
        let echo = Arc::new(Echo { calls: Mutex::new(vec![]) });
        (Server::start(port, "test-token".into(), echo.clone()).unwrap(), port, echo)
    }

    /// Raw client so the Host and Origin headers can be forged.
    fn raw(port: u16, request: &str) -> u16 {
        use std::io::Write;
        let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.write_all(request.as_bytes()).unwrap();
        let mut out = String::new();
        let _ = s.read_to_string(&mut out);
        out.split_whitespace().nth(1).unwrap_or("0").parse().unwrap()
    }

    fn rpc(port: u16, body: &Value) -> (u16, Value) {
        let mut res = crate::net::agent(None)
            .post(format!("http://127.0.0.1:{port}/mcp"))
            .header("Authorization", "Bearer test-token")
            .header("Content-Type", "application/json")
            .header("Accept", "application/json, text/event-stream")
            .send(body.to_string().as_bytes())
            .unwrap();
        let status = res.status().as_u16();
        let text = res.body_mut().with_config().limit(u64::MAX).read_to_string().unwrap_or_default();
        (status, serde_json::from_str(&text).unwrap_or(Value::Null))
    }

    #[test]
    fn requests_without_the_right_host_origin_or_token_are_refused_and_never_reach_the_bridge() {
        let (server, port, echo) = start();
        let body = r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"echo"}}"#;
        let req = |host: &str, extra: &str| format!("POST /mcp HTTP/1.1\r\nHost: {host}\r\n{extra}Content-Type: application/json\r\nAccept: application/json, text/event-stream\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}", body.len());
        let ok_host = format!("127.0.0.1:{port}");
        let good = "Authorization: Bearer test-token\r\n";
        assert_eq!(raw(port, &req(&ok_host, "")), 401, "no token");
        assert_eq!(raw(port, &req(&ok_host, "Authorization: Bearer wrong-token\r\n")), 401, "wrong token");
        assert_eq!(raw(port, &req(&ok_host, "Authorization: test-token\r\n")), 401, "no Bearer");
        assert_eq!(raw(port, &req("evil.com", good)), 403, "rebound host");
        assert_eq!(raw(port, &req(&format!("127.0.0.1.evil.com:{port}"), good)), 403, "host suffix");
        assert_eq!(raw(port, &req(&ok_host, &format!("{good}Origin: https://evil.com\r\n"))), 403, "browser origin");
        assert_eq!(raw(port, &req(&ok_host, &format!("{good}Origin: null\r\n"))), 403, "null origin");
        assert!(echo.calls.lock().unwrap().is_empty());
        // The health check sits behind the same gate.
        assert_eq!(raw(port, &format!("GET /healthz HTTP/1.1\r\nHost: {ok_host}\r\nConnection: close\r\n\r\n")), 401);
        assert_eq!(raw(port, &format!("GET /healthz HTTP/1.1\r\nHost: {ok_host}\r\n{good}Connection: close\r\n\r\n")), 200);
        assert_eq!(raw(port, &format!("GET /other HTTP/1.1\r\nHost: {ok_host}\r\n{good}Connection: close\r\n\r\n")), 404);
        assert_eq!(raw(port, &format!("GET /mcp HTTP/1.1\r\nHost: {ok_host}\r\n{good}Connection: close\r\n\r\n")), 405);
        server.close();
    }

    #[test]
    fn it_listens_on_loopback_only() {
        let (server, port, _) = start();
        let addr = server.http.server_addr().to_ip().unwrap();
        assert!(addr.ip().is_loopback());
        assert_eq!(addr.port(), port);
        server.close();
    }

    #[test]
    fn an_argument_over_64kb_round_trips_intact_even_across_slow_tcp_reads() {
        let (server, port, echo) = start();
        let payload = "x".repeat(200_000);
        let (status, reply) = rpc(port, &json!({ "jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": { "name": "echo", "arguments": { "payload": payload } } }));
        assert_eq!(status, 200);
        assert_eq!(reply["id"], 7);
        assert_eq!(reply["result"]["content"][0]["text"], "200000");
        assert_eq!(reply["result"]["content"][1], json!({ "type": "image", "data": "AA", "mimeType": "image/png" }));
        assert_eq!(echo.calls.lock().unwrap()[0]["args"]["payload"].as_str().unwrap().len(), 200_000);

        // The Swift bug: a body split across several TCP reads came out truncated.
        use std::io::Write;
        let body = json!({ "jsonrpc": "2.0", "id": 8, "method": "tools/call", "params": { "name": "echo", "arguments": { "payload": "y".repeat(100_000) } } }).to_string();
        let head = format!("POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer test-token\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nConnection: close\r\nContent-Length: {}\r\n\r\n", body.len());
        let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.write_all(head.as_bytes()).unwrap();
        for chunk in body.as_bytes().chunks(16 * 1024) {
            s.write_all(chunk).unwrap();
            s.flush().unwrap();
            std::thread::sleep(Duration::from_millis(5));
        }
        let mut out = String::new();
        s.read_to_string(&mut out).unwrap();
        assert!(out.contains("\"100000\""), "{}", &out[..out.len().min(300)]);
        server.close();
    }

    #[test]
    fn protocol_flow_matches_a_stateless_mcp_server() {
        let (server, port, _) = start();
        let (_, init) = rpc(port, &json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": { "name": "t", "version": "1" } } }));
        assert_eq!(init["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(init["result"]["serverInfo"], json!({ "name": "frontstage", "version": "0.1.0" }));
        let (_, unknown) = rpc(port, &json!({ "jsonrpc": "2.0", "id": 2, "method": "initialize", "params": { "protocolVersion": "1999-01-01" } }));
        assert_eq!(unknown["result"]["protocolVersion"], "2025-11-25");
        assert_eq!(rpc(port, &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).0, 202);
        assert_eq!(rpc(port, &json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/list" })).1["result"]["tools"][0]["name"], "echo");
        assert_eq!(rpc(port, &json!({ "jsonrpc": "2.0", "id": 4, "method": "nope" })).1["error"]["code"], -32601);
        assert_eq!(rpc(port, &json!({ "jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {} })).1["error"]["code"], -32602);
        let (_, failed) = rpc(port, &json!({ "jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": { "name": "boom" } }));
        assert_eq!(failed["result"]["isError"], true);
        assert_eq!(failed["result"]["content"][0]["text"], "editor not ready: Error: renderer gone");
        server.close();
    }

    #[test]
    fn bad_accept_content_type_version_and_json_are_refused() {
        let (server, port, echo) = start();
        let ok_host = format!("127.0.0.1:{port}");
        let send = |accept: &str, ct: &str, extra: &str, body: &str| {
            raw(port, &format!("POST /mcp HTTP/1.1\r\nHost: {ok_host}\r\nAuthorization: Bearer test-token\r\nAccept: {accept}\r\nContent-Type: {ct}\r\n{extra}Connection: close\r\nContent-Length: {}\r\n\r\n{body}", body.len()))
        };
        let both = "application/json, text/event-stream";
        let msg = r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"echo"}}"#;
        assert_eq!(send("application/json", "application/json", "", msg), 406);
        assert_eq!(send(both, "text/plain", "", msg), 415);
        assert_eq!(send(both, "application/json", "mcp-protocol-version: 1999-01-01\r\n", msg), 400);
        assert_eq!(send(both, "application/json", "", "{nope"), 400);
        assert!(echo.calls.lock().unwrap().is_empty());
        server.close();
    }

    #[test]
    fn closing_frees_the_port_and_a_taken_port_is_a_clear_error() {
        let (server, port, echo) = start();
        let e = Server::start(port, "t".into(), echo.clone()).err().unwrap();
        assert!(e.contains("couldn't start the MCP server"), "{e}");
        server.close();
        Server::start(port, "t".into(), echo).unwrap().close();
    }

    // Found by the WKWebView smoke run: regenerating the token rebinds straight after closing.
    #[test]
    fn restarting_on_the_same_port_at_once_always_works() {
        let (mut server, port, echo) = start();
        for _ in 0..25 {
            server.close();
            server = Server::start(port, "t".into(), echo.clone()).unwrap();
        }
        server.close();
    }

    // ── Bridge ──
    fn bridge(timeout: Duration) -> (Arc<RendererBridge>, Arc<Mutex<Vec<Value>>>, Arc<NonceGuard>) {
        let sent = Arc::new(Mutex::new(vec![]));
        let (s, nonces) = (sent.clone(), Arc::new(NonceGuard::default()));
        let b = RendererBridge::new(
            Box::new(move |v| {
                s.lock().unwrap().push(v);
                Ok(())
            }),
            nonces.clone(),
            timeout,
        );
        (Arc::new(b), sent, nonces)
    }

    #[test]
    fn only_call_tool_gets_a_nonce_and_it_works_only_while_the_call_is_live() {
        let (b, sent, nonces) = bridge(Duration::from_secs(5));
        let b2 = b.clone();
        let t = std::thread::spawn(move || b2.call("listTools", None));
        while sent.lock().unwrap().is_empty() {
            std::thread::sleep(Duration::from_millis(2));
        }
        assert!(sent.lock().unwrap()[0].get("payload").is_none());
        assert_eq!(nonces.size(), 0);
        b.respond(1, Some(json!([])), None);
        t.join().unwrap().unwrap();

        let b2 = b.clone();
        let t = std::thread::spawn(move || b2.call("callTool", Some(json!({ "name": "x", "args": {} }))));
        while sent.lock().unwrap().len() < 2 {
            std::thread::sleep(Duration::from_millis(2));
        }
        let nonce = sent.lock().unwrap()[1]["payload"]["__authNonce"].as_str().unwrap().to_string();
        assert_eq!(nonces.size(), 1);
        b.respond(2, Some(json!({ "ok": true })), None);
        assert_eq!(t.join().unwrap().unwrap()["ok"], true);
        // Settled: the nonce is gone, so it can't authorise anything later.
        assert_eq!(nonces.size(), 0);
        assert!(!nonces.consume(Some(&nonce)));
    }

    #[test]
    fn a_silent_renderer_times_out_and_the_nonce_is_released() {
        let (b, _, nonces) = bridge(Duration::from_millis(30));
        assert_eq!(b.call("callTool", Some(json!({ "name": "x", "args": {} }))).unwrap_err(), "bridge timeout");
        assert_eq!(nonces.size(), 0);
    }

    #[test]
    fn renderer_errors_surface_and_unknown_response_ids_are_ignored() {
        let (b, sent, _) = bridge(Duration::from_secs(5));
        b.respond(999, Some(json!(1)), None);
        let b2 = b.clone();
        let t = std::thread::spawn(move || b2.call("listTools", None));
        while sent.lock().unwrap().is_empty() {
            std::thread::sleep(Duration::from_millis(2));
        }
        b.respond(1, None, Some("broken".into()));
        assert_eq!(t.join().unwrap().unwrap_err(), "broken");
    }

    #[test]
    fn the_token_file_is_private_and_stable() {
        let d = TempDir::new("mcp");
        let t = load_or_create_token(d.path()).unwrap();
        assert_eq!(t.len(), 64);
        assert_eq!(load_or_create_token(d.path()).unwrap(), t);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(token_file(d.path())).unwrap().permissions().mode() & 0o777, 0o600);
        }
    }

    // The official client against this server, when the repo's node_modules are installed.
    #[test]
    fn the_official_mcp_sdk_client_works_against_this_server() {
        let desktop = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../desktop");
        if !desktop.join("node_modules/@modelcontextprotocol/sdk").exists() {
            eprintln!("SKIPPED: no @modelcontextprotocol/sdk");
            return;
        }
        let (server, port, _) = start();
        let script = format!(
            r#"import {{ Client }} from "@modelcontextprotocol/sdk/client/index.js";
import {{ StreamableHTTPClientTransport }} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const t = new StreamableHTTPClientTransport(new URL("http://127.0.0.1:{port}/mcp"), {{ requestInit: {{ headers: {{ Authorization: "Bearer test-token" }} }} }});
const c = new Client({{ name: "t", version: "1" }});
await c.connect(t);
const tools = await c.listTools();
const r = await c.callTool({{ name: "echo", arguments: {{ payload: "x".repeat(200000) }} }});
console.log(JSON.stringify({{ tool: tools.tools[0].name, text: r.content[0].text }}));
await c.close();"#
        );
        let out = std::process::Command::new("node").args(["--input-type=module", "-e", &script]).current_dir(&desktop).output().expect("node");
        server.close();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let v: Value = serde_json::from_slice(&out.stdout).unwrap();
        assert_eq!(v, json!({ "tool": "echo", "text": "200000" }));
    }
}
