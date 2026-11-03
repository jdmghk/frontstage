//! Morphic's hosted MCP server, signed in with OAuth 2.1 + PKCE. The client id is the URL of a JSON
//! document we publish, so there's no dynamic registration and no API key. Follows the auth and
//! Streamable HTTP behaviour of @modelcontextprotocol/sdk 1.29, and adds an OAuth `state` check,
//! which the Electron client didn't send. Tokens and signed upload URLs never reach the renderer.

use std::io::{BufRead, BufReader};
use std::net::TcpListener;
use std::sync::mpsc::channel;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::ipc::{Request, Response};
use tauri::State;
use url::Url;

use crate::net;
use crate::secrets::{SecretStore, MORPHIC_ACCOUNT};
use crate::util::{base64_url, blocking, header, header_opt, raw_body};
use crate::Ctx;

pub const MCP_URL: &str = "https://mcp.morphic.com/mcp";
/// Published from the fork's gh-pages branch; its redirect_uris must list REDIRECT_URL exactly.
pub const CLIENT_METADATA_URL: &str = "https://jdmghk.github.io/frontstage/morphic/client.json";
pub const REDIRECT_PORT: u16 = 53917;
pub const REDIRECT_PATH: &str = "/morphic/callback";
pub const SCOPES: &str = "projects:read assets:read assets:write generations:write";
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(5 * 60);
// The SDK's default per-request timeout.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
const CLIENT_NAME: &str = "frontstage-studio";
const CLIENT_VERSION: &str = "0.2.0";
const PROTOCOL_VERSION: &str = "2025-11-25";
const SUPPORTED_VERSIONS: [&str; 5] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];

/// The only tools the renderer may call: generation starts, status and read-only listings.
pub const RENDERER_TOOLS: [&str; 10] = ["generate_image", "edit_image", "generate_video", "wait_for_generations", "get_generation_status", "list_projects", "list_assets", "list_characters", "list_models", "get_credit_balance"];

pub fn redirect_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}{REDIRECT_PATH}")
}

#[derive(Debug, PartialEq)]
pub enum MorphicError {
    AuthRequired,
    Other(String),
}

impl MorphicError {
    pub fn message(&self) -> String {
        match self {
            MorphicError::AuthRequired => "Not signed in to Morphic".into(),
            MorphicError::Other(m) => m.clone(),
        }
    }
}

impl From<String> for MorphicError {
    fn from(s: String) -> Self {
        MorphicError::Other(s)
    }
}

impl From<ureq::Error> for MorphicError {
    fn from(e: ureq::Error) -> Self {
        MorphicError::Other(e.to_string())
    }
}

// ── Upload ──────────────────────────────────────────────────────────────────

fn structured_or_throw(result: &Value, tool: &str) -> Result<Value, MorphicError> {
    if result.get("isError").and_then(Value::as_bool).unwrap_or(false) {
        let texts: Vec<&str> = result.get("content").and_then(Value::as_array).map(|c| c.iter().map(|b| b.get("text").and_then(Value::as_str).unwrap_or("")).collect()).unwrap_or_default();
        let text = texts.join(" ");
        let text = text.trim();
        return Err(MorphicError::Other(if text.is_empty() { format!("Morphic {tool} failed") } else { text.to_string() }));
    }
    match result.get("structuredContent") {
        Some(v) if v.is_object() => Ok(v.clone()),
        _ => Err(MorphicError::Other(format!("Morphic {tool} returned no structured result"))),
    }
}

/// prepare_media_upload, PUT with exactly the returned headers and no Morphic auth, then
/// import_media_from_url. The signed URLs are credentials and aren't logged.
pub fn upload_to_morphic(
    call_tool: &mut dyn FnMut(&str, Value) -> Result<Value, MorphicError>,
    put: &mut dyn FnMut(&str, &Value, &[u8]) -> Result<u16, String>,
    bytes: &[u8],
    content_type: &str,
    file_name: &str,
    project_id: Option<&str>,
) -> Result<String, MorphicError> {
    let mut args = json!({ "filename": file_name, "content_type": content_type, "size_bytes": bytes.len() });
    if let Some(p) = project_id.filter(|p| !p.is_empty()) {
        args["project_id"] = json!(p);
    }
    let prep = structured_or_throw(&call_tool("prepare_media_upload", args)?, "prepare_media_upload")?;
    let upload_url = prep.get("upload_url").and_then(Value::as_str).ok_or_else(|| "Morphic upload returned no URL".to_string())?;
    let status = put(upload_url, prep.get("headers").unwrap_or(&Value::Null), bytes)?;
    if !(200..300).contains(&status) {
        return Err(MorphicError::Other(format!("Morphic upload failed (HTTP {status})")));
    }
    let imported = structured_or_throw(&call_tool("import_media_from_url", json!({ "url": prep.get("import_url"), "name": prep.get("name"), "project_id": prep.get("project_id") }))?, "import_media_from_url")?;
    match imported.pointer("/asset/id").and_then(Value::as_str) {
        Some(id) => Ok(id.to_string()),
        None => Err(MorphicError::Other("Morphic import returned no asset id".into())),
    }
}

fn http_put(url: &str, headers: &Value, bytes: &[u8]) -> Result<u16, String> {
    let mut req = net::agent(None).put(url);
    if let Some(map) = headers.as_object() {
        for (k, v) in map {
            if let Some(s) = v.as_str() {
                req = req.header(k.as_str(), s);
            }
        }
    }
    req.send(bytes).map(|r| r.status().as_u16()).map_err(|e| format!("Morphic upload failed: {e}"))
}

// ── Loopback redirect ───────────────────────────────────────────────────────

/// Listens once on the loopback redirect. Only a request carrying our `state` can finish it: a
/// request with any other state gets a 400 and the wait goes on, so another local page can neither
/// inject a code nor cancel the sign-in.
pub struct AuthWait {
    rx: std::sync::mpsc::Receiver<Result<String, String>>,
    http: Arc<tiny_http::Server>,
}

impl AuthWait {
    pub fn start(port: u16, timeout: Duration, state: String) -> Result<AuthWait, String> {
        let listener = TcpListener::bind(("127.0.0.1", port)).map_err(|e| {
            if e.kind() == std::io::ErrorKind::AddrInUse {
                format!("Port {port} is in use; close the other app using it and try again")
            } else {
                e.to_string()
            }
        })?;
        let http = Arc::new(tiny_http::Server::from_listener(listener, None).map_err(|e| e.to_string())?);
        let (tx, rx) = channel();
        let h = http.clone();
        std::thread::spawn(move || {
            let deadline = Instant::now() + timeout;
            loop {
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    let _ = tx.send(Err("Morphic sign-in timed out".to_string()));
                    return;
                }
                let req = match h.recv_timeout(left) {
                    Ok(Some(r)) => r,
                    Ok(None) => {
                        let _ = tx.send(Err("Morphic sign-in timed out".to_string()));
                        return;
                    }
                    Err(e) => {
                        let _ = tx.send(Err(e.to_string()));
                        return;
                    }
                };
                let Ok(url) = Url::parse(&format!("http://127.0.0.1:{port}{}", req.url())) else {
                    let _ = req.respond(tiny_http::Response::empty(400));
                    continue;
                };
                if url.path() != REDIRECT_PATH {
                    let _ = req.respond(tiny_http::Response::empty(404));
                    continue;
                }
                let param = |n: &str| url.query_pairs().find(|(k, _)| k == n).map(|(_, v)| v.into_owned());
                if param("state").as_deref() != Some(state.as_str()) {
                    let _ = req.respond(html(400, "<p>This sign-in link doesn't match the one Frontstage started.</p>"));
                    continue;
                }
                match param("code").filter(|c| !c.is_empty()) {
                    Some(code) => {
                        let _ = req.respond(html(200, "<p>Signed in to Morphic. You can close this tab and return to Frontstage.</p>"));
                        let _ = tx.send(Ok(code));
                    }
                    None => {
                        let _ = req.respond(html(200, "<p>Morphic sign-in did not complete. Return to Frontstage and try again.</p>"));
                        let detail = param("error_description").or_else(|| param("error")).unwrap_or_else(|| "no code".into());
                        let _ = tx.send(Err(format!("Morphic sign-in failed: {detail}")));
                    }
                }
                return;
            }
        });
        Ok(AuthWait { rx, http })
    }

    pub fn wait(self) -> Result<String, String> {
        let r = self.rx.recv().unwrap_or_else(|_| Err("Morphic sign-in stopped".into()));
        self.http.unblock();
        r
    }
}

fn html(status: u16, body: &str) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    tiny_http::Response::from_data(body.as_bytes().to_vec()).with_status_code(status).with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..]).unwrap())
}

// ── OAuth ───────────────────────────────────────────────────────────────────

pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

pub fn pkce() -> Result<Pkce, String> {
    let mut b = [0u8; 32];
    getrandom::fill(&mut b).map_err(|e| e.to_string())?;
    let verifier = base64_url(&b);
    let challenge = base64_url(&Sha256::digest(verifier.as_bytes()));
    Ok(Pkce { verifier, challenge })
}

pub fn www_authenticate_param(header: &str, field: &str) -> Option<String> {
    let (scheme, rest) = header.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let needle = format!("{field}=");
    let mut search = rest;
    while let Some(i) = search.find(&needle) {
        let boundary = i == 0 || matches!(search.as_bytes()[i - 1], b' ' | b',');
        let after = &search[i + needle.len()..];
        if boundary {
            return Some(match after.strip_prefix('"') {
                Some(q) => q.split('"').next().unwrap_or("").to_string(),
                None => after.split([',', ' ']).next().unwrap_or("").to_string(),
            });
        }
        search = after;
    }
    None
}

/// checkResourceAllowed: same origin, and the requested path sits at or below the configured one.
pub fn resource_allowed(requested: &Url, configured: &Url) -> bool {
    if requested.origin() != configured.origin() {
        return false;
    }
    let slash = |p: &str| if p.ends_with('/') { p.to_string() } else { format!("{p}/") };
    slash(requested.path()).starts_with(&slash(configured.path())) && requested.path().len() >= configured.path().len()
}

struct Discovery {
    auth_server: Url,
    metadata: Option<Value>,
    resource: Option<Url>,
    resource_scopes: Option<String>,
}

fn get_json(url: &Url) -> Result<(u16, Option<Value>), MorphicError> {
    let mut res = net::agent(Some(REQUEST_TIMEOUT)).get(url.as_str()).header("MCP-Protocol-Version", PROTOCOL_VERSION).header("Accept", "application/json").call()?;
    let status = res.status().as_u16();
    if !(200..300).contains(&status) {
        return Ok((status, None));
    }
    let text = res.body_mut().read_to_string().map_err(|e| e.to_string())?;
    Ok((status, serde_json::from_str(&text).ok()))
}

fn protected_resource_metadata(server: &Url, hinted: Option<&Url>) -> Option<Value> {
    let (status, body) = match hinted {
        Some(u) => get_json(u).ok()?,
        None => {
            let path = server.path().trim_end_matches('/');
            let specific = server.join(&format!("/.well-known/oauth-protected-resource{path}")).ok()?;
            let (s, b) = get_json(&specific).ok()?;
            if (400..500).contains(&s) && server.path() != "/" {
                get_json(&server.join("/.well-known/oauth-protected-resource").ok()?).ok()?
            } else {
                (s, b)
            }
        }
    };
    if (200..300).contains(&status) { body } else { None }
}

fn auth_server_metadata(auth_server: &Url) -> Result<Option<Value>, MorphicError> {
    let path = auth_server.path().trim_end_matches('/').to_string();
    let urls: Vec<String> = if path.is_empty() {
        vec!["/.well-known/oauth-authorization-server".into(), "/.well-known/openid-configuration".into()]
    } else {
        vec![format!("/.well-known/oauth-authorization-server{path}"), format!("/.well-known/openid-configuration{path}"), format!("{path}/.well-known/openid-configuration")]
    };
    for u in urls {
        let target = auth_server.join(&u).map_err(|e| e.to_string())?;
        let (status, body) = get_json(&target)?;
        if (200..300).contains(&status) {
            return Ok(body);
        }
        if !(400..500).contains(&status) {
            return Err(MorphicError::Other(format!("HTTP {status} trying to load OAuth metadata from {target}")));
        }
    }
    Ok(None)
}

fn discover(server: &Url, hinted: Option<&Url>) -> Result<Discovery, MorphicError> {
    let prm = protected_resource_metadata(server, hinted);
    let auth_server = prm
        .as_ref()
        .and_then(|p| p.pointer("/authorization_servers/0"))
        .and_then(Value::as_str)
        .and_then(|s| Url::parse(s).ok())
        .unwrap_or_else(|| server.join("/").expect("server url has a root"));
    let metadata = auth_server_metadata(&auth_server)?;
    let (mut resource, mut resource_scopes) = (None, None);
    if let Some(p) = &prm {
        let declared = p.get("resource").and_then(Value::as_str).ok_or_else(|| "Protected resource metadata has no resource".to_string())?;
        let declared = Url::parse(declared).map_err(|e| e.to_string())?;
        if !resource_allowed(server, &declared) {
            return Err(MorphicError::Other(format!("Protected resource {declared} does not match expected {server} (or origin)")));
        }
        resource = Some(declared);
        resource_scopes = p.get("scopes_supported").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" "));
    }
    Ok(Discovery { auth_server, metadata, resource, resource_scopes })
}

fn endpoint(d: &Discovery, key: &str, fallback: &str) -> Result<Url, MorphicError> {
    match d.metadata.as_ref().and_then(|m| m.get(key)).and_then(Value::as_str) {
        Some(u) => Url::parse(u).map_err(|e| MorphicError::Other(e.to_string())),
        None => d.auth_server.join(fallback).map_err(|e| MorphicError::Other(e.to_string())),
    }
}

/// Validates server capabilities and builds the authorization URL.
pub fn authorization_url(authz: &Url, metadata: Option<&Value>, client_id: &str, redirect: &str, challenge: &str, state: &str, scope: &str, resource: Option<&Url>) -> Result<Url, String> {
    if let Some(m) = metadata {
        let has = |k: &str, want: &str| m.get(k).and_then(Value::as_array).map(|a| a.iter().any(|v| v == want));
        if has("response_types_supported", "code") != Some(true) {
            return Err("Incompatible auth server: does not support response type code".into());
        }
        if has("code_challenge_methods_supported", "S256") == Some(false) {
            return Err("Incompatible auth server: does not support code challenge method S256".into());
        }
    }
    let mut u = authz.clone();
    {
        let mut q = u.query_pairs_mut();
        q.append_pair("response_type", "code");
        q.append_pair("client_id", client_id);
        q.append_pair("code_challenge", challenge);
        q.append_pair("code_challenge_method", "S256");
        q.append_pair("redirect_uri", redirect);
        q.append_pair("state", state);
        if !scope.is_empty() {
            q.append_pair("scope", scope);
        }
        if scope.contains("offline_access") {
            q.append_pair("prompt", "consent");
        }
        if let Some(r) = resource {
            q.append_pair("resource", r.as_str());
        }
    }
    Ok(u)
}

enum TokenFailure {
    /// Tokens or client aren't valid any more: drop them and sign in again.
    Invalid,
    /// Server trouble: try a fresh sign-in, as the SDK does.
    Server,
    Other(String),
}

fn token_request(d: &Discovery, client_id: &str, params: &[(&str, &str)]) -> Result<Value, TokenFailure> {
    let url = endpoint(d, "token_endpoint", "/token").map_err(|e| TokenFailure::Other(e.message()))?;
    let mut form = url::form_urlencoded::Serializer::new(String::new());
    for (k, v) in params {
        form.append_pair(k, v);
    }
    if let Some(r) = &d.resource {
        form.append_pair("resource", r.as_str());
    }
    form.append_pair("client_id", client_id);
    let body = form.finish();
    let mut res = net::agent(Some(REQUEST_TIMEOUT))
        .post(url.as_str())
        .header("Content-Type", "application/x-www-form-urlencoded")
        .header("Accept", "application/json")
        .send(body.as_bytes())
        .map_err(|e| TokenFailure::Other(e.to_string()))?;
    let status = res.status().as_u16();
    let text = res.body_mut().read_to_string().map_err(|e| TokenFailure::Other(e.to_string()))?;
    if !(200..300).contains(&status) {
        let kind = serde_json::from_str::<Value>(&text).ok().and_then(|v| v.get("error").and_then(Value::as_str).map(str::to_string));
        return Err(match kind.as_deref() {
            Some("invalid_grant" | "invalid_client" | "unauthorized_client") => TokenFailure::Invalid,
            Some("server_error") | None => TokenFailure::Server,
            Some(other) => TokenFailure::Other(format!("Morphic sign-in failed: {other}")),
        });
    }
    let tokens: Value = serde_json::from_str(&text).map_err(|_| TokenFailure::Other("Morphic returned an invalid token response".into()))?;
    if !tokens.get("access_token").is_some_and(Value::is_string) || !tokens.get("token_type").is_some_and(Value::is_string) {
        return Err(TokenFailure::Other("Morphic returned an invalid token response".into()));
    }
    Ok(tokens)
}

// ── Token store ─────────────────────────────────────────────────────────────

pub trait TokenStore: Send + Sync {
    fn load(&self) -> Option<Value>;
    fn save(&self, value: &Value) -> Result<(), String>;
    fn clear(&self);
}

pub struct KeychainTokens(pub Arc<SecretStore>);

impl TokenStore for KeychainTokens {
    fn load(&self) -> Option<Value> {
        self.0.get(MORPHIC_ACCOUNT).ok().flatten().and_then(|s| serde_json::from_str(&s).ok())
    }
    fn save(&self, value: &Value) -> Result<(), String> {
        self.0.set(MORPHIC_ACCOUNT, &value.to_string())
    }
    fn clear(&self) {
        let _ = self.0.delete(MORPHIC_ACCOUNT);
    }
}

// ── Client ──────────────────────────────────────────────────────────────────

struct Session {
    id: Option<String>,
    protocol: String,
}

pub struct Morphic {
    server: Url,
    client_id: String,
    redirect_port: u16,
    store: Arc<dyn TokenStore>,
    open_browser: Box<dyn Fn(&str) -> Result<(), String> + Send + Sync>,
    sign_in_timeout: Duration,
    session: Mutex<Option<Session>>,
    connecting: Mutex<()>,
    seq: std::sync::atomic::AtomicU64,
    /// Cached from the last 401, for refreshing mid-session.
    www_auth: Mutex<Option<String>>,
}

enum Sent {
    Ok(Value),
    Accepted,
    Unauthorized(Option<String>),
    SessionGone,
}

impl Morphic {
    pub fn new(store: Arc<dyn TokenStore>, open_browser: Box<dyn Fn(&str) -> Result<(), String> + Send + Sync>) -> Self {
        Self::with_config(MCP_URL, CLIENT_METADATA_URL, REDIRECT_PORT, SIGN_IN_TIMEOUT, store, open_browser)
    }

    pub fn with_config(server: &str, client_id: &str, redirect_port: u16, sign_in_timeout: Duration, store: Arc<dyn TokenStore>, open_browser: Box<dyn Fn(&str) -> Result<(), String> + Send + Sync>) -> Self {
        Morphic {
            server: Url::parse(server).expect("valid server URL"),
            client_id: client_id.to_string(),
            redirect_port,
            store,
            open_browser,
            sign_in_timeout,
            session: Mutex::new(None),
            connecting: Mutex::new(()),
            seq: std::sync::atomic::AtomicU64::new(0),
            www_auth: Mutex::new(None),
        }
    }

    pub fn is_signed_in(&self) -> bool {
        self.store.load().is_some_and(|v| v.get("tokens").is_some_and(|t| !t.is_null()))
    }

    fn tokens(&self) -> Option<Value> {
        self.store.load().and_then(|v| v.get("tokens").cloned()).filter(|t| !t.is_null())
    }

    fn post(&self, body: &Value, session: Option<&Session>) -> Result<Sent, MorphicError> {
        let agent = net::agent(Some(REQUEST_TIMEOUT));
        let mut req = agent.post(self.server.as_str()).header("content-type", "application/json").header("accept", "application/json, text/event-stream");
        if let Some(t) = self.tokens().and_then(|t| t.get("access_token").and_then(Value::as_str).map(str::to_string)) {
            req = req.header("Authorization", format!("Bearer {t}"));
        }
        if let Some(s) = session {
            if let Some(id) = &s.id {
                req = req.header("mcp-session-id", id);
            }
            req = req.header("mcp-protocol-version", &s.protocol);
        }
        let mut res = req.send(body.to_string().as_bytes())?;
        let status = res.status().as_u16();
        let header = |res: &ureq::http::Response<ureq::Body>, n: &str| res.headers().get(n).and_then(|v| v.to_str().ok()).map(str::to_string);
        if status == 401 {
            return Ok(Sent::Unauthorized(header(&res, "www-authenticate")));
        }
        if status == 404 && session.is_some_and(|s| s.id.is_some()) {
            return Ok(Sent::SessionGone);
        }
        if !(200..300).contains(&status) {
            let text = res.body_mut().read_to_string().unwrap_or_default();
            return Err(MorphicError::Other(format!("Error POSTing to endpoint: {text}")));
        }
        if status == 202 || body.get("id").is_none() {
            return Ok(Sent::Accepted);
        }
        let id = body.get("id").cloned().unwrap_or(Value::Null);
        let session_header = header(&res, "mcp-session-id");
        let content_type = header(&res, "content-type").unwrap_or_default();
        let mut reply = if content_type.contains("text/event-stream") {
            read_sse_response(res.body_mut().as_reader(), &id)?
        } else {
            let text = res.body_mut().with_config().limit(256 * 1024 * 1024).read_to_string().map_err(|e| e.to_string())?;
            serde_json::from_str::<Value>(&text).map_err(|e| e.to_string())?
        };
        if let Some(sid) = session_header {
            reply["__sessionId"] = json!(sid);
        }
        Ok(Sent::Ok(reply))
    }

    /// Discovery, then refresh or (when interactive) a browser sign-in.
    fn authorize(&self, www_auth: Option<&str>, interactive: bool) -> Result<(), MorphicError> {
        let hinted = www_auth.and_then(|h| www_authenticate_param(h, "resource_metadata")).and_then(|u| Url::parse(&u).ok());
        let d = discover(&self.server, hinted.as_ref())?;
        if let Some(refresh) = self.tokens().and_then(|t| t.get("refresh_token").and_then(Value::as_str).map(str::to_string)) {
            match token_request(&d, &self.client_id, &[("grant_type", "refresh_token"), ("refresh_token", &refresh)]) {
                Ok(mut tokens) => {
                    // Keep the refresh token if the server didn't send a new one.
                    if tokens.get("refresh_token").is_none() {
                        tokens["refresh_token"] = json!(refresh);
                    }
                    self.store.save(&json!({ "tokens": tokens }))?;
                    return Ok(());
                }
                Err(TokenFailure::Invalid) => self.store.clear(),
                Err(TokenFailure::Server) => {}
                Err(TokenFailure::Other(m)) => return Err(MorphicError::Other(m)),
            }
        }
        if !interactive {
            return Err(MorphicError::AuthRequired);
        }
        let state = crate::util::random_hex(16)?;
        let challenge = pkce()?;
        let redirect = redirect_url(self.redirect_port);
        let scope = www_auth.and_then(|h| www_authenticate_param(h, "scope")).filter(|s| !s.is_empty()).or_else(|| d.resource_scopes.clone().filter(|s| !s.is_empty())).unwrap_or_else(|| SCOPES.to_string());
        let authz = endpoint(&d, "authorization_endpoint", "/authorize")?;
        let url = authorization_url(&authz, d.metadata.as_ref(), &self.client_id, &redirect, &challenge.challenge, &state, &scope, d.resource.as_ref())?;
        let wait = AuthWait::start(self.redirect_port, self.sign_in_timeout, state)?;
        (self.open_browser)(url.as_str())?;
        let code = wait.wait()?;
        let tokens = token_request(&d, &self.client_id, &[("grant_type", "authorization_code"), ("code", &code), ("code_verifier", &challenge.verifier), ("redirect_uri", &redirect)]).map_err(|f| match f {
            TokenFailure::Other(m) => MorphicError::Other(m),
            _ => MorphicError::Other("Morphic sign-in failed while exchanging the code".into()),
        })?;
        self.store.save(&json!({ "tokens": tokens }))?;
        Ok(())
    }

    fn connect(&self, interactive: bool) -> Result<(), MorphicError> {
        let _gate = self.connecting.lock().unwrap();
        if self.session.lock().unwrap().is_some() {
            return Ok(());
        }
        let init = json!({ "jsonrpc": "2.0", "id": self.next_id(), "method": "initialize", "params": { "protocolVersion": PROTOCOL_VERSION, "capabilities": {}, "clientInfo": { "name": CLIENT_NAME, "version": CLIENT_VERSION } } });
        let mut authorized = false;
        let reply = loop {
            match self.post(&init, None)? {
                Sent::Ok(v) => break v,
                Sent::Accepted | Sent::SessionGone => return Err(MorphicError::Other("Morphic didn't answer initialize".into())),
                Sent::Unauthorized(www) => {
                    if authorized {
                        return Err(MorphicError::Other("Server returned 401 after successful authentication".into()));
                    }
                    self.authorize(www.as_deref(), interactive)?;
                    *self.www_auth.lock().unwrap() = www;
                    authorized = true;
                }
            }
        };
        if let Some(e) = reply.get("error") {
            return Err(MorphicError::Other(rpc_error_message(e)));
        }
        let protocol = reply.pointer("/result/protocolVersion").and_then(Value::as_str).unwrap_or("").to_string();
        if !SUPPORTED_VERSIONS.contains(&protocol.as_str()) {
            return Err(MorphicError::Other(format!("Server's protocol version is not supported: {protocol}")));
        }
        let session = Session { id: reply.get("__sessionId").and_then(Value::as_str).map(str::to_string), protocol };
        self.post(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }), Some(&session))?;
        *self.session.lock().unwrap() = Some(session);
        Ok(())
    }

    fn next_id(&self) -> u64 {
        self.seq.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
    }

    pub fn sign_in(&self) -> Result<(), MorphicError> {
        self.connect(true)
    }

    pub fn sign_out(&self) {
        self.disconnect();
        self.store.clear();
    }

    pub fn disconnect(&self) {
        let session = self.session.lock().unwrap().take();
        // Best effort, as Client.close() is; a stateless server answers 405.
        if let Some(Session { id: Some(id), protocol }) = session {
            let mut req = net::agent(Some(Duration::from_secs(5))).delete(self.server.as_str()).header("mcp-session-id", &id).header("mcp-protocol-version", &protocol);
            if let Some(t) = self.tokens().and_then(|t| t.get("access_token").and_then(Value::as_str).map(str::to_string)) {
                req = req.header("Authorization", format!("Bearer {t}"));
            }
            let _ = req.call();
        }
    }

    /// A JSON-RPC request over the session. Reconnects after the server drops a session, and
    /// refreshes once on a 401.
    fn request(&self, method: &str, params: Value) -> Result<Value, MorphicError> {
        self.connect(false)?;
        let mut refreshed = false;
        let mut reconnected = false;
        loop {
            let body = json!({ "jsonrpc": "2.0", "id": self.next_id(), "method": method, "params": params });
            let sent = {
                let guard = self.session.lock().unwrap();
                let s = guard.as_ref().ok_or(MorphicError::AuthRequired)?;
                Session { id: s.id.clone(), protocol: s.protocol.clone() }
            };
            match self.post(&body, Some(&sent))? {
                Sent::Ok(reply) => {
                    if let Some(e) = reply.get("error") {
                        return Err(MorphicError::Other(rpc_error_message(e)));
                    }
                    return Ok(reply.get("result").cloned().unwrap_or(Value::Null));
                }
                Sent::Accepted => return Err(MorphicError::Other("Morphic didn't answer the request".into())),
                Sent::SessionGone if !reconnected => {
                    reconnected = true;
                    *self.session.lock().unwrap() = None;
                    self.connect(false)?;
                }
                Sent::SessionGone => return Err(MorphicError::Other("Morphic session ended".into())),
                Sent::Unauthorized(www) => {
                    if refreshed {
                        self.disconnect();
                        return Err(MorphicError::AuthRequired);
                    }
                    refreshed = true;
                    if let Err(e) = self.authorize(www.as_deref(), false) {
                        *self.session.lock().unwrap() = None;
                        return Err(e);
                    }
                }
            }
        }
    }

    pub fn list_tools(&self) -> Result<Value, MorphicError> {
        Ok(self.request("tools/list", json!({}))?.get("tools").cloned().unwrap_or(Value::Null))
    }

    pub fn call_tool(&self, name: &str, args: Value) -> Result<Value, MorphicError> {
        self.request("tools/call", json!({ "name": name, "arguments": args }))
    }

    pub fn upload_file(&self, bytes: &[u8], content_type: &str, file_name: &str, project_id: Option<&str>) -> Result<String, MorphicError> {
        upload_to_morphic(&mut |n, a| self.call_tool(n, a), &mut http_put, bytes, content_type, file_name, project_id)
    }
}

fn rpc_error_message(e: &Value) -> String {
    let code = e.get("code").map(Value::to_string).unwrap_or_default();
    let msg = e.get("message").and_then(Value::as_str).unwrap_or("error");
    format!("MCP error {code}: {msg}")
}

/// First JSON-RPC response with this id in an SSE stream. Stops there: the stream may stay open.
fn read_sse_response(body: impl std::io::Read, id: &Value) -> Result<Value, MorphicError> {
    let reader = BufReader::new(body);
    let mut data = String::new();
    for line in reader.lines() {
        let line = line.map_err(|e| e.to_string())?;
        if line.is_empty() {
            if !data.is_empty() {
                if let Ok(v) = serde_json::from_str::<Value>(&data) {
                    if v.get("id") == Some(id) && (v.get("result").is_some() || v.get("error").is_some()) {
                        return Ok(v);
                    }
                }
            }
            data.clear();
        } else if let Some(v) = line.strip_prefix("data:") {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(v.strip_prefix(' ').unwrap_or(v));
        }
    }
    Err(MorphicError::Other("Morphic's stream ended without an answer".into()))
}

// ── Commands ────────────────────────────────────────────────────────────────

fn error_reply(e: &MorphicError) -> Value {
    json!({ "error": e.message() })
}

pub fn call_tool_reply(m: &Morphic, name: &str, args: Value) -> Value {
    if !RENDERER_TOOLS.contains(&name) {
        return json!({ "error": format!("Morphic tool not allowed: {name}") });
    }
    match m.call_tool(name, args) {
        Ok(r) => json!({ "result": { "structuredContent": r.get("structuredContent"), "content": r.get("content"), "isError": r.get("isError").and_then(Value::as_bool).unwrap_or(false) } }),
        Err(e) => error_reply(&e),
    }
}

#[tauri::command]
pub async fn morphic_status(ctx: State<'_, Ctx>) -> Result<Value, String> {
    Ok(blocking(|| json!({ "signedIn": ctx.morphic.is_signed_in() })))
}

#[tauri::command]
pub async fn morphic_sign_in(ctx: State<'_, Ctx>) -> Result<Value, String> {
    Ok(blocking(|| match ctx.morphic.sign_in() {
        Ok(()) => json!({ "ok": true }),
        Err(e) => error_reply(&e),
    }))
}

#[tauri::command]
pub async fn morphic_sign_out(ctx: State<'_, Ctx>) -> Result<Value, String> {
    blocking(|| ctx.morphic.sign_out());
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn morphic_call_tool(name: String, args: Option<Value>, ctx: State<'_, Ctx>) -> Result<Value, String> {
    Ok(blocking(|| call_tool_reply(&ctx.morphic, &name, args.unwrap_or_else(|| json!({})))))
}

#[tauri::command]
pub async fn morphic_upload(request: Request<'_>, ctx: State<'_, Ctx>) -> Result<Value, String> {
    let (ct, name, project) = (header(&request, "x-content-type")?, header(&request, "x-file-name")?, header_opt(&request, "x-project-id")?);
    let body = raw_body(&request)?;
    Ok(blocking(|| match ctx.morphic.upload_file(body, &ct, &name, project.as_deref()) {
        Ok(id) => json!({ "assetId": id }),
        Err(e) => error_reply(&e),
    }))
}

#[tauri::command]
pub async fn morphic_download(url: String, ctx: State<'_, Ctx>) -> Result<Response, String> {
    let parsed = Url::parse(&url).map_err(|e| e.to_string())?;
    if parsed.scheme() != "https" {
        return Err("Morphic result URL must be https".into());
    }
    blocking(|| net::guarded_download(ctx.net.as_ref(), &url)).map(Response::new)
}

#[cfg(test)]
mod tests {
    //! Port of apps/desktop/test/morphic-client.test.ts, plus negative OAuth tests and a comparison
    //! with the official SDK's requests.
    use super::*;
    use crate::util::testutil::{mock, Mock, Reply};
    use std::collections::{BTreeMap, BTreeSet};
    
    #[derive(Default)]
    struct Mem(Mutex<Option<Value>>);
    impl TokenStore for Mem {
        fn load(&self) -> Option<Value> {
            self.0.lock().unwrap().clone()
        }
        fn save(&self, v: &Value) -> Result<(), String> {
            *self.0.lock().unwrap() = Some(v.clone());
            Ok(())
        }
        fn clear(&self) {
            *self.0.lock().unwrap() = None;
        }
    }

    fn ok_result(v: Value) -> Value {
        json!({ "structuredContent": v, "content": [] })
    }

    fn prep() -> Value {
        json!({ "upload_url": "https://upload.example/put", "method": "PUT", "headers": { "x-amz-acl": "private", "content-type": "image/png" }, "import_url": "https://import.example/i", "project_id": "proj", "name": "kai.png" })
    }

    #[test]
    fn upload_prepares_puts_with_exactly_the_returned_headers_imports_and_returns_the_id() {
        let mut calls = vec![];
        let mut puts = vec![];
        let id = upload_to_morphic(
            &mut |n, a| {
                calls.push((n.to_string(), a));
                Ok(if n == "prepare_media_upload" { ok_result(prep()) } else { ok_result(json!({ "asset": { "id": "asset-1" } })) })
            },
            &mut |u, h, b| {
                puts.push((u.to_string(), h.clone(), b.to_vec()));
                Ok(200)
            },
            &[1, 2, 3],
            "image/png",
            "kai.png",
            Some("proj"),
        )
        .unwrap();
        assert_eq!(id, "asset-1");
        assert_eq!(calls[0], ("prepare_media_upload".to_string(), json!({ "filename": "kai.png", "content_type": "image/png", "size_bytes": 3, "project_id": "proj" })));
        assert_eq!(puts[0].0, "https://upload.example/put");
        assert_eq!(puts[0].1, prep()["headers"]);
        assert_eq!(calls[1], ("import_media_from_url".to_string(), json!({ "url": "https://import.example/i", "name": "kai.png", "project_id": "proj" })));
    }

    #[test]
    fn a_failed_put_stops_before_import() {
        let mut calls = vec![];
        let e = upload_to_morphic(
            &mut |n, _| {
                calls.push(n.to_string());
                Ok(ok_result(prep()))
            },
            &mut |_, _, _| Ok(403),
            &[1],
            "image/png",
            "a.png",
            None,
        )
        .unwrap_err();
        assert!(e.message().contains("HTTP 403"));
        assert_eq!(calls, ["prepare_media_upload"]);
    }

    #[test]
    fn morphics_tool_error_text_is_surfaced() {
        let e = upload_to_morphic(&mut |_, _| Ok(json!({ "isError": true, "content": [{ "type": "text", "text": "File too large" }] })), &mut |_, _, _| Ok(200), &[1], "image/png", "a.png", None).unwrap_err();
        assert_eq!(e.message(), "File too large");
    }

    #[test]
    fn identifies_the_app_by_its_metadata_url_and_loopback_redirect() {
        assert_eq!(CLIENT_METADATA_URL, "https://jdmghk.github.io/frontstage/morphic/client.json");
        assert_eq!(redirect_url(REDIRECT_PORT), "http://127.0.0.1:53917/morphic/callback");
        assert_eq!(SCOPES, "projects:read assets:read assets:write generations:write");
    }

    #[test]
    fn tokens_round_trip_through_the_store_and_clear() {
        let s = Arc::new(Mem::default());
        let m = Morphic::with_config("https://x.example/mcp", "https://c.example/c.json", 1, Duration::from_secs(1), s.clone(), Box::new(|_| Ok(())));
        s.save(&json!({ "tokens": { "access_token": "a", "token_type": "bearer" } })).unwrap();
        assert_eq!(m.tokens().unwrap()["access_token"], "a");
        s.clear();
        assert!(m.tokens().is_none());
    }

    #[test]
    fn the_renderer_may_start_generations_and_read_but_not_delete_edit_or_upload_directly() {
        for t in ["generate_video", "edit_image", "wait_for_generations", "list_projects"] {
            assert!(RENDERER_TOOLS.contains(&t));
        }
        for t in ["prepare_media_upload", "import_media_from_url", "filmlab_edit", "morphic_3d_replace_scene"] {
            assert!(!RENDERER_TOOLS.contains(&t));
        }
    }

    #[test]
    fn a_disallowed_tool_is_refused_without_any_request() {
        let m = mock(|_| Reply::new(500, ""));
        let c = Morphic::with_config(&format!("{}/mcp", m.base()), "https://c.example/c.json", 1, Duration::from_secs(1), Arc::new(Mem::default()), Box::new(|_| Ok(())));
        assert_eq!(call_tool_reply(&c, "prepare_media_upload", json!({}))["error"], "Morphic tool not allowed: prepare_media_upload");
        assert!(m.seen().is_empty());
    }

    // ── Loopback, including the state check ──
    fn port() -> u16 {
        TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
    }

    fn get(port: u16, path: &str) -> (u16, String) {
        let mut r = net::agent(Some(Duration::from_secs(5))).get(format!("http://127.0.0.1:{port}{path}")).call().unwrap();
        (r.status().as_u16(), r.body_mut().read_to_string().unwrap_or_default())
    }

    #[test]
    fn resolves_with_the_code_from_the_loopback_redirect() {
        let p = port();
        let w = AuthWait::start(p, Duration::from_secs(5), "s".into()).unwrap();
        let (status, body) = get(p, "/morphic/callback?code=abc&state=s");
        assert_eq!(status, 200);
        assert!(body.contains("Signed in to Morphic"));
        assert_eq!(w.wait().unwrap(), "abc");
    }

    #[test]
    fn rejects_with_morphics_error_description_when_denied() {
        let p = port();
        let w = AuthWait::start(p, Duration::from_secs(5), "s".into()).unwrap();
        get(p, "/morphic/callback?error=access_denied&error_description=access%20denied%20by%20user&state=s");
        assert!(w.wait().unwrap_err().contains("access denied by user"));
    }

    #[test]
    fn times_out() {
        let w = AuthWait::start(port(), Duration::from_millis(30), "s".into()).unwrap();
        assert!(w.wait().unwrap_err().contains("timed out"));
    }

    #[test]
    fn a_wrong_or_missing_state_is_rejected_and_the_real_redirect_still_works() {
        let p = port();
        let w = AuthWait::start(p, Duration::from_secs(5), "right".into()).unwrap();
        // An attacker page racing the browser, with a code of its own.
        assert_eq!(get(p, "/morphic/callback?code=evil&state=wrong").0, 400);
        assert_eq!(get(p, "/morphic/callback?code=evil").0, 400);
        assert_eq!(get(p, "/morphic/callback?error=access_denied").0, 400);
        assert_eq!(get(p, "/other?code=evil&state=right").0, 404);
        assert_eq!(get(p, "/morphic/callback?code=good&state=right").0, 200);
        assert_eq!(w.wait().unwrap(), "good");
    }

    #[test]
    fn a_taken_port_is_a_clear_error() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let p = l.local_addr().unwrap().port();
        let e = AuthWait::start(p, Duration::from_secs(1), "s".into()).err().unwrap();
        assert!(e.contains(&format!("Port {p} is in use")), "{e}");
    }

    // ── Mock Morphic: MCP plus an OAuth server ──
    struct Fake {
        mock: Mock,
    }

    fn fake(require_token: &'static str, offer_refresh: bool) -> Fake {
        let base = Arc::new(Mutex::new(String::new()));
        let b = base.clone();
        let m = mock(move |s| {
            let base = b.lock().unwrap().clone();
            let path = s.url.split('?').next().unwrap();
            match (s.method.as_str(), path) {
                ("GET", "/.well-known/oauth-protected-resource/mcp") => Reply::json(200, json!({ "resource": format!("{base}/mcp"), "authorization_servers": [format!("{base}/")], "scopes_supported": ["assets:read"] })),
                ("GET", "/.well-known/oauth-authorization-server") => Reply::json(200, json!({ "issuer": base, "authorization_endpoint": format!("{base}/authorize"), "token_endpoint": format!("{base}/token"), "response_types_supported": ["code"], "code_challenge_methods_supported": ["S256"], "client_id_metadata_document_supported": true })),
                ("POST", "/token") => {
                    let form: BTreeMap<String, String> = url::form_urlencoded::parse(&s.body).into_owned().collect();
                    if form["grant_type"] == "refresh_token" && !offer_refresh {
                        return Reply::json(400, json!({ "error": "invalid_grant" }));
                    }
                    Reply::json(200, json!({ "access_token": "fresh", "token_type": "bearer", "refresh_token": "r2" }))
                }
                ("POST", "/mcp") => {
                    if s.header("authorization") != Some(&format!("Bearer {require_token}")) {
                        return Reply::new(401, "").with("www-authenticate", &format!("Bearer resource_metadata=\"{base}/.well-known/oauth-protected-resource/mcp\""));
                    }
                    let msg = s.json();
                    let id = msg["id"].clone();
                    match msg["method"].as_str().unwrap_or("") {
                        "initialize" => Reply::json(200, json!({ "jsonrpc": "2.0", "id": id, "result": { "protocolVersion": msg["params"]["protocolVersion"], "capabilities": {}, "serverInfo": { "name": "m", "version": "1" } } })).with("mcp-session-id", "sess-1"),
                        "notifications/initialized" => Reply::new(202, ""),
                        "tools/list" => {
                            let body = format!("event: message\ndata: {}\n\n", json!({ "jsonrpc": "2.0", "id": id, "result": { "tools": [{ "name": "generate_video" }] } }));
                            Reply::new(200, body).with("content-type", "text/event-stream")
                        }
                        "tools/call" => Reply::json(200, json!({ "jsonrpc": "2.0", "id": id, "result": { "structuredContent": { "ok": true }, "content": [], "isError": false } })),
                        _ => Reply::new(400, ""),
                    }
                }
                ("DELETE", "/mcp") => Reply::new(405, ""),
                _ => Reply::new(404, ""),
            }
        });
        *base.lock().unwrap() = m.base();
        Fake { mock: m }
    }

    fn client(f: &Fake, store: Arc<Mem>, port: u16, opener: Box<dyn Fn(&str) -> Result<(), String> + Send + Sync>) -> Morphic {
        Morphic::with_config(&format!("{}/mcp", f.mock.base()), "https://c.example/c.json", port, Duration::from_secs(10), store, opener)
    }

    #[test]
    fn a_non_interactive_call_with_no_sign_in_reports_auth_required_and_opens_no_browser() {
        let f = fake("fresh", false);
        let opened = Arc::new(Mutex::new(false));
        let o = opened.clone();
        let store = Arc::new(Mem::default());
        let c = client(&f, store, 1, Box::new(move |_| { *o.lock().unwrap() = true; Ok(()) }));
        assert_eq!(c.list_tools().unwrap_err(), MorphicError::AuthRequired);
        assert!(!*opened.lock().unwrap());
        assert!(!c.is_signed_in());
    }

    #[test]
    fn signed_in_tools_are_listed_over_the_connected_session() {
        let f = fake("a", false);
        let c = client(&f, Arc::new(Mem(Mutex::new(Some(json!({ "tokens": { "access_token": "a", "token_type": "bearer" } }))))), 1, Box::new(|_| Ok(())));
        assert!(c.is_signed_in());
        assert_eq!(c.list_tools().unwrap(), json!([{ "name": "generate_video" }]));
        let seen = f.mock.seen();
        let list = seen.iter().find(|s| s.json()["method"] == "tools/list").unwrap();
        assert_eq!(list.header("mcp-session-id").unwrap(), "sess-1");
        assert_eq!(list.header("mcp-protocol-version").unwrap(), PROTOCOL_VERSION);
        assert!(list.header("accept").unwrap().contains("text/event-stream"));
    }

    #[test]
    fn sign_out_clears_the_stored_tokens() {
        let f = fake("a", false);
        let store = Arc::new(Mem(Mutex::new(Some(json!({ "tokens": { "access_token": "a" } })))));
        let c = client(&f, store.clone(), 1, Box::new(|_| Ok(())));
        c.sign_out();
        assert!(store.load().is_none());
    }

    #[test]
    fn expired_tokens_refresh_without_a_browser_and_keep_working() {
        let f = fake("fresh", true);
        let store = Arc::new(Mem(Mutex::new(Some(json!({ "tokens": { "access_token": "old", "token_type": "bearer", "refresh_token": "r1" } })))));
        let c = client(&f, store.clone(), 1, Box::new(|_| Err("no browser".into())));
        assert_eq!(c.call_tool("list_projects", json!({})).unwrap()["structuredContent"]["ok"], true);
        assert_eq!(store.load().unwrap()["tokens"]["access_token"], "fresh");
        let seen = f.mock.seen();
        let refresh = seen.iter().find(|s| s.url == "/token").unwrap();
        let form: BTreeMap<String, String> = url::form_urlencoded::parse(&refresh.body).into_owned().collect();
        assert_eq!(form["grant_type"], "refresh_token");
        assert_eq!(form["refresh_token"], "r1");
        assert_eq!(form["client_id"], "https://c.example/c.json");
    }

    #[test]
    fn an_invalid_refresh_token_clears_tokens_and_reports_auth_required() {
        let f = fake("fresh", false);
        let store = Arc::new(Mem(Mutex::new(Some(json!({ "tokens": { "access_token": "old", "refresh_token": "r1" } })))));
        let c = client(&f, store.clone(), 1, Box::new(|_| Err("no browser".into())));
        assert_eq!(c.list_tools().unwrap_err(), MorphicError::AuthRequired);
        assert!(store.load().is_none());
    }

    fn browser_that_completes(port: u16, tamper_state: bool) -> Box<dyn Fn(&str) -> Result<(), String> + Send + Sync> {
        Box::new(move |url: &str| {
            let u = Url::parse(url).map_err(|e| e.to_string())?;
            let q: BTreeMap<String, String> = u.query_pairs().into_owned().collect();
            let state = if tamper_state { "evil".to_string() } else { q["state"].clone() };
            let target = format!("http://127.0.0.1:{port}{}?code=the-code&state={state}", REDIRECT_PATH);
            std::thread::spawn(move || {
                let _ = net::agent(Some(Duration::from_secs(5))).get(&target).call();
            });
            Ok(())
        })
    }

    #[test]
    fn interactive_sign_in_runs_pkce_and_stores_tokens() {
        let f = fake("fresh", false);
        let p = port();
        let store = Arc::new(Mem::default());
        let urls = Arc::new(Mutex::new(String::new()));
        let (u2, browser) = (urls.clone(), browser_that_completes(p, false));
        let c = client(&f, store.clone(), p, Box::new(move |u| { *u2.lock().unwrap() = u.to_string(); browser(u) }));
        c.sign_in().unwrap();
        assert_eq!(store.load().unwrap()["tokens"]["access_token"], "fresh");

        let auth = Url::parse(&urls.lock().unwrap()).unwrap();
        let q: BTreeMap<String, String> = auth.query_pairs().into_owned().collect();
        assert_eq!(auth.path(), "/authorize");
        assert_eq!(q["client_id"], "https://c.example/c.json");
        assert_eq!(q["response_type"], "code");
        assert_eq!(q["code_challenge_method"], "S256");
        assert_eq!(q["redirect_uri"], redirect_url(p));
        assert_eq!(q["scope"], "assets:read");
        assert_eq!(q["resource"], format!("{}/mcp", f.mock.base()));
        assert_eq!(q["state"].len(), 32);

        let seen = f.mock.seen();
        let token = seen.iter().find(|s| s.url == "/token").unwrap();
        let form: BTreeMap<String, String> = url::form_urlencoded::parse(&token.body).into_owned().collect();
        assert_eq!(form["grant_type"], "authorization_code");
        assert_eq!(form["code"], "the-code");
        assert_eq!(form["redirect_uri"], redirect_url(p));
        // The verifier actually hashes to the challenge sent earlier.
        assert_eq!(base64_url(&Sha256::digest(form["code_verifier"].as_bytes())), q["code_challenge"]);
    }

    #[test]
    fn a_redirect_with_the_wrong_state_never_exchanges_a_code() {
        let f = fake("fresh", false);
        let p = port();
        let store = Arc::new(Mem::default());
        let c = Morphic::with_config(&format!("{}/mcp", f.mock.base()), "https://c.example/c.json", p, Duration::from_millis(600), store.clone(), browser_that_completes(p, true));
        assert!(c.sign_in().unwrap_err().message().contains("timed out"));
        assert!(store.load().is_none());
        assert!(!f.mock.seen().iter().any(|s| s.url == "/token"), "no token request may be sent");
    }

    #[test]
    fn a_protected_resource_on_another_origin_is_refused() {
        let server = Url::parse("https://mcp.morphic.com/mcp").unwrap();
        assert!(resource_allowed(&server, &Url::parse("https://mcp.morphic.com/mcp").unwrap()));
        assert!(resource_allowed(&server, &Url::parse("https://mcp.morphic.com/").unwrap()));
        assert!(!resource_allowed(&server, &Url::parse("https://evil.com/mcp").unwrap()));
        assert!(!resource_allowed(&server, &Url::parse("http://mcp.morphic.com/mcp").unwrap()));
        assert!(!resource_allowed(&server, &Url::parse("https://mcp.morphic.com/mcp/deeper").unwrap()));
        assert!(!resource_allowed(&Url::parse("https://mcp.morphic.com/mcp123").unwrap(), &Url::parse("https://mcp.morphic.com/mcp").unwrap()));
    }

    #[test]
    fn auth_servers_without_code_flow_or_s256_are_refused() {
        let u = Url::parse("https://a.example/authorize").unwrap();
        let go = |m: Value| authorization_url(&u, Some(&m), "c", "r", "ch", "st", "", None);
        assert!(go(json!({ "response_types_supported": ["token"] })).unwrap_err().contains("response type"));
        assert!(go(json!({ "response_types_supported": ["code"], "code_challenge_methods_supported": ["plain"] })).unwrap_err().contains("S256"));
        assert!(go(json!({ "response_types_supported": ["code"] })).is_ok());
    }

    #[test]
    fn www_authenticate_parsing() {
        let h = r#"Bearer error="invalid_token", resource_metadata="https://x/y", scope="a b""#;
        assert_eq!(www_authenticate_param(h, "resource_metadata").unwrap(), "https://x/y");
        assert_eq!(www_authenticate_param(h, "scope").unwrap(), "a b");
        assert_eq!(www_authenticate_param(h, "missing"), None);
        assert_eq!(www_authenticate_param("Basic realm=x", "realm"), None);
    }

    #[test]
    fn pkce_verifier_is_valid_and_hashes_to_its_challenge() {
        let p = pkce().unwrap();
        assert_eq!(p.verifier.len(), 43);
        assert!(p.verifier.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
        assert_eq!(p.challenge, base64_url(&Sha256::digest(p.verifier.as_bytes())));
        assert_ne!(pkce().unwrap().verifier, p.verifier);
    }

    // Runs the official SDK and this client against the same mock, and compares what each sent. As a
    // set of requests: the SDK runs discovery a second time before exchanging the code.
    #[test]
    fn requests_match_the_official_sdk_apart_from_the_added_state() {
        let desktop = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../desktop");
        if !desktop.join("node_modules/@modelcontextprotocol/sdk").exists() {
            eprintln!("SKIPPED: no @modelcontextprotocol/sdk");
            return;
        }
        let shape = |m: &Mock| -> BTreeSet<(String, String, BTreeSet<String>)> {
            m.seen()
                .iter()
                .filter(|s| s.method != "GET" || !s.url.contains("/mcp?"))
                .map(|s| {
                    let path = s.url.split('?').next().unwrap().to_string();
                    let keys: BTreeSet<String> = if path == "/token" {
                        url::form_urlencoded::parse(&s.body).map(|(k, _)| k.into_owned()).collect()
                    } else if s.method == "POST" {
                        [s.json()["method"].as_str().unwrap_or("").to_string()].into()
                    } else {
                        BTreeSet::new()
                    };
                    (s.method.clone(), path, keys)
                })
                .filter(|(method, path, _)| !(method == "GET" && path == "/mcp"))
                .collect()
        };

        let rust_fake = fake("fresh", false);
        let p = port();
        let auth_url = Arc::new(Mutex::new(String::new()));
        let (a2, browser) = (auth_url.clone(), browser_that_completes(p, false));
        let c = client(&rust_fake, Arc::new(Mem::default()), p, Box::new(move |u| { *a2.lock().unwrap() = u.to_string(); browser(u) }));
        c.sign_in().unwrap();
        let rust_shape = shape(&rust_fake.mock);
        let rust_auth: BTreeSet<String> = Url::parse(&auth_url.lock().unwrap()).unwrap().query_pairs().map(|(k, _)| k.into_owned()).collect();

        let sdk_fake = fake("fresh", false);
        let script = format!(
            r#"import {{ Client }} from "@modelcontextprotocol/sdk/client/index.js";
import {{ StreamableHTTPClientTransport }} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {{ UnauthorizedError }} from "@modelcontextprotocol/sdk/client/auth.js";
let tokens, verifier, authUrl;
const provider = {{
  clientMetadataUrl: "https://c.example/c.json",
  get redirectUrl() {{ return "http://127.0.0.1:1/morphic/callback"; }},
  get clientMetadata() {{ return {{ client_name: "x", redirect_uris: [this.redirectUrl], grant_types: ["authorization_code","refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", scope: "s" }}; }},
  clientInformation() {{ return {{ client_id: "https://c.example/c.json" }}; }},
  tokens() {{ return tokens; }},
  saveTokens(t) {{ tokens = t; }},
  redirectToAuthorization(u) {{ authUrl = u; }},
  saveCodeVerifier(v) {{ verifier = v; }},
  codeVerifier() {{ return verifier; }},
}};
const url = new URL("{base}/mcp");
let t = new StreamableHTTPClientTransport(url, {{ authProvider: provider }});
let c = new Client({{ name: "frontstage-studio", version: "0.2.0" }});
try {{ await c.connect(t); }} catch (e) {{ if (!(e instanceof UnauthorizedError)) throw e; }}
await t.finishAuth("the-code");
t = new StreamableHTTPClientTransport(url, {{ authProvider: provider }});
c = new Client({{ name: "frontstage-studio", version: "0.2.0" }});
await c.connect(t);
console.log(JSON.stringify([...authUrl.searchParams.keys()]));
process.exit(0);"#,
            base = sdk_fake.mock.base()
        );
        let out = std::process::Command::new("node").args(["--input-type=module", "-e", &script]).current_dir(&desktop).output().expect("node");
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let sdk_auth: BTreeSet<String> = serde_json::from_slice::<Vec<String>>(&out.stdout).unwrap().into_iter().collect();
        let sdk_shape = shape(&sdk_fake.mock);

        let mut expected_auth = sdk_auth;
        expected_auth.insert("state".into());
        assert_eq!(rust_auth, expected_auth);
        assert_eq!(rust_shape, sdk_shape);
    }
}
