//! claude:run: Anthropic Messages over raw HTTP, since there's no official Rust SDK. Matches
//! packages/ai/src/studio/claude-wire.ts and claude-studio.mjs, and the wire behaviour of
//! @anthropic-ai/sdk 1.3.0's beta.messages.stream().finalMessage() with maxRetries 3.

use std::io::{BufRead, BufReader};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::State;

use crate::net;
use crate::util::blocking;
use crate::{ai, Ctx};

pub const ALLOWED_MODELS: [&str; 2] = ["claude-opus-5-5", "claude-sonnet-5-5"];
const EFFORTS: [&str; 3] = ["low", "medium", "high"];
const MAX_TOKENS_CAP: i64 = 64000;
const MAX_IMAGES: usize = 20;
const IMAGE_TYPES: [&str; 4] = ["image/png", "image/jpeg", "image/webp", "image/gif"];
pub const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";
const API_VERSION: &str = "2026-10-21";
const API_BASE: &str = "https://api.anthropic.com";
const MAX_RETRIES: u32 = 3;
// The SDK's streaming default.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(600);

/// Validates the renderer's request and builds the JSON body. `stream` is added when sending.
pub fn build_params(req: &Value) -> Result<Value, String> {
    let Some(obj) = req.as_object() else { return Err("invalid request".into()) };
    let model = obj.get("model").and_then(Value::as_str);
    let Some(model) = model.filter(|m| ALLOWED_MODELS.contains(m)) else {
        return Err(format!("model not allowed: {}", js_string(obj.get("model"))));
    };
    let (system, prompt) = match (obj.get("system").and_then(Value::as_str), obj.get("prompt").and_then(Value::as_str)) {
        (Some(s), Some(p)) if !p.trim().is_empty() => (s, p),
        _ => return Err("system and prompt are required".into()),
    };
    let schema = obj.get("schema").filter(|s| s.is_object() && s.get("type").and_then(Value::as_str) == Some("object"));
    let Some(schema) = schema else { return Err("schema must be a JSON object schema".into()) };
    let effort = obj.get("effort").and_then(Value::as_str);
    let Some(effort) = effort.filter(|e| EFFORTS.contains(e)) else {
        return Err(format!("effort not allowed: {}", js_string(obj.get("effort"))));
    };
    let max_tokens = obj.get("maxTokens").and_then(Value::as_i64).filter(|n| (256..=MAX_TOKENS_CAP).contains(n));
    let Some(max_tokens) = max_tokens else { return Err("maxTokens out of range".into()) };
    let empty = vec![];
    let images = match obj.get("images") {
        None => &empty,
        Some(Value::Array(a)) if a.len() <= MAX_IMAGES => a,
        Some(_) => return Err("too many images".into()),
    };
    let mut content: Vec<Value> = Vec::with_capacity(images.len() + 1);
    for img in images {
        let media = img.get("mediaType").and_then(Value::as_str).filter(|m| IMAGE_TYPES.contains(m));
        let (Some(media), Some(data)) = (media, img.get("base64").and_then(Value::as_str)) else {
            return Err("invalid image".into());
        };
        content.push(json!({ "type": "image", "source": { "type": "base64", "media_type": media, "data": data } }));
    }
    content.push(json!({ "type": "text", "text": prompt }));
    Ok(json!({
        "model": model,
        "max_tokens": max_tokens,
        "system": system,
        "messages": [{ "role": "user", "content": content }],
        "output_config": { "effort": effort, "format": { "type": "json_schema", "schema": schema } },
        "fallbacks": "default",
    }))
}

fn js_string(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => "undefined".to_string(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    }
}

fn fail(kind: &str, error: impl Into<String>) -> Value {
    json!({ "ok": false, "kind": kind, "error": error.into() })
}

/// Final message to { ok, json } or a typed failure. Partial text is never returned as success.
pub fn interpret_message(message: &Value) -> Value {
    let stop = message.get("stop_reason").and_then(Value::as_str);
    if stop == Some("refusal") {
        let category = message.pointer("/stop_details/category").and_then(Value::as_str).filter(|c| !c.is_empty());
        let suffix = category.map(|c| format!(" ({c})")).unwrap_or_default();
        return fail("refusal", format!("Claude declined this request{suffix}. Rephrase the idea or scene and try again."));
    }
    if stop == Some("max_tokens") {
        return fail("truncated", "Claude's answer was cut off before it finished. Try a shorter scene or fewer shots.");
    }
    let empty = vec![];
    let blocks = message.get("content").and_then(Value::as_array).unwrap_or(&empty);
    // After a mid-stream fallback the content is: the declined model's partial text, a "fallback"
    // block, then the answer. Only what follows the last fallback block is the answer.
    let start = blocks.iter().rposition(|b| b.get("type").and_then(Value::as_str) == Some("fallback")).map_or(0, |i| i + 1);
    let text: String = blocks[start..].iter().filter(|b| b.get("type").and_then(Value::as_str) == Some("text")).filter_map(|b| b.get("text").and_then(Value::as_str)).collect();
    match serde_json::from_str::<Value>(&text) {
        Ok(j) => json!({ "ok": true, "json": j }),
        Err(_) => fail("invalid", "Claude's answer wasn't valid JSON."),
    }
}

/// The SDK's error message: "<status> <error.message or the JSON body>".
fn api_message(status: Option<u16>, body: &str) -> String {
    let parsed: Option<Value> = serde_json::from_str(body).ok();
    let msg = match &parsed {
        Some(v) => match v.get("message") {
            Some(Value::String(s)) => s.clone(),
            Some(other) => other.to_string(),
            None => v.to_string(),
        },
        None => body.to_string(),
    };
    match (status, msg.is_empty()) {
        (Some(s), false) => format!("{s} {msg}"),
        (Some(s), true) => format!("{s} status code (no body)"),
        (None, false) => msg,
        (None, true) => "(no status code or body)".to_string(),
    }
}

/// classifyError, from the HTTP status the SDK's typed errors are built on.
pub fn classify_status(status: u16, body: &str) -> Value {
    let message = api_message(Some(status), body);
    match status {
        401 | 403 => fail("auth", "The Anthropic API key was rejected. Check it in Settings \u{2192} Agent \u{2192} Anthropic."),
        429 => fail("rate-limit", "Anthropic rate limit reached. Wait a minute and try again."),
        400 => fail("api", format!("Anthropic rejected the request: {message}")),
        s => fail("api", format!("Anthropic API error {s}: {message}")),
    }
}

/// x-should-retry wins, then 408, 409, 429 and 5xx, as in the SDK.
fn should_retry(status: u16, header: Option<&str>) -> bool {
    match header {
        Some("true") => true,
        Some("false") => false,
        _ => matches!(status, 408 | 409 | 429) || status >= 500,
    }
}

/// retry-after-ms, then retry-after in seconds (0-60), else backoff from 0.5 s to 8 s with up to
/// 25% jitter taken off.
fn retry_delay(attempt: u32, retry_after_ms: Option<&str>, retry_after: Option<&str>) -> Duration {
    let parse = |v: Option<&str>, scale: f64| v.and_then(|s| s.parse::<f64>().ok()).map(|n| n * scale);
    let hinted = parse(retry_after_ms, 1.0).or_else(|| parse(retry_after, 1000.0)).filter(|ms| (0.0..60_000.0).contains(ms));
    if let Some(ms) = hinted {
        return Duration::from_millis(ms as u64);
    }
    let secs = (0.5 * 2f64.powi(attempt as i32)).min(8.0);
    let mut b = [0u8; 1];
    let _ = getrandom::fill(&mut b);
    let jitter = 1.0 - (f64::from(b[0]) / 255.0) * 0.25;
    Duration::from_secs_f64(secs * jitter)
}

/// Folds an SSE stream into the final message, the way the SDK's stream snapshot does.
pub struct Accumulator {
    message: Option<Value>,
}

pub enum SseStep {
    Continue,
    /// An `error` event mid-stream.
    Failed(String),
}

impl Accumulator {
    pub fn new() -> Self {
        Accumulator { message: None }
    }

    pub fn event(&mut self, name: &str, data: &str) -> SseStep {
        if name == "error" {
            return SseStep::Failed(api_message(None, data));
        }
        let Ok(ev) = serde_json::from_str::<Value>(data) else { return SseStep::Continue };
        match name {
            "message_start" => self.message = ev.get("message").cloned(),
            "content_block_start" => {
                if let (Some(m), Some(b)) = (&mut self.message, ev.get("content_block")) {
                    if let Some(c) = m.get_mut("content").and_then(Value::as_array_mut) {
                        c.push(b.clone());
                    }
                }
            }
            "content_block_delta" => {
                let index = ev.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                let text = ev.pointer("/delta/text").and_then(Value::as_str);
                let is_text = ev.pointer("/delta/type").and_then(Value::as_str) == Some("text_delta");
                if let (true, Some(text), Some(m)) = (is_text, text, &mut self.message) {
                    if let Some(slot) = m.pointer_mut(&format!("/content/{index}/text")) {
                        let joined = format!("{}{text}", slot.as_str().unwrap_or(""));
                        *slot = Value::String(joined);
                    }
                }
            }
            "message_delta" => {
                if let (Some(m), Some(d)) = (&mut self.message, ev.get("delta")) {
                    for k in ["stop_reason", "stop_sequence", "stop_details"] {
                        if let Some(v) = d.get(k) {
                            m[k] = v.clone();
                        }
                    }
                }
            }
            _ => {}
        }
        SseStep::Continue
    }

    pub fn finish(self) -> Option<Value> {
        self.message
    }
}

fn read_sse(body: impl std::io::Read, acc: &mut Accumulator) -> Result<(), SseError> {
    let reader = BufReader::new(body);
    let (mut event, mut data) = (String::new(), String::new());
    for line in reader.lines() {
        let line = line.map_err(|e| SseError::Transport(e.to_string()))?;
        if line.is_empty() {
            if !event.is_empty() {
                if let SseStep::Failed(m) = acc.event(&event, &data) {
                    return Err(SseError::Api(m));
                }
            }
            event.clear();
            data.clear();
        } else if let Some(v) = line.strip_prefix("event:") {
            event = v.trim().to_string();
        } else if let Some(v) = line.strip_prefix("data:") {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(v.strip_prefix(' ').unwrap_or(v));
        }
    }
    Ok(())
}

enum SseError {
    Transport(String),
    Api(String),
}

/// One request. `base` is api.anthropic.com in production.
pub fn run_claude_studio(base: &str, api_key: Option<&str>, req: &Value) -> Value {
    run_with_delay(base, api_key, req, std::thread::sleep)
}

fn run_with_delay(base: &str, api_key: Option<&str>, req: &Value, sleep: impl Fn(Duration)) -> Value {
    let Some(key) = api_key.filter(|k| !k.is_empty()) else {
        return fail("no-key", "Add your Anthropic API key in Settings \u{2192} Agent \u{2192} Anthropic.");
    };
    let mut params = match build_params(req) {
        Ok(p) => p,
        Err(e) => return fail("invalid", e),
    };
    params["stream"] = json!(true);
    let body = params.to_string();
    let agent = net::agent(Some(REQUEST_TIMEOUT));
    let url = format!("{base}/v1/messages?beta=true");

    let mut attempt = 0;
    loop {
        let sent = agent
            .post(&url)
            .header("x-api-key", key)
            .header("anthropic-version", API_VERSION)
            .header("anthropic-beta", FALLBACK_BETA)
            .header("content-type", "application/json")
            .header("accept", "text/event-stream")
            .send(body.as_bytes());
        let mut res = match sent {
            Ok(r) => r,
            Err(e) => {
                if attempt < MAX_RETRIES {
                    sleep(retry_delay(attempt, None, None));
                    attempt += 1;
                    continue;
                }
                return fail("api", format!("Could not reach Anthropic: {e}"));
            }
        };
        let status = res.status().as_u16();
        if !(200..300).contains(&status) {
            let headers = res.headers().clone();
            let h = |n: &str| headers.get(n).and_then(|v| v.to_str().ok()).map(str::to_string);
            let text = res.body_mut().read_to_string().unwrap_or_default();
            if attempt < MAX_RETRIES && should_retry(status, h("x-should-retry").as_deref()) {
                sleep(retry_delay(attempt, h("retry-after-ms").as_deref(), h("retry-after").as_deref()));
                attempt += 1;
                continue;
            }
            return classify_status(status, &text);
        }
        let mut acc = Accumulator::new();
        return match read_sse(res.body_mut().as_reader(), &mut acc) {
            Err(SseError::Api(m)) => fail("api", format!("Anthropic API error: {m}")),
            Err(SseError::Transport(m)) => fail("api", format!("Could not reach Anthropic: {m}")),
            Ok(()) => match acc.finish() {
                Some(m) => interpret_message(&m),
                None => fail("api", "Could not reach Anthropic: request ended without sending any chunks"),
            },
        };
    }
}

fn api_base() -> String {
    #[cfg(feature = "webkit-tests")]
    if let Ok(v) = std::env::var("FRONTSTAGE_TEST_ANTHROPIC_BASE") {
        return v;
    }
    API_BASE.to_string()
}

#[tauri::command]
pub async fn claude_run(req: Value, ctx: State<'_, Ctx>) -> Result<Value, String> {
    Ok(blocking(|| run_claude_studio(&api_base(), ai::load(&ctx.secrets, Some("anthropic")).as_deref(), &req)))
}

#[cfg(test)]
mod tests {
    //! Port of apps/desktop/test/claude-studio.test.ts over a mock HTTP server.
    use super::*;
    use crate::util::testutil::{mock, Reply};
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;

    fn schema() -> Value {
        json!({ "type": "object", "properties": { "script": { "type": "string" } }, "required": ["script"], "additionalProperties": false })
    }

    fn req() -> Value {
        json!({ "model": "claude-opus-5-5", "system": "sys", "prompt": "Write it", "schema": schema(), "effort": "high", "maxTokens": 16000 })
    }

    fn with(k: &str, v: Value) -> Value {
        let mut r = req();
        r[k] = v;
        r
    }

    fn text_message(text: &str, stop: &str) -> Value {
        json!({ "stop_reason": stop, "stop_details": null, "content": [{ "type": "text", "text": text }] })
    }

    fn sse_for(text: &str) -> Vec<u8> {
        let escaped = serde_json::to_string(text).unwrap();
        format!(
            "event: message_start\ndata: {{\"type\":\"message_start\",\"message\":{{\"id\":\"m\",\"content\":[],\"stop_reason\":null}}}}\n\n\
             event: ping\ndata: {{\"type\":\"ping\"}}\n\n\
             event: content_block_start\ndata: {{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{{\"type\":\"text\",\"text\":\"\"}}}}\n\n\
             event: content_block_delta\ndata: {{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{{\"type\":\"text_delta\",\"text\":{escaped}}}}}\n\n\
             event: content_block_stop\ndata: {{\"type\":\"content_block_stop\",\"index\":0}}\n\n\
             event: message_delta\ndata: {{\"type\":\"message_delta\",\"delta\":{{\"stop_reason\":\"end_turn\",\"stop_details\":null}}}}\n\n\
             event: message_stop\ndata: {{\"type\":\"message_stop\"}}\n\n"
        )
        .into_bytes()
    }

    #[test]
    fn structured_output_effort_default_fallbacks_and_the_fallback_beta() {
        let p = build_params(&with("images", json!([{ "mediaType": "image/png", "base64": "AAAA" }]))).unwrap();
        assert_eq!(p["model"], "claude-opus-5-5");
        assert_eq!(p["max_tokens"], 16000);
        assert_eq!(p["output_config"], json!({ "effort": "high", "format": { "type": "json_schema", "schema": schema() } }));
        assert_eq!(p["fallbacks"], "default");
        assert_eq!(p["messages"][0]["content"][0], json!({ "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "AAAA" } }));
        assert_eq!(p["messages"][0]["content"][1], json!({ "type": "text", "text": "Write it" }));
        assert!(p.get("thinking").is_none());
        assert_eq!(FALLBACK_BETA, "server-side-fallback-2026-07-01");
    }

    #[test]
    fn rejects_other_models_efforts_oversized_budgets_and_odd_images() {
        assert!(build_params(&with("model", json!("gpt-x"))).unwrap_err().contains("model not allowed"));
        assert!(build_params(&with("effort", json!("max"))).unwrap_err().contains("effort not allowed"));
        assert!(build_params(&with("maxTokens", json!(999999))).unwrap_err().contains("maxTokens"));
        assert!(build_params(&with("maxTokens", json!(255))).unwrap_err().contains("maxTokens"));
        assert!(build_params(&with("maxTokens", json!(1000.5))).unwrap_err().contains("maxTokens"));
        assert!(build_params(&with("images", json!([{ "mediaType": "application/pdf", "base64": "x" }]))).unwrap_err().contains("invalid image"));
        assert!(build_params(&with("images", json!(vec![json!({ "mediaType": "image/png", "base64": "x" }); 21]))).unwrap_err().contains("too many images"));
        assert!(build_params(&with("schema", json!({ "type": "string" }))).unwrap_err().contains("schema"));
        assert!(build_params(&with("prompt", json!("   "))).unwrap_err().contains("required"));
        assert_eq!(build_params(&json!("x")).unwrap_err(), "invalid request");
    }

    #[test]
    fn parses_the_json_text() {
        assert_eq!(interpret_message(&text_message("{\"script\":\"INT. DOJO\"}", "end_turn")), json!({ "ok": true, "json": { "script": "INT. DOJO" } }));
    }

    #[test]
    fn a_refusal_is_an_error_naming_the_category_never_partial_content() {
        let r = interpret_message(&json!({ "stop_reason": "refusal", "stop_details": { "category": "cyber" }, "content": [{ "type": "text", "text": "{\"script\":\"partial" }] }));
        assert_eq!((r["ok"].as_bool(), r["kind"].as_str()), (Some(false), Some("refusal")));
        assert!(r["error"].as_str().unwrap().contains("cyber"));
    }

    #[test]
    fn max_tokens_is_reported_as_truncated() {
        assert_eq!(interpret_message(&text_message("{\"scr", "max_tokens"))["kind"], "truncated");
    }

    #[test]
    fn non_json_text_is_invalid() {
        assert_eq!(interpret_message(&text_message("sorry", "end_turn"))["kind"], "invalid");
    }

    #[test]
    fn after_a_mid_stream_fallback_only_the_answer_is_parsed() {
        let m = json!({ "stop_reason": "end_turn", "content": [
            { "type": "text", "text": "{\"script\":\"par" },
            { "type": "fallback", "from": { "model": "a" }, "to": { "model": "b" } },
            { "type": "text", "text": "{\"script\":\"whole\"}" },
        ] });
        assert_eq!(interpret_message(&m)["json"]["script"], "whole");
    }

    #[test]
    fn no_key_is_a_no_key_error_and_no_request() {
        let m = mock(|_| Reply::new(200, ""));
        assert_eq!(run_claude_studio(&m.base(), None, &req())["kind"], "no-key");
        assert_eq!(run_claude_studio(&m.base(), Some(""), &req())["kind"], "no-key");
        assert!(m.seen().is_empty());
    }

    #[test]
    fn success_streams_once_and_returns_the_json_with_the_sdks_wire_format() {
        let m = mock(|_| Reply::new(200, sse_for("{\"script\":\"x\"}")).with("content-type", "text/event-stream"));
        assert_eq!(run_claude_studio(&m.base(), Some("sk"), &req()), json!({ "ok": true, "json": { "script": "x" } }));
        let seen = m.seen();
        assert_eq!(seen.len(), 1);
        let s = &seen[0];
        assert_eq!(s.url, "/v1/messages?beta=true");
        assert_eq!(s.header("x-api-key").unwrap(), "sk");
        assert_eq!(s.header("anthropic-version").unwrap(), "2026-10-21");
        assert_eq!(s.header("anthropic-beta").unwrap(), FALLBACK_BETA);
        let body = s.json();
        assert_eq!(body["stream"], true);
        assert_eq!(body["fallbacks"], "default");
        assert!(body.get("betas").is_none(), "betas goes in the header, not the body");
    }

    #[test]
    fn deltas_across_blocks_accumulate_and_a_refusal_in_message_delta_is_seen() {
        let mut a = Accumulator::new();
        a.event("message_start", r#"{"message":{"content":[]}}"#);
        a.event("content_block_start", r#"{"index":0,"content_block":{"type":"text","text":""}}"#);
        a.event("content_block_delta", r#"{"index":0,"delta":{"type":"text_delta","text":"{\"a\":"}}"#);
        a.event("content_block_delta", r#"{"index":0,"delta":{"type":"text_delta","text":"1}"}}"#);
        a.event("message_delta", r#"{"delta":{"stop_reason":"refusal","stop_details":{"category":"bio"}}}"#);
        let r = interpret_message(&a.finish().unwrap());
        assert_eq!(r["kind"], "refusal");
        assert!(r["error"].as_str().unwrap().contains("bio"));
    }

    fn no_sleep(_: Duration) {}

    #[test]
    fn typed_api_errors_map_to_user_facing_kinds() {
        let cases: [(u16, &str); 5] = [(401, "auth"), (403, "auth"), (429, "rate-limit"), (400, "api"), (404, "api")];
        for (status, kind) in cases {
            let m = mock(move |_| Reply::new(status, r#"{"type":"error","error":{"type":"x","message":"bad"}}"#));
            assert_eq!(run_with_delay(&m.base(), Some("sk"), &req(), no_sleep)["kind"], kind, "{status}");
        }
    }

    #[test]
    fn a_connection_failure_is_an_api_kind_naming_the_failure_after_retries() {
        let free = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let r = run_with_delay(&format!("http://127.0.0.1:{free}"), Some("sk"), &req(), no_sleep);
        assert_eq!(r["kind"], "api");
        assert!(r["error"].as_str().unwrap().starts_with("Could not reach Anthropic:"));
    }

    #[test]
    fn an_invalid_request_never_reaches_the_api() {
        let m = mock(|_| Reply::new(200, ""));
        assert_eq!(run_claude_studio(&m.base(), Some("sk"), &with("model", json!("x")))["kind"], "invalid");
        assert!(m.seen().is_empty());
    }

    #[test]
    fn retryable_statuses_are_retried_three_times_and_others_not_at_all() {
        let n = Arc::new(AtomicU32::new(0));
        let n2 = n.clone();
        let m = mock(move |_| {
            if n2.fetch_add(1, Ordering::SeqCst) < 2 {
                Reply::new(529, "{}")
            } else {
                Reply::new(200, sse_for("{\"a\":1}"))
            }
        });
        assert_eq!(run_with_delay(&m.base(), Some("sk"), &req(), no_sleep)["ok"], true);
        assert_eq!(m.seen().len(), 3);

        let m = mock(|_| Reply::new(429, "{}"));
        assert_eq!(run_with_delay(&m.base(), Some("sk"), &req(), no_sleep)["kind"], "rate-limit");
        assert_eq!(m.seen().len(), 4);

        let m = mock(|_| Reply::new(400, "{}"));
        run_with_delay(&m.base(), Some("sk"), &req(), no_sleep);
        assert_eq!(m.seen().len(), 1);

        let m = mock(|_| Reply::new(500, "{}").with("x-should-retry", "false"));
        run_with_delay(&m.base(), Some("sk"), &req(), no_sleep);
        assert_eq!(m.seen().len(), 1);
    }

    #[test]
    fn an_error_event_mid_stream_is_an_api_error_not_partial_success() {
        let m = mock(|_| {
            Reply::new(
                200,
                "event: message_start\ndata: {\"message\":{\"content\":[]}}\n\nevent: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"busy\"}}\n\n",
            )
        });
        let r = run_with_delay(&m.base(), Some("sk"), &req(), no_sleep);
        assert_eq!(r["kind"], "api");
        assert!(r["error"].as_str().unwrap().contains("overloaded_error"));
    }

    #[test]
    fn retry_delays_honour_hints_and_otherwise_back_off_within_bounds() {
        assert_eq!(retry_delay(0, Some("250"), None), Duration::from_millis(250));
        assert_eq!(retry_delay(0, None, Some("2")), Duration::from_secs(2));
        let d = retry_delay(1, None, Some("9999"));
        assert!(d <= Duration::from_secs(1) && d >= Duration::from_millis(750), "{d:?}");
        assert!(retry_delay(10, None, None) <= Duration::from_secs(8));
    }
}
