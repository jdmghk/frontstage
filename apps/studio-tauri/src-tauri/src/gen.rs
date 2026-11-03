//! gen:* channels: the fal.ai queue. URL builders mirror packages/ai/src/generation/fal-wire.ts.

use serde_json::{json, Value};
use tauri::ipc::Request;
use tauri::{ipc::Response, State};
use url::Url;

use crate::net::{self, Net};
use crate::secrets::SecretStore;
use crate::util::{blocking, header, raw_body};
use crate::{ai, Ctx};

const FAL_QUEUE_BASE: &str = "https://queue.fal.run";
const FAL_REST_BASE: &str = "https://rest.fal.ai";

#[derive(Clone)]
pub struct FalBases {
    pub queue: String,
    pub rest: String,
}

impl Default for FalBases {
    fn default() -> Self {
        FalBases { queue: FAL_QUEUE_BASE.into(), rest: FAL_REST_BASE.into() }
    }
}

pub fn fal_app_id(endpoint: &str) -> String {
    endpoint.split('/').take(2).collect::<Vec<_>>().join("/")
}

pub fn is_allowed_fal_host(url: &Url) -> bool {
    if url.scheme() != "https" {
        return false;
    }
    let Some(host) = url.host_str() else { return false };
    ["fal.ai", "fal.run", "fal.media"].iter().any(|d| host == *d || host.ends_with(&format!(".{d}")))
}

fn soft<T>(r: Result<T, ureq::Error>) -> Result<T, Value> {
    r.map_err(|e| json!({ "error": e.to_string() }))
}

fn read_json(res: &mut ureq::http::Response<ureq::Body>) -> Result<Value, Value> {
    let bytes = res.body_mut().with_config().limit(256 * 1024 * 1024).read_to_vec().map_err(|e| json!({ "error": e.to_string() }))?;
    serde_json::from_slice(&bytes).map_err(|e| json!({ "error": e.to_string() }))
}

fn status_error(res: &mut ureq::http::Response<ureq::Body>) -> Option<Value> {
    let status = res.status().as_u16();
    if (200..300).contains(&status) {
        return None;
    }
    let text = res.body_mut().read_to_string().unwrap_or_default();
    Some(json!({ "error": format!("{status} {text}") }))
}

pub fn submit(b: &FalBases, key: Option<String>, endpoint: &str, input: &Value) -> Value {
    let Some(key) = key else { return json!({ "error": "fal key not configured" }) };
    let run = || -> Result<Value, Value> {
        let mut res = soft(net::agent(None).post(format!("{}/{endpoint}", b.queue)).header("Authorization", format!("Key {key}")).header("Content-Type", "application/json").send(input.to_string().as_bytes()))?;
        if let Some(e) = status_error(&mut res) {
            return Ok(e);
        }
        let j = read_json(&mut res)?;
        Ok(match j.get("request_id").and_then(Value::as_str) {
            Some(id) => json!({ "jobId": id }),
            None => json!({ "error": "fal submit response missing request_id" }),
        })
    };
    run().unwrap_or_else(|e| e)
}

pub fn status(b: &FalBases, key: Option<String>, endpoint: &str, job_id: &str) -> Value {
    let Some(key) = key else { return json!({ "error": "fal key not configured" }) };
    let app = fal_app_id(endpoint);
    let run = || -> Result<Value, Value> {
        let mut res = soft(net::agent(None).get(format!("{}/{app}/requests/{job_id}/status", b.queue)).header("Authorization", format!("Key {key}")).call())?;
        if let Some(e) = status_error(&mut res) {
            return Ok(e);
        }
        let status = read_json(&mut res)?;
        if status.get("status").and_then(Value::as_str) != Some("COMPLETED") {
            return Ok(json!({ "status": status }));
        }
        let mut result = soft(net::agent(None).get(format!("{}/{app}/requests/{job_id}", b.queue)).header("Authorization", format!("Key {key}")).call())?;
        if let Some(e) = status_error(&mut result) {
            return Ok(e);
        }
        Ok(json!({ "status": status, "resultJson": read_json(&mut result)? }))
    };
    run().unwrap_or_else(|e| e)
}

/// `check_host` is is_allowed_fal_host in production. Tests widen it to reach the mock server.
pub fn upload(b: &FalBases, key: Option<String>, bytes: &[u8], content_type: &str, file_name: &str, check_host: impl Fn(&Url) -> bool) -> Value {
    let Some(key) = key else { return json!({ "error": "fal key not configured" }) };
    let run = || -> Result<Value, Value> {
        let mut init = soft(
            net::agent(None)
                .post(format!("{}/storage/upload/initiate?storage_type=fal-cdn-v3", b.rest))
                .header("Authorization", format!("Key {key}"))
                .header("Content-Type", "application/json")
                .send(json!({ "content_type": content_type, "file_name": file_name }).to_string().as_bytes()),
        )?;
        if let Some(e) = status_error(&mut init) {
            return Ok(e);
        }
        let j = read_json(&mut init)?;
        let (Some(upload_url), Some(file_url)) = (j.get("upload_url").and_then(Value::as_str), j.get("file_url").and_then(Value::as_str)) else {
            return Ok(json!({ "error": "fal upload/initiate response missing upload_url/file_url" }));
        };
        let (Ok(upload_target), Ok(file_target)) = (Url::parse(upload_url), Url::parse(file_url)) else {
            return Ok(json!({ "error": "fal upload/initiate returned an invalid URL" }));
        };
        if !check_host(&upload_target) || !check_host(&file_target) {
            return Ok(json!({ "error": "fal upload URL host not allowed" }));
        }
        // No Authorization: the key never goes to the storage host.
        let put = soft(net::agent(None).put(upload_target.as_str()).header("Content-Type", content_type).send(bytes))?;
        if !put.status().is_success() {
            return Ok(json!({ "error": format!("fal storage PUT failed: {}", put.status().as_u16()) }));
        }
        Ok(json!({ "url": file_url }))
    };
    run().unwrap_or_else(|e| e)
}

fn fal_key(store: &SecretStore) -> Option<String> {
    ai::load(store, Some("fal"))
}

#[tauri::command]
pub async fn gen_fal_submit(model_endpoint: String, input: Value, ctx: State<'_, Ctx>) -> Result<Value, String> {
    Ok(blocking(|| submit(&ctx.fal, fal_key(&ctx.secrets), &model_endpoint, &input)))
}

#[tauri::command]
pub async fn gen_fal_status(model_endpoint: String, job_id: String, ctx: State<'_, Ctx>) -> Result<Value, String> {
    Ok(blocking(|| status(&ctx.fal, fal_key(&ctx.secrets), &model_endpoint, &job_id)))
}

/// Raw result bytes; a failure rejects with the message and the bridge returns it as {error}.
#[tauri::command]
pub async fn gen_fal_download(url: String, ctx: State<'_, Ctx>) -> Result<Response, String> {
    blocking(|| net::guarded_download(ctx.net.as_ref() as &dyn Net, &url)).map(Response::new)
}

#[tauri::command]
pub async fn gen_fal_upload(request: Request<'_>, ctx: State<'_, Ctx>) -> Result<Value, String> {
    let (ct, name) = (header(&request, "x-content-type")?, header(&request, "x-file-name")?);
    let body = raw_body(&request)?;
    Ok(blocking(|| upload(&ctx.fal, fal_key(&ctx.secrets), body, &ct, &name, is_allowed_fal_host)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::testutil::{mock, Reply};

    fn bases(base: &str) -> FalBases {
        FalBases { queue: base.into(), rest: base.into() }
    }

    #[test]
    fn app_id_is_the_first_two_segments() {
        assert_eq!(fal_app_id("fal-ai/veo3/image-to-video"), "fal-ai/veo3");
        assert_eq!(fal_app_id("fal-ai/wizper"), "fal-ai/wizper");
    }

    #[test]
    fn fal_upload_hosts_are_an_https_allowlist_with_no_suffix_tricks() {
        for ok in ["https://fal.ai/x", "https://v3.fal.media/x", "https://queue.fal.run/x"] {
            assert!(is_allowed_fal_host(&Url::parse(ok).unwrap()), "{ok}");
        }
        for bad in ["http://fal.ai/x", "https://evilfal.ai/x", "https://fal.ai.evil.com/x", "https://example.com/x", "https://fal.run@evil.com/x"] {
            assert!(!is_allowed_fal_host(&Url::parse(bad).unwrap()), "{bad}");
        }
    }

    #[test]
    fn no_key_means_no_request() {
        let m = mock(|_| Reply::new(200, "{}"));
        let b = bases(&m.base());
        assert_eq!(submit(&b, None, "a/b", &json!({}))["error"], "fal key not configured");
        assert_eq!(status(&b, None, "a/b", "j")["error"], "fal key not configured");
        assert_eq!(upload(&b, None, &[1], "x", "y", |_| true)["error"], "fal key not configured");
        assert!(m.seen().is_empty());
    }

    #[test]
    fn submit_posts_to_the_full_endpoint_with_the_key() {
        let m = mock(|_| Reply::json(200, json!({ "request_id": "job-1" })));
        let r = submit(&bases(&m.base()), Some("k".into()), "fal-ai/veo3/image-to-video", &json!({ "prompt": "p" }));
        assert_eq!(r, json!({ "jobId": "job-1" }));
        let s = &m.seen()[0];
        assert_eq!(s.url, "/fal-ai/veo3/image-to-video");
        assert_eq!(s.header("authorization").unwrap(), "Key k");
        assert_eq!(s.json(), json!({ "prompt": "p" }));
    }

    #[test]
    fn submit_errors_keep_status_and_text_and_a_missing_id_is_named() {
        let m = mock(|_| Reply::new(422, "bad input"));
        assert_eq!(submit(&bases(&m.base()), Some("k".into()), "a/b", &json!({}))["error"], "422 bad input");
        let m = mock(|_| Reply::json(200, json!({})));
        assert_eq!(submit(&bases(&m.base()), Some("k".into()), "a/b", &json!({}))["error"], "fal submit response missing request_id");
    }

    #[test]
    fn status_addresses_the_app_id_and_fetches_the_result_only_when_completed() {
        let m = mock(|s| {
            if s.url.ends_with("/status") {
                Reply::json(200, json!({ "status": "IN_PROGRESS" }))
            } else {
                Reply::new(500, "should not be asked")
            }
        });
        assert_eq!(status(&bases(&m.base()), Some("k".into()), "a/b/c", "j")["status"]["status"], "IN_PROGRESS");
        assert_eq!(m.seen().len(), 1);
        assert_eq!(m.seen()[0].url, "/a/b/requests/j/status");

        let m = mock(|s| {
            if s.url.ends_with("/status") {
                Reply::json(200, json!({ "status": "COMPLETED" }))
            } else {
                Reply::json(200, json!({ "video": { "url": "u" } }))
            }
        });
        let r = status(&bases(&m.base()), Some("k".into()), "a/b/c", "j");
        assert_eq!(r["resultJson"]["video"]["url"], "u");
        assert_eq!(m.seen()[1].url, "/a/b/requests/j");
    }

    #[test]
    fn upload_refuses_a_storage_host_outside_the_allowlist_and_sends_nothing_there() {
        let m = mock(|_| Reply::json(200, json!({ "upload_url": "https://evil.example/put", "file_url": "https://v3.fal.media/f" })));
        let r = upload(&bases(&m.base()), Some("k".into()), &[1, 2], "image/png", "a.png", is_allowed_fal_host);
        assert_eq!(r["error"], "fal upload URL host not allowed");
        assert_eq!(m.seen().len(), 1);
        assert_eq!(m.seen()[0].json(), json!({ "content_type": "image/png", "file_name": "a.png" }));
    }

    #[test]
    fn upload_puts_the_bytes_without_the_key_and_returns_the_file_url() {
        let holder = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let h2 = holder.clone();
        let m = mock(move |s| {
            if s.method == "POST" {
                let b = h2.lock().unwrap().clone();
                Reply::json(200, json!({ "upload_url": format!("{b}/put"), "file_url": format!("{b}/file") }))
            } else {
                Reply::new(200, "")
            }
        });
        *holder.lock().unwrap() = m.base();
        let r = upload(&bases(&m.base()), Some("k".into()), &[1, 2], "image/png", "a.png", |_| true);
        assert_eq!(r["url"], format!("{}/file", m.base()));
        let put = &m.seen()[1];
        assert_eq!((put.method.as_str(), put.body.as_slice()), ("PUT", [1u8, 2].as_slice()));
        assert_eq!(put.header("authorization"), None);
        assert_eq!(put.header("content-type").unwrap(), "image/png");
    }
}
