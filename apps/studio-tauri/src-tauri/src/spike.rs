//! Phase 0/1 commands for WebKit testing, and the smoke hook. Compiled only with
//! `--features webkit-tests`: env-var paths and `spike_file` can't exist in a shipped build.

#![cfg(feature = "webkit-tests")]

use std::io::Write;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use tauri::ipc::{Request, Response};
use tauri::State;

use crate::util::raw_body;

#[derive(Default)]
pub struct SpikeState {
    sink_bytes: Mutex<u64>,
    export: Mutex<Option<Child>>,
}

fn env(name: &str) -> Result<String, String> {
    std::env::var(name).map_err(|_| format!("{name} not set"))
}

#[tauri::command]
pub fn clip_bytes() -> Result<Response, String> {
    Ok(Response::new(std::fs::read(env("SPIKE_CLIP")?).map_err(|e| e.to_string())?))
}

/// Test media by bare file name under SPIKE_DIR.
#[tauri::command]
pub fn spike_file(name: String) -> Result<Response, String> {
    if name.contains('/') || name.contains("..") {
        return Err("bad file name".into());
    }
    Ok(Response::new(std::fs::read(std::path::Path::new(&env("SPIKE_DIR")?).join(name)).map_err(|e| e.to_string())?))
}

#[tauri::command]
pub async fn decode_pcm() -> Result<Response, String> {
    let output = Command::new(env("SPIKE_FFMPEG")?).args(["-v", "error", "-i", &env("SPIKE_CLIP")?, "-vn", "-f", "f32le", "-ac", "2", "-ar", "48000", "pipe:1"]).output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).into_owned());
    }
    Ok(Response::new(output.stdout))
}

#[tauri::command]
pub fn sink_start(state: State<SpikeState>) {
    *state.sink_bytes.lock().unwrap() = 0;
}

#[tauri::command]
pub fn sink_frame(request: Request, state: State<SpikeState>) -> Result<(), String> {
    *state.sink_bytes.lock().unwrap() += raw_body(&request)?.len() as u64;
    Ok(())
}

#[tauri::command]
pub fn sink_finish(state: State<SpikeState>) -> u64 {
    *state.sink_bytes.lock().unwrap()
}

/// Phase 0's raw export. Its vflip was wrong for readRGBA, so it's gone here too.
#[tauri::command]
pub fn export_start(width: u32, height: u32, fps: u32, state: State<SpikeState>) -> Result<String, String> {
    let out = env("SPIKE_EXPORT")?;
    let child = Command::new(env("SPIKE_FFMPEG")?)
        .args(["-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", &format!("{width}x{height}"), "-r", &fps.to_string(), "-i", "pipe:0"])
        .args(["-c:v", "libx264", "-preset", "slow", "-crf", "18", "-profile:v", "high", "-pix_fmt", "yuv420p", "-movflags", "+faststart", &out])
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    *state.export.lock().unwrap() = Some(child);
    Ok(out)
}

#[tauri::command]
pub async fn export_frame(request: Request<'_>, state: State<'_, SpikeState>) -> Result<(), String> {
    let mut guard = state.export.lock().unwrap();
    let child = guard.as_mut().ok_or("export not started")?;
    child.stdin.as_mut().ok_or("no stdin")?.write_all(raw_body(&request)?).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn export_finish(state: State<'_, SpikeState>) -> Result<(), String> {
    let mut child = state.export.lock().unwrap().take().ok_or("export not started")?;
    drop(child.stdin.take());
    let status = child.wait().map_err(|e| e.to_string())?;
    if status.success() { Ok(()) } else { Err(format!("ffmpeg exited with {status}")) }
}

#[tauri::command]
pub fn progress(name: String, value: String) {
    println!("[{name}] {value}");
}

#[tauri::command]
pub fn report(json: String, app: tauri::AppHandle) -> Result<(), String> {
    std::fs::write(env("SPIKE_OUT")?, json).map_err(|e| e.to_string())?;
    app.exit(0);
    Ok(())
}

/// What the scripted JS panels saw, for the smoke check.
#[tauri::command]
pub fn smoke_js_dialog_log() -> Vec<String> {
    #[cfg(target_os = "macos")]
    return crate::js_dialogs::scripted::LOG.lock().unwrap().clone();
    #[cfg(not(target_os = "macos"))]
    return vec![];
}

/// Stands in for the user approving in a browser, against the mock OAuth server only.
pub fn fake_browser(url: &str) -> Result<(), String> {
    let u = url::Url::parse(url).map_err(|e| e.to_string())?;
    let param = |n: &str| u.query_pairs().find(|(k, _)| k == n).map(|(_, v)| v.into_owned());
    let (redirect, state) = (param("redirect_uri").ok_or("no redirect_uri")?, param("state").ok_or("no state")?);
    std::thread::spawn(move || {
        let _ = crate::net::agent(Some(std::time::Duration::from_secs(10))).get(format!("{redirect}?code=mock-code&state={state}")).call();
    });
    Ok(())
}

/// An MCP client against this app's own server, so a tool call really crosses into the renderer and
/// back, with the auth nonce. A webview page can't do this: CSP blocks loopback.
#[tauri::command]
pub async fn smoke_mcp_probe(project_dir: String, ctx: State<'_, crate::Ctx>) -> Result<serde_json::Value, String> {
    use serde_json::{json, Value};
    let status = ctx.mcp.status();
    let url = status["url"].as_str().unwrap_or("").to_string();
    let token = status["token"].as_str().unwrap_or("").to_string();
    crate::util::blocking(|| {
        let post = |body: Value, auth: Option<&str>| -> Result<(u16, Value), String> {
            let mut r = crate::net::agent(Some(std::time::Duration::from_secs(40))).post(&url).header("content-type", "application/json").header("accept", "application/json, text/event-stream");
            if let Some(t) = auth {
                r = r.header("authorization", format!("Bearer {t}"));
            }
            let mut res = r.send(body.to_string().as_bytes()).map_err(|e| e.to_string())?;
            let status = res.status().as_u16();
            let text = res.body_mut().with_config().limit(64 * 1024 * 1024).read_to_string().unwrap_or_default();
            Ok((status, serde_json::from_str(&text).unwrap_or(Value::Null)))
        };
        let list = post(json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }), Some(&token))?;
        let names: Vec<String> = list.1.pointer("/result/tools").and_then(Value::as_array).map(|t| t.iter().filter_map(|x| x["name"].as_str().map(String::from)).collect()).unwrap_or_default();
        let projects = post(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": "get_projects", "arguments": {} } }), Some(&token))?;
        let open = post(json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "open_project", "arguments": { "path": project_dir } } }), Some(&token))?;
        Ok(json!({
            "toolCount": names.len(),
            "hasOpenProject": names.iter().any(|n| n == "open_project"),
            "noTokenStatus": post(json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/list" }), None)?.0,
            "wrongTokenStatus": post(json!({ "jsonrpc": "2.0", "id": 5, "method": "tools/list" }), Some("wrong"))?.0,
            "getProjects": projects.1.pointer("/result/isError"),
            "openProject": open.1.pointer("/result"),
            "noncesLeft": ctx.nonces.size(),
        }))
    })
}
