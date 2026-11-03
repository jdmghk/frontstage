// The Rust shell: runs the editor UI from apps/desktop/src/renderer on tauri://, with the same
// window.desktop* objects as the Electron preload (see ../src/tauri-bridge.ts).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai;
mod characters;
mod claude;
mod dialogs;
mod export;
mod frames;
mod gen;
mod js_dialogs;
mod mcp;
mod media;
mod menu;
mod morphic;
mod net;
mod project;
mod projects;
mod proxy;
mod secrets;
mod shell;
mod skills;
mod spike;
mod studio;
mod tools;
mod util;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::webview::NewWindowResponse;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

pub struct Ctx {
    pub user_data: PathBuf,
    pub cache: PathBuf,
    pub documents: PathBuf,
    pub home: PathBuf,
    pub electron_user_data: PathBuf,
    pub auth: project::Authorized,
    pub nonces: Arc<mcp::NonceGuard>,
    pub secrets: Arc<secrets::SecretStore>,
    pub exports: export::Exports,
    pub proxies: proxy::Proxies,
    pub tools: tools::Tools,
    pub fal: gen::FalBases,
    pub net: Box<dyn net::Net>,
    pub mcp: mcp::McpState,
    pub morphic: morphic::Morphic,
    pub test_picks: project::TestPicks,
}

impl Ctx {
    pub fn test_picks_flow(&self) -> Option<String> {
        self.test_picks.take_project()
    }
}

/// True for a test run that must stay hidden and use throwaway locations.
fn test_mode() -> bool {
    cfg!(feature = "webkit-tests") && std::env::var_os("FRONTSTAGE_TEST_DIR").is_some()
}

struct Dirs {
    user_data: PathBuf,
    cache: PathBuf,
    documents: PathBuf,
    home: PathBuf,
    electron_user_data: PathBuf,
}

fn dirs(app: &tauri::App) -> tauri::Result<Dirs> {
    if test_mode() {
        if let Some(root) = std::env::var_os("FRONTSTAGE_TEST_DIR").map(PathBuf::from) {
            return Ok(Dirs { user_data: root.join("data"), cache: root.join("cache"), documents: root.join("docs"), home: root.join("home"), electron_user_data: root.join("electron") });
        }
    }
    let p = app.path();
    let user_data = p.app_data_dir()?;
    let electron_user_data = p.data_dir()?.join("Frontstage");
    Ok(Dirs { user_data, cache: p.app_cache_dir()?, documents: p.document_dir()?, home: p.home_dir()?, electron_user_data })
}

fn secret_store() -> Arc<secrets::SecretStore> {
    #[cfg(feature = "webkit-tests")]
    if test_mode() {
        // Real Keychain calls under a service name only test runs use, when one is given.
        let raw: Box<dyn secrets::RawStore> = match std::env::var("FRONTSTAGE_TEST_KEYCHAIN_SERVICE") {
            Ok(service) if service.starts_with("studio.frontstage.test") => Box::new(secrets::OsStore::new(service)),
            _ => Box::new(secrets::MemoryStore::default()),
        };
        return Arc::new(secrets::SecretStore::new(raw));
    }
    Arc::new(secrets::SecretStore::new(Box::new(secrets::OsStore::new(secrets::SERVICE))))
}

fn mcp_port() -> u16 {
    #[cfg(feature = "webkit-tests")]
    if let Some(p) = std::env::var("FRONTSTAGE_TEST_MCP_PORT").ok().and_then(|p| p.parse().ok()) {
        return p;
    }
    mcp::DEFAULT_PORT
}

fn fal_bases() -> gen::FalBases {
    #[cfg(feature = "webkit-tests")]
    if let Ok(b) = std::env::var("FRONTSTAGE_TEST_FAL_BASE") {
        return gen::FalBases { queue: b.clone(), rest: b };
    }
    gen::FalBases::default()
}

fn morphic_client(store: Arc<secrets::SecretStore>) -> morphic::Morphic {
    let tokens = Arc::new(morphic::KeychainTokens(store));
    #[cfg(feature = "webkit-tests")]
    if let Ok(server) = std::env::var("FRONTSTAGE_TEST_MORPHIC_URL") {
        return morphic::Morphic::with_config(&server, morphic::CLIENT_METADATA_URL, morphic::REDIRECT_PORT, std::time::Duration::from_secs(30), tokens, Box::new(spike::fake_browser));
    }
    morphic::Morphic::new(tokens, Box::new(|u| shell::open_url(u)))
}

/// Default window bounds, or the saved ones. Port of loadWindowState.
fn load_window_state(user_data: &Path) -> (Option<(f64, f64)>, (f64, f64)) {
    let parsed: Option<serde_json::Value> = std::fs::read(user_data.join("window-state.json")).ok().and_then(|b| serde_json::from_slice(&b).ok());
    let num = |k: &str| parsed.as_ref().and_then(|v| v.get(k)).and_then(serde_json::Value::as_f64);
    match (num("x"), num("y"), num("width"), num("height")) {
        (Some(x), Some(y), Some(w), Some(h)) => (Some((x, y)), (w, h)),
        _ => (None, (1280.0, 800.0)),
    }
}

fn save_window_state(window: &tauri::Window, user_data: &Path, force: bool) {
    // A drag or resize fires continuously. Electron debounced by 300 ms; a throttle keeps it simple.
    static LAST: std::sync::Mutex<Option<std::time::Instant>> = std::sync::Mutex::new(None);
    {
        let mut last = LAST.lock().unwrap();
        if !force && last.is_some_and(|t| t.elapsed() < std::time::Duration::from_millis(300)) {
            return;
        }
        *last = Some(std::time::Instant::now());
    }
    let (Ok(pos), Ok(size), Ok(scale)) = (window.outer_position(), window.inner_size(), window.scale_factor()) else { return };
    let v = serde_json::json!({ "x": f64::from(pos.x) / scale, "y": f64::from(pos.y) / scale, "width": f64::from(size.width) / scale, "height": f64::from(size.height) / scale });
    let _ = std::fs::create_dir_all(user_data);
    let _ = std::fs::write(user_data.join("window-state.json"), v.to_string());
}

/// The page stays on the app's own origin (tauri://localhost, or http://tauri.localhost on Windows).
fn allowed_navigation(url: &url::Url) -> bool {
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => url.host_str() == Some("tauri.localhost"),
        "blob" | "about" => true,
        _ => false,
    }
}

fn create_window(app: &tauri::App, user_data: &Path) -> tauri::Result<()> {
    let hidden = test_mode();
    let (pos, (w, h)) = load_window_state(user_data);
    #[cfg(feature = "webkit-tests")]
    let entry = std::env::var("FRONTSTAGE_TEST_PAGE").unwrap_or_else(|_| "editor.html".to_string());
    #[cfg(not(feature = "webkit-tests"))]
    let entry = "editor.html".to_string();
    let mut b = WebviewWindowBuilder::new(app, "main", WebviewUrl::App(entry.into()))
        .title("Frontstage")
        .inner_size(w, h)
        .visible(!hidden)
        .focused(!hidden)
        // Tauri's native drop handler would swallow the HTML5 drag events the editor relies on.
        .disable_drag_drop_handler()
        .on_navigation(|url| {
            if cfg!(feature = "webkit-tests") && std::env::var_os("SPIKE_URL").is_some() {
                return true;
            }
            allowed_navigation(url)
        })
        // Electron opened target=_blank links in a window of their own; here they go to the browser.
        .on_new_window(|url, _| {
            if shell::is_openable_url(&url) && !cfg!(feature = "webkit-tests") {
                let _ = shell::open_url(url.as_str());
            }
            NewWindowResponse::Deny
        });
    if let Some((x, y)) = pos {
        b = b.position(x, y);
    }
    if hidden {
        b = b.initialization_script("window.__FRONTSTAGE_SMOKE__ = true;");
    }
    let window = b.build()?;
    #[cfg(target_os = "macos")]
    js_dialogs::install(&window)?;

    #[cfg(feature = "webkit-tests")]
    if let Ok(url) = std::env::var("SPIKE_URL") {
        window.navigate(url.parse().expect("bad SPIKE_URL"))?;
    }
    let _ = &window;
    Ok(())
}

fn main() {
    let builder = tauri::Builder::default();
    #[cfg(feature = "webkit-tests")]
    let builder = builder.manage(spike::SpikeState::default());
    builder
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(if test_mode() { tauri::ActivationPolicy::Accessory } else { tauri::ActivationPolicy::Regular });

            let d = dirs(app)?;
            std::fs::create_dir_all(&d.user_data)?;
            let store = secret_store();
            let nonces = Arc::new(mcp::NonceGuard::default());
            let mcp_state = mcp::McpState::new(&d.user_data, mcp_port()).map_err(std::io::Error::other)?;
            *mcp_state.bridge.lock().unwrap() = Some(mcp::renderer_bridge(app.handle().clone(), nonces.clone()));
            let morphic = morphic_client(store.clone());
            let ctx = Ctx {
                user_data: d.user_data.clone(),
                cache: d.cache,
                documents: d.documents,
                home: d.home,
                electron_user_data: d.electron_user_data,
                auth: project::Authorized::default(),
                nonces,
                secrets: store,
                exports: export::Exports::default(),
                proxies: proxy::Proxies::default(),
                tools: tools::Tools::locate(),
                fal: fal_bases(),
                net: Box::new(net::SystemNet),
                mcp: mcp_state,
                morphic,
                test_picks: project::TestPicks::default(),
            };
            // recent.json only ever holds user-picked paths, so authorising them at startup is safe.
            for entry in project::load_recent(&ctx.user_data) {
                ctx.auth.add(&entry.path);
            }
            app.manage(ctx);
            app.state::<Ctx>().mcp.restore();

            menu::rebuild(app.handle());
            app.on_menu_event(|h, e| menu::handle(h, e.id().as_ref()));
            create_window(app, &d.user_data)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) | tauri::WindowEvent::CloseRequested { .. }) && !test_mode() {
                let ctx = window.state::<Ctx>();
                save_window_state(window, &ctx.user_data, matches!(event, tauri::WindowEvent::CloseRequested { .. }));
            }
        })
        .invoke_handler(handlers())
        .build(tauri::generate_context!())
        .expect("error while running Frontstage")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                app.state::<Ctx>().mcp.shutdown();
            }
        });
}

/// Whether the old Electron app left encrypted keys behind. Existence only.
#[tauri::command]
fn secrets_legacy_notice(ctx: tauri::State<'_, Ctx>) -> bool {
    secrets::legacy_secrets_present(&ctx.electron_user_data) && !ctx.user_data.join("legacy-secrets-notice-dismissed").exists()
}

#[tauri::command]
fn secrets_dismiss_legacy_notice(ctx: tauri::State<'_, Ctx>) -> Result<(), String> {
    std::fs::write(ctx.user_data.join("legacy-secrets-notice-dismissed"), "1").map_err(|e| e.to_string())
}

#[tauri::command]
fn app_tools_status(ctx: tauri::State<'_, Ctx>) -> serde_json::Value {
    #[cfg(feature = "webkit-tests")]
    return serde_json::json!({ "ffmpeg": ctx.tools.ffmpeg().is_some(), "ffmpegPath": ctx.tools.ffmpeg() });
    #[cfg(not(feature = "webkit-tests"))]
    serde_json::json!({ "ffmpeg": ctx.tools.ffmpeg().is_some() })
}

macro_rules! handlers_with {
    ($($extra:tt)*) => {
        tauri::generate_handler![
            app_tools_status, secrets_legacy_notice, secrets_dismiss_legacy_notice,
            project::project_read_text, project::project_write_text, project::project_write_media, project::project_read_media, project::project_has_media,
            project::project_write_export_text, project::project_list_recent, project::project_add_recent, project::project_remove_recent,
            project::project_pick_open, project::project_pick_save_as, project::project_pick_export_save, project::project_set_next_pick,
            project::project_set_next_export_pick, project::project_authorize_path,
            projects::projects_list, projects::projects_resolve, projects::projects_create, projects::projects_upsert, projects::projects_cleanup_failed_create,
            export::export_session_start, export::export_session_abort, export::export_video_frame, export::export_audio_data, export::export_session_finish,
            ai::ai_set_key, ai::ai_has_key, ai::ai_clear_key, ai::ai_generate_image, ai::ai_stream_chat,
            gen::gen_fal_submit, gen::gen_fal_status, gen::gen_fal_download, gen::gen_fal_upload,
            media::media_extract_audio_path, media::media_extract_audio_bytes, media::media_read_timecode, media::media_import_scan,
            media::media_import_copy, media::media_import_download, media::media_read_local_file,
            proxy::media_proxy_ensure_path, proxy::media_proxy_ensure_bytes, proxy::media_proxy_read,
            frames::media_sample_frames,
            characters::characters_list_ids, characters::characters_read_file, characters::characters_write_file, characters::characters_remove,
            skills::skills_list, skills::skills_read, skills::skills_write, skills::skills_remove, skills::skills_read_ledger, skills::skills_write_ledger,
            skills::skills_reveal, skills::skills_open_root, skills::skills_export_to_agent, skills::skills_cache_read, skills::skills_cache_write,
            morphic::morphic_status, morphic::morphic_sign_in, morphic::morphic_sign_out, morphic::morphic_call_tool, morphic::morphic_upload, morphic::morphic_download,
            claude::claude_run,
            studio::studio_write_flow_pack,
            mcp::mcp_get_status, mcp::mcp_set_enabled, mcp::mcp_regenerate_token, mcp::mcp_response,
            $($extra)*
        ]
    };
}

#[cfg(feature = "webkit-tests")]
fn handlers() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    handlers_with!(
        spike::clip_bytes, spike::spike_file, spike::decode_pcm, spike::sink_start, spike::sink_frame, spike::sink_finish,
        spike::export_start, spike::export_frame, spike::export_finish, spike::progress, spike::report, spike::smoke_js_dialog_log, spike::smoke_mcp_probe, spike::smoke_menu,
    )
}

#[cfg(not(feature = "webkit-tests"))]
fn handlers() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    handlers_with!()
}
