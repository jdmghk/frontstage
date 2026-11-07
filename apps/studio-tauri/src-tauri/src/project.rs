//! project:* channels: the authorised-directory checks, project files, recents, pickers.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::ipc::{Request, Response};
use tauri::{AppHandle, State};

use crate::util::{blocking, header, raw_body, resolve};
use crate::{dialogs, menu, Ctx};

// ── Authorisation ───────────────────────────────────────────────────────────

/// Directories the user picked (or that an in-flight MCP call authorised). Every project read and
/// write goes through this set.
#[derive(Default)]
pub struct Authorized(Mutex<HashSet<PathBuf>>);

impl Authorized {
    pub fn add(&self, p: impl AsRef<Path>) {
        self.0.lock().unwrap().insert(resolve(p));
    }
    pub fn remove(&self, p: impl AsRef<Path>) {
        self.0.lock().unwrap().remove(&resolve(p));
    }
    pub fn check(&self, dir: impl AsRef<Path>) -> Result<(), String> {
        if self.0.lock().unwrap().contains(&resolve(dir)) { Ok(()) } else { Err("unauthorized project dir".into()) }
    }
}

/// `rel` resolved against `dir`; refuses anything outside it, and the directory itself.
pub fn assert_inside(dir: impl AsRef<Path>, rel: &str) -> Result<PathBuf, String> {
    let base = resolve(dir);
    let full = crate::util::normalize(&base.join(rel));
    if full == base || !full.starts_with(&base) {
        return Err(format!("path escapes project dir: {rel}"));
    }
    Ok(full)
}

/// Output-path rule shared by export:start and project:writeExportText: an authorised directory
/// (picked through pickExportSave), or the temp dir.
pub fn check_output_path(auth: &Authorized, out_path: &str) -> Result<PathBuf, String> {
    let resolved = resolve(out_path);
    let out_dir = resolved.parent().map(Path::to_path_buf).unwrap_or_else(|| resolved.clone());
    let tmp = resolve(std::env::temp_dir());
    if !(out_dir == tmp || out_dir.starts_with(&tmp)) {
        auth.check(&out_dir)?;
    }
    Ok(resolved)
}

fn write_all(f: &Path, data: &[u8]) -> Result<(), String> {
    if let Some(p) = f.parent() {
        fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    fs::write(f, data).map_err(|e| e.to_string())
}

pub fn read_text(auth: &Authorized, dir: &str, name: &str) -> Result<Option<String>, String> {
    auth.check(dir)?;
    let f = assert_inside(dir, name)?;
    match fs::read(&f) {
        Ok(b) => Ok(Some(String::from_utf8_lossy(&b).into_owned())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

pub fn write_text(auth: &Authorized, dir: &str, name: &str, data: &str) -> Result<(), String> {
    auth.check(dir)?;
    write_all(&assert_inside(dir, name)?, data.as_bytes())
}

pub fn write_media(auth: &Authorized, dir: &str, rel: &str, bytes: &[u8]) -> Result<(), String> {
    auth.check(dir)?;
    write_all(&assert_inside(dir, rel)?, bytes)
}

pub fn read_media(auth: &Authorized, dir: &str, rel: &str) -> Result<Vec<u8>, String> {
    auth.check(dir)?;
    let f = assert_inside(dir, rel)?;
    match fs::read(&f) {
        Ok(b) => Ok(b),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(format!("media not found: {rel}")),
        Err(e) => Err(e.to_string()),
    }
}

pub fn has_media(auth: &Authorized, dir: &str, rel: &str) -> Result<bool, String> {
    auth.check(dir)?;
    Ok(assert_inside(dir, rel)?.exists())
}

pub fn write_export_text(auth: &Authorized, out_path: &str, contents: &str, overwrite: Option<bool>) -> Result<String, String> {
    let resolved = check_output_path(auth, out_path)?;
    if overwrite == Some(false) && resolved.exists() {
        return Err("output file already exists".into());
    }
    write_all(&resolved, contents.as_bytes())?;
    Ok(resolved.to_string_lossy().into_owned())
}

// ── recent.json (File > Open Recent) ────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct RecentEntry {
    pub id: String,
    pub name: String,
    pub path: String,
}

fn recent_path(user_data: &Path) -> PathBuf {
    user_data.join("recent.json")
}

pub fn load_recent(user_data: &Path) -> Vec<RecentEntry> {
    let Ok(raw) = fs::read(recent_path(user_data)) else { return vec![] };
    let Ok(Value::Array(items)) = serde_json::from_slice::<Value>(&raw) else { return vec![] };
    items.into_iter().filter_map(|v| serde_json::from_value(v).ok()).collect()
}

fn save_recent(user_data: &Path, entries: &[RecentEntry]) -> Result<(), String> {
    fs::create_dir_all(user_data).map_err(|e| e.to_string())?;
    fs::write(recent_path(user_data), serde_json::to_vec(entries).unwrap_or_default()).map_err(|e| e.to_string())
}

/// Only user-picked (authorised) paths may enter recent.json, because startup authorises them.
pub fn add_recent(auth: &Authorized, user_data: &Path, rec: RecentEntry) -> Result<(), String> {
    auth.check(&rec.path)?;
    let mut entries: Vec<RecentEntry> = load_recent(user_data).into_iter().filter(|e| e.id != rec.id && e.path != rec.path).collect();
    entries.insert(0, rec);
    entries.truncate(10);
    save_recent(user_data, &entries)
}

pub fn remove_recent(user_data: &Path, id: &str) -> Result<(), String> {
    let entries: Vec<RecentEntry> = load_recent(user_data).into_iter().filter(|e| e.id != id).collect();
    save_recent(user_data, &entries)
}

// ── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn project_read_text(dir: String, name: String, ctx: State<'_, Ctx>) -> Result<Option<String>, String> {
    blocking(|| read_text(&ctx.auth, &dir, &name))
}

#[tauri::command]
pub async fn project_write_text(dir: String, name: String, data: String, ctx: State<'_, Ctx>) -> Result<(), String> {
    blocking(|| write_text(&ctx.auth, &dir, &name, &data))
}

/// Raw body; dir and rel travel as percent-encoded headers.
#[tauri::command]
pub async fn project_write_media(request: Request<'_>, ctx: State<'_, Ctx>) -> Result<(), String> {
    let (dir, rel) = (header(&request, "x-dir")?, header(&request, "x-rel")?);
    let body = raw_body(&request)?;
    blocking(|| write_media(&ctx.auth, &dir, &rel, body))
}

#[tauri::command]
pub async fn project_read_media(dir: String, rel: String, ctx: State<'_, Ctx>) -> Result<Response, String> {
    blocking(|| read_media(&ctx.auth, &dir, &rel)).map(Response::new)
}

#[tauri::command]
pub async fn project_has_media(dir: String, rel: String, ctx: State<'_, Ctx>) -> Result<bool, String> {
    blocking(|| has_media(&ctx.auth, &dir, &rel))
}

#[tauri::command]
pub async fn project_write_export_text(out_path: String, contents: String, overwrite: Option<bool>, ctx: State<'_, Ctx>) -> Result<String, String> {
    blocking(|| write_export_text(&ctx.auth, &out_path, &contents, overwrite))
}

#[tauri::command]
pub async fn project_list_recent(ctx: State<'_, Ctx>) -> Result<Vec<RecentEntry>, String> {
    let mut v = blocking(|| load_recent(&ctx.user_data));
    v.truncate(10);
    Ok(v)
}

#[tauri::command]
pub async fn project_add_recent(rec: Value, app: AppHandle, ctx: State<'_, Ctx>) -> Result<(), String> {
    let rec: RecentEntry = serde_json::from_value(rec).map_err(|_| "invalid recent entry shape".to_string())?;
    blocking(|| add_recent(&ctx.auth, &ctx.user_data, rec))?;
    menu::rebuild(&app);
    Ok(())
}

#[tauri::command]
pub async fn project_remove_recent(id: String, app: AppHandle, ctx: State<'_, Ctx>) -> Result<(), String> {
    blocking(|| remove_recent(&ctx.user_data, &id))?;
    menu::rebuild(&app);
    Ok(())
}

#[tauri::command]
pub async fn project_pick_open(app: AppHandle, ctx: State<'_, Ctx>) -> Result<Option<String>, String> {
    if let Some(p) = ctx.test_picks.take_project() {
        ctx.auth.add(&p);
        return Ok(Some(p));
    }
    let Some(p) = dialogs::pick_folder(&app, None).await else { return Ok(None) };
    ctx.auth.add(&p);
    Ok(Some(p))
}

#[tauri::command]
pub async fn project_pick_save_as(name: Option<String>, app: AppHandle, ctx: State<'_, Ctx>) -> Result<Option<String>, String> {
    let _ = name; // Electron's picker ignored the suggested name too.
    let picked = match ctx.test_picks.take_project() {
        Some(p) => Some(p),
        None => dialogs::pick_folder(&app, None).await,
    };
    let Some(p) = picked else { return Ok(None) };
    fs::create_dir_all(&p).map_err(|e| e.to_string())?;
    ctx.auth.add(&p);
    Ok(Some(p))
}

#[derive(Deserialize)]
pub struct SaveFilter {
    name: Option<String>,
    extensions: Option<Vec<String>>,
}

#[tauri::command]
pub async fn project_pick_export_save(suggested_name: Option<String>, filter: Option<SaveFilter>, app: AppHandle, ctx: State<'_, Ctx>) -> Result<Option<String>, String> {
    let p = match ctx.test_picks.take_export() {
        Some(p) => p,
        None => {
            let filters = match filter {
                Some(SaveFilter { name: Some(n), extensions: Some(x) }) => vec![(n, x)],
                _ => vec![("MP4 video".to_string(), vec!["mp4".to_string()]), ("QuickTime".to_string(), vec!["mov".to_string()])],
            };
            match dialogs::save_file(&app, suggested_name.as_deref().unwrap_or(""), filters).await {
                Some(p) => p,
                None => return Ok(None),
            }
        }
    };
    if let Some(parent) = Path::new(&p).parent() {
        ctx.auth.add(parent);
    }
    Ok(Some(p))
}

/// Test seam, as in Electron: refused outside a webkit-tests build.
#[tauri::command]
pub fn project_set_next_pick(p: String, ctx: State<'_, Ctx>) -> Result<(), String> {
    ctx.test_picks.set_project(p)
}

#[tauri::command]
pub fn project_set_next_export_pick(p: String, ctx: State<'_, Ctx>) -> Result<(), String> {
    ctx.test_picks.set_export(p)
}

/// The pickerless authorise primitive: needs a nonce minted for an in-flight MCP tool call.
pub fn authorize_path(auth: &Authorized, nonces: &crate::mcp::NonceGuard, p: &str, nonce: Option<&str>) -> Value {
    if !nonces.consume(nonce) {
        return json!({ "error": "project:authorizePath requires an in-flight MCP tool call. Open the project from the app once to authorize it." });
    }
    let resolved = resolve(p);
    if !resolved.exists() {
        return json!({ "error": format!("No project at {}.", resolved.display()) });
    }
    auth.add(&resolved);
    json!({ "path": resolved.to_string_lossy() })
}

#[tauri::command]
pub async fn project_authorize_path(p: String, nonce: Option<String>, ctx: State<'_, Ctx>) -> Result<Value, String> {
    Ok(blocking(|| authorize_path(&ctx.auth, &ctx.nonces, &p, nonce.as_deref())))
}

#[derive(Default)]
pub struct TestPicks {
    project: Mutex<Option<String>>,
    export: Mutex<Option<String>>,
}

impl TestPicks {
    pub fn take_project(&self) -> Option<String> {
        self.project.lock().unwrap().take()
    }
    fn take_export(&self) -> Option<String> {
        self.export.lock().unwrap().take()
    }
    fn set_project(&self, p: String) -> Result<(), String> {
        if !cfg!(feature = "webkit-tests") {
            return Err("test-only".into());
        }
        *self.project.lock().unwrap() = Some(p);
        Ok(())
    }
    fn set_export(&self, p: String) -> Result<(), String> {
        if !cfg!(feature = "webkit-tests") {
            return Err("test-only".into());
        }
        *self.export.lock().unwrap() = Some(p);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::NonceGuard;
    use crate::util::testutil::TempDir;

    fn authed() -> (Authorized, TempDir) {
        let d = TempDir::new("project");
        let a = Authorized::default();
        a.add(d.path());
        (a, d)
    }

    #[test]
    fn unauthorized_dir_is_refused_by_every_operation_and_nothing_is_written() {
        let d = TempDir::new("unauth");
        let a = Authorized::default();
        let dir = d.path().to_str().unwrap();
        let bad = "unauthorized project dir";
        assert_eq!(read_text(&a, dir, "x").unwrap_err(), bad);
        assert_eq!(write_text(&a, dir, "x", "y").unwrap_err(), bad);
        assert_eq!(write_media(&a, dir, "x", b"y").unwrap_err(), bad);
        assert_eq!(read_media(&a, dir, "x").unwrap_err(), bad);
        assert_eq!(has_media(&a, dir, "x").unwrap_err(), bad);
        assert!(!d.path().join("x").exists());
    }

    #[test]
    fn a_sibling_with_the_same_prefix_is_not_authorized() {
        let (a, d) = authed();
        let sibling = format!("{}-evil", d.path().display());
        fs::create_dir_all(&sibling).unwrap();
        assert!(read_text(&a, &sibling, "x").is_err());
        fs::remove_dir_all(&sibling).unwrap();
    }

    #[test]
    fn traversal_out_of_an_authorized_dir_is_refused() {
        let (a, d) = authed();
        let dir = d.path().to_str().unwrap();
        fs::write(d.path().parent().unwrap().join("frontstage-outside.txt"), "secret").unwrap();
        for bad in ["..", "../frontstage-outside.txt", "a/../../frontstage-outside.txt", ".", "", "/etc/passwd"] {
            let e = read_text(&a, dir, bad).unwrap_err();
            assert!(e.contains("path escapes"), "{bad}: {e}");
            assert!(write_media(&a, dir, bad, b"x").unwrap_err().contains("path escapes"));
        }
        // A name reaching out and coming back in is fine, like path.resolve.
        write_text(&a, dir, &format!("../{}/ok.txt", d.path().file_name().unwrap().to_str().unwrap()), "ok").unwrap();
        assert_eq!(read_text(&a, dir, "ok.txt").unwrap().unwrap(), "ok");
        fs::remove_file(d.path().parent().unwrap().join("frontstage-outside.txt")).unwrap();
    }

    #[test]
    fn text_and_media_round_trip_and_missing_files_behave_like_electron() {
        let (a, d) = authed();
        let dir = d.path().to_str().unwrap();
        assert_eq!(read_text(&a, dir, "project.json").unwrap(), None);
        write_text(&a, dir, "sub/project.json", "{}").unwrap();
        assert_eq!(read_text(&a, dir, "sub/project.json").unwrap().unwrap(), "{}");
        assert!(!has_media(&a, dir, "media/a.mp4").unwrap());
        assert_eq!(read_media(&a, dir, "media/a.mp4").unwrap_err(), "media not found: media/a.mp4");
        write_media(&a, dir, "media/a.mp4", &[1, 2, 3]).unwrap();
        assert!(has_media(&a, dir, "media/a.mp4").unwrap());
        assert_eq!(read_media(&a, dir, "media/a.mp4").unwrap(), vec![1, 2, 3]);
    }

    #[test]
    fn export_text_needs_an_authorized_dir_or_the_temp_dir() {
        let (a, d) = authed();
        let denied = dirs_home_like().join(".frontstage-test-unauth/evil.xml");
        assert_eq!(write_export_text(&a, denied.to_str().unwrap(), "x", None).unwrap_err(), "unauthorized project dir");
        assert!(!denied.exists());

        let ok = d.path().join("out.xml");
        write_export_text(&a, ok.to_str().unwrap(), "x", None).unwrap();
        assert_eq!(write_export_text(&a, ok.to_str().unwrap(), "y", Some(false)).unwrap_err(), "output file already exists");
        assert_eq!(fs::read_to_string(&ok).unwrap(), "x");
        write_export_text(&a, ok.to_str().unwrap(), "y", Some(true)).unwrap();
        assert_eq!(fs::read_to_string(&ok).unwrap(), "y");
    }

    fn dirs_home_like() -> PathBuf {
        PathBuf::from("/private/var/empty-not-temp")
    }

    #[test]
    fn recent_only_accepts_authorized_paths_and_stays_capped_and_deduped() {
        let (a, d) = authed();
        let data = TempDir::new("recent");
        let p = d.path().to_string_lossy().into_owned();
        let denied = RecentEntry { id: "x".into(), name: "x".into(), path: "/not/picked".into() };
        assert_eq!(add_recent(&a, data.path(), denied).unwrap_err(), "unauthorized project dir");
        assert!(load_recent(data.path()).is_empty());

        for i in 0..12 {
            add_recent(&a, data.path(), RecentEntry { id: format!("{i}"), name: "n".into(), path: p.clone() }).unwrap();
        }
        // Same path each time: deduped down to the newest.
        assert_eq!(load_recent(data.path()).len(), 1);
        assert_eq!(load_recent(data.path())[0].id, "11");
        remove_recent(data.path(), "11").unwrap();
        assert!(load_recent(data.path()).is_empty());
    }

    #[test]
    fn malformed_recent_files_load_as_empty_and_bad_rows_are_dropped() {
        let data = TempDir::new("recent-bad");
        fs::write(data.path().join("recent.json"), "{ nope").unwrap();
        assert!(load_recent(data.path()).is_empty());
        fs::write(data.path().join("recent.json"), r#"[{"id":"a","name":"A","path":"/a"},{"id":"b"},"x"]"#).unwrap();
        assert_eq!(load_recent(data.path()).len(), 1);
    }

    #[test]
    fn authorize_path_without_a_live_nonce_is_refused_and_grants_nothing() {
        let d = TempDir::new("nonce");
        let (a, n) = (Authorized::default(), NonceGuard::default());
        let dir = d.path().to_str().unwrap();
        for nonce in [None, Some(""), Some("guess")] {
            let r = authorize_path(&a, &n, dir, nonce);
            assert!(r["error"].as_str().unwrap().contains("in-flight MCP tool call"));
        }
        assert!(a.check(dir).is_err());
    }

    #[test]
    fn authorize_path_consumes_its_nonce_once() {
        let d = TempDir::new("nonce2");
        let (a, n) = (Authorized::default(), NonceGuard::default());
        let dir = d.path().to_str().unwrap();
        let nonce = n.mint().unwrap();
        assert_eq!(authorize_path(&a, &n, dir, Some(&nonce))["path"].as_str().unwrap(), resolve(dir).to_str().unwrap());
        a.check(dir).unwrap();

        let other = TempDir::new("nonce3");
        assert!(authorize_path(&a, &n, other.path().to_str().unwrap(), Some(&nonce))["error"].is_string());
        assert!(a.check(other.path()).is_err());
    }

    #[test]
    fn authorize_path_reports_a_missing_directory_without_authorizing_it() {
        let (a, n) = (Authorized::default(), NonceGuard::default());
        let nonce = n.mint().unwrap();
        let r = authorize_path(&a, &n, "/definitely/not/here", Some(&nonce));
        // Resolved like Node's path.resolve, so Windows adds the current drive.
        let shown = crate::util::resolve("/definitely/not/here").display().to_string();
        assert_eq!(r["error"].as_str().unwrap(), format!("No project at {shown}."));
        assert!(a.check("/definitely/not/here").is_err());
    }
}
