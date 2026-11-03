//! ai:* channels: key storage and OpenRouter. The key stays in this process.

use std::io::Read;

use serde_json::Value;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

use crate::net;
use crate::secrets::{provider_account, SecretStore};
use crate::util::blocking;
use crate::Ctx;

const OPENROUTER_BASE: &str = "https://openrouter.ai/api/v1";

fn base_url() -> String {
    // Only a test build can point keys at another host.
    #[cfg(feature = "webkit-tests")]
    if let Ok(v) = std::env::var("OPENROUTER_BASE_URL") {
        return v.trim_end_matches('/').to_string();
    }
    OPENROUTER_BASE.to_string()
}

pub fn generate_image(base: &str, key: Option<String>, body: &Value) -> Result<Value, String> {
    let key = key.ok_or("no API key")?;
    let mut res = chat_request(base, &key, body).map_err(|e| e.to_string())?;
    let status = res.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(format!("HTTP {status}"));
    }
    let text = res.body_mut().with_config().limit(512 * 1024 * 1024).read_to_vec().map_err(|e| e.to_string())?;
    serde_json::from_slice(&text).map_err(|e| e.to_string())
}

fn chat_request(base: &str, key: &str, body: &Value) -> Result<ureq::http::Response<ureq::Body>, ureq::Error> {
    net::agent(None)
        .post(format!("{base}/chat/completions"))
        .header("Authorization", format!("Bearer {key}"))
        .header("Content-Type", "application/json")
        .header("HTTP-Referer", "https://frontstage.studio")
        .header("X-Title", "Frontstage")
        .send(body.to_string().as_bytes())
}

pub enum Chunk {
    Data(Vec<u8>),
    Done,
    Error(String),
}

/// Streams the response body through `emit`, ending with exactly one Done or Error.
pub fn stream_chat(base: &str, key: Option<String>, body: &Value, mut emit: impl FnMut(Chunk)) {
    let Some(key) = key else {
        return emit(Chunk::Error("no API key".into()));
    };
    let mut res = match chat_request(base, &key, body) {
        Ok(r) => r,
        Err(e) => return emit(Chunk::Error(e.to_string())),
    };
    let status = res.status().as_u16();
    if !(200..300).contains(&status) {
        return emit(Chunk::Error(format!("HTTP {status}")));
    }
    let mut reader = res.body_mut().as_reader();
    let mut buf = vec![0u8; 16 * 1024];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => return emit(Chunk::Done),
            Ok(n) => emit(Chunk::Data(buf[..n].to_vec())),
            Err(e) => return emit(Chunk::Error(e.to_string())),
        }
    }
}

pub fn load(store: &SecretStore, provider: Option<&str>) -> Option<String> {
    store.get(provider_account(provider)).ok().flatten()
}

#[tauri::command]
pub async fn ai_set_key(key: String, provider: Option<String>, ctx: State<'_, Ctx>) -> Result<(), String> {
    blocking(|| ctx.secrets.set(provider_account(provider.as_deref()), &key))
}

#[tauri::command]
pub async fn ai_has_key(provider: Option<String>, ctx: State<'_, Ctx>) -> Result<bool, String> {
    Ok(blocking(|| ctx.secrets.has(provider_account(provider.as_deref()))))
}

#[tauri::command]
pub async fn ai_clear_key(provider: Option<String>, ctx: State<'_, Ctx>) -> Result<(), String> {
    blocking(|| ctx.secrets.delete(provider_account(provider.as_deref())))
}

#[tauri::command]
pub async fn ai_generate_image(body: Value, ctx: State<'_, Ctx>) -> Result<Value, String> {
    blocking(|| generate_image(&base_url(), load(&ctx.secrets, None), &body))
}

/// Data goes through the channel as raw bytes; the end is a JSON message on the same channel, so
/// it can't overtake the data.
#[tauri::command]
pub async fn ai_stream_chat(body: Value, channel: Channel<InvokeResponseBody>, ctx: State<'_, Ctx>) -> Result<(), String> {
    blocking(|| {
        stream_chat(&base_url(), load(&ctx.secrets, None), &body, |c| {
            let _ = match c {
                Chunk::Data(d) => channel.send(InvokeResponseBody::Raw(d)),
                Chunk::Done => channel.send(InvokeResponseBody::Json("{\"done\":true}".into())),
                Chunk::Error(e) => channel.send(InvokeResponseBody::Json(serde_json::json!({ "error": e }).to_string())),
            };
        });
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::testutil::{mock, Reply};
    use serde_json::json;

    #[test]
    fn no_key_means_no_request() {
        let m = mock(|_| Reply::new(200, "{}"));
        assert_eq!(generate_image(&m.base(), None, &json!({})).unwrap_err(), "no API key");
        let mut got = vec![];
        stream_chat(&m.base(), None, &json!({}), |c| got.push(matches!(c, Chunk::Error(e) if e == "no API key")));
        assert_eq!(got, [true]);
        assert!(m.seen().is_empty());
    }

    #[test]
    fn requests_carry_the_openrouter_headers_and_body() {
        let m = mock(|_| Reply::json(200, json!({"id":"x"})));
        let r = generate_image(&m.base(), Some("sk-test".into()), &json!({"model":"m"})).unwrap();
        assert_eq!(r["id"], "x");
        let s = &m.seen()[0];
        assert_eq!(s.url, "/chat/completions");
        assert_eq!(s.header("authorization").unwrap(), "Bearer sk-test");
        assert_eq!(s.header("http-referer").unwrap(), "https://frontstage.studio");
        assert_eq!(s.header("x-title").unwrap(), "Frontstage");
        assert_eq!(s.json(), json!({"model":"m"}));
    }

    #[test]
    fn http_errors_become_status_messages() {
        let m = mock(|_| Reply::new(401, "bad"));
        assert_eq!(generate_image(&m.base(), Some("k".into()), &json!({})).unwrap_err(), "HTTP 401");
        let mut errs = vec![];
        stream_chat(&m.base(), Some("k".into()), &json!({}), |c| {
            if let Chunk::Error(e) = c {
                errs.push(e)
            }
        });
        assert_eq!(errs, ["HTTP 401"]);
    }

    #[test]
    fn a_stream_delivers_bytes_in_order_then_exactly_one_done() {
        let m = mock(|_| Reply::new(200, "data: 1\n\ndata: 2\n\n"));
        let (mut bytes, mut dones) = (vec![], 0);
        stream_chat(&m.base(), Some("k".into()), &json!({}), |c| match c {
            Chunk::Data(d) => bytes.extend(d),
            Chunk::Done => dones += 1,
            Chunk::Error(e) => panic!("{e}"),
        });
        assert_eq!(bytes, b"data: 1\n\ndata: 2\n\n");
        assert_eq!(dones, 1);
    }
}
