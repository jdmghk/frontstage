// Phase 0 spike: minimal commands the webview needs to prove playback, audio and export on WebKit.
// Paths come from env vars because this binary is only run by the spike driver.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::Write;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::Manager;

#[derive(Default)]
struct State {
    sink_bytes: Mutex<u64>,
    export: Mutex<Option<Child>>,
}

fn env(name: &str) -> Result<String, String> {
    std::env::var(name).map_err(|_| format!("{name} not set"))
}

fn body<'a>(request: &'a Request<'_>) -> Result<&'a [u8], String> {
    match request.body() {
        InvokeBody::Raw(b) => Ok(b),
        InvokeBody::Json(_) => Err("expected a raw binary body, got JSON".into()),
    }
}

#[tauri::command]
fn clip_bytes() -> Result<Response, String> {
    let bytes = std::fs::read(env("SPIKE_CLIP")?).map_err(|e| e.to_string())?;
    Ok(Response::new(bytes))
}

#[tauri::command]
async fn decode_pcm() -> Result<Response, String> {
    let output = Command::new(env("SPIKE_FFMPEG")?)
        .args(["-v", "error", "-i", &env("SPIKE_CLIP")?, "-vn", "-f", "f32le", "-ac", "2", "-ar", "48000", "pipe:1"])
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).into_owned());
    }
    Ok(Response::new(output.stdout))
}

#[tauri::command]
fn sink_start(state: tauri::State<State>) {
    *state.sink_bytes.lock().unwrap() = 0;
}

#[tauri::command]
fn sink_frame(request: Request, state: tauri::State<State>) -> Result<(), String> {
    *state.sink_bytes.lock().unwrap() += body(&request)?.len() as u64;
    Ok(())
}

#[tauri::command]
fn sink_finish(state: tauri::State<State>) -> u64 {
    *state.sink_bytes.lock().unwrap()
}

#[tauri::command]
fn export_start(width: u32, height: u32, fps: u32, state: tauri::State<State>) -> Result<String, String> {
    let out = env("SPIKE_EXPORT")?;
    // Same arguments as libx264_youtube in apps/desktop/src/main/export-codecs.mjs, plus vflip because
    // WebGL readPixels returns rows bottom-up.
    let child = Command::new(env("SPIKE_FFMPEG")?)
        .args(["-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", &format!("{width}x{height}"), "-r", &fps.to_string(), "-i", "pipe:0"])
        .args(["-vf", "vflip", "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-profile:v", "high", "-pix_fmt", "yuv420p", "-movflags", "+faststart", &out])
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    *state.export.lock().unwrap() = Some(child);
    Ok(out)
}

#[tauri::command]
async fn export_frame(request: Request<'_>, state: tauri::State<'_, State>) -> Result<(), String> {
    let mut guard = state.export.lock().unwrap();
    let child = guard.as_mut().ok_or("export not started")?;
    child.stdin.as_mut().ok_or("no stdin")?.write_all(body(&request)?).map_err(|e| e.to_string())
}

#[tauri::command]
async fn export_finish(state: tauri::State<'_, State>) -> Result<(), String> {
    let mut child = state.export.lock().unwrap().take().ok_or("export not started")?;
    drop(child.stdin.take());
    let status = child.wait().map_err(|e| e.to_string())?;
    if status.success() { Ok(()) } else { Err(format!("ffmpeg exited with {status}")) }
}

#[tauri::command]
fn progress(name: String, value: String) {
    println!("[{name}] {value}");
}

#[tauri::command]
fn report(json: String, app: tauri::AppHandle) -> Result<(), String> {
    std::fs::write(env("SPIKE_OUT")?, json).map_err(|e| e.to_string())?;
    app.exit(0);
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .manage(State::default())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            // Spike only: lets the driver load the bench page from a loopback server.
            if let (Ok(url), Some(window)) = (std::env::var("SPIKE_URL"), app.get_webview_window("main")) {
                window.navigate(url.parse().expect("bad SPIKE_URL"))?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            clip_bytes, decode_pcm, sink_start, sink_frame, sink_finish,
            export_start, export_frame, export_finish, progress, report
        ])
        .run(tauri::generate_context!())
        .expect("error while running Frontstage");
}
