//! projects:* channels: the MCP nav registry (recent-projects.json) with stable ids.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;

use crate::util::{blocking, iso_now, resolve};
use crate::Ctx;

pub const REGISTRY_FILENAME: &str = "recent-projects.json";
pub const DEFAULT_PROJECT_NAME: &str = "Untitled Project";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Entry {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(rename = "lastOpenedAt")]
    pub last_opened_at: String,
}

pub fn registry_file_path(user_data: &Path) -> PathBuf {
    user_data.join(REGISTRY_FILENAME)
}

pub fn load_registry(user_data: &Path) -> Vec<Entry> {
    let Ok(raw) = fs::read(registry_file_path(user_data)) else { return vec![] };
    let Ok(Value::Array(items)) = serde_json::from_slice::<Value>(&raw) else { return vec![] };
    items.into_iter().filter_map(|v| serde_json::from_value(v).ok()).collect()
}

fn save(user_data: &Path, entries: &[Entry]) -> Result<(), String> {
    fs::create_dir_all(user_data).map_err(|e| e.to_string())?;
    fs::write(registry_file_path(user_data), serde_json::to_vec(entries).unwrap_or_default()).map_err(|e| e.to_string())
}

/// Most recently opened first.
pub fn registry_list(user_data: &Path) -> Vec<Entry> {
    let mut v = load_registry(user_data);
    v.sort_by(|a, b| b.last_opened_at.cmp(&a.last_opened_at));
    v
}

pub fn registry_resolve(user_data: &Path, id: &str) -> Option<Entry> {
    load_registry(user_data).into_iter().find(|e| e.id == id)
}

/// A re-opened project keeps its id and refreshes its name and time.
pub fn registry_upsert(user_data: &Path, project_path: &str, name: &str) -> Result<Entry, String> {
    let resolved = resolve(project_path);
    let path = resolved.to_string_lossy().into_owned();
    let mut entries = load_registry(user_data);
    let now = iso_now();
    let entry = match entries.iter_mut().find(|e| resolve(&e.path) == resolved) {
        Some(e) => {
            e.name = name.to_string();
            e.path = path;
            e.last_opened_at = now;
            e.clone()
        }
        None => {
            let e = Entry { id: uuid::Uuid::new_v4().to_string(), name: name.to_string(), path, last_opened_at: now };
            entries.push(e.clone());
            e
        }
    };
    save(user_data, &entries)?;
    Ok(entry)
}

/// (ok, name). Empty defaults rather than rejects; separators and dot names are refused.
pub fn validate_project_name(raw: Option<&str>) -> (bool, String) {
    let trimmed = raw.unwrap_or("").trim();
    let name = if trimmed.is_empty() { DEFAULT_PROJECT_NAME } else { trimmed }.to_string();
    let ok = !(name.contains('/') || name.contains('\\') || name == "." || name == "..");
    (ok, name)
}

pub fn create(ctx_auth: &crate::project::Authorized, projects_dir: &Path, name: Option<&str>) -> Value {
    let (ok, name) = validate_project_name(name);
    if !ok {
        return json!({ "error": format!("\u{201c}{name}\u{201d} isn't a valid project name. Use a plain name without slashes or path components.") });
    }
    if let Err(e) = fs::create_dir_all(projects_dir) {
        return json!({ "error": e.to_string() });
    }
    let target = projects_dir.join(&name);
    if target.exists() {
        return json!({ "error": format!("A project named \u{201c}{name}\u{201d} already exists in that folder. Pick another name.") });
    }
    if let Err(e) = fs::create_dir_all(&target) {
        return json!({ "error": e.to_string() });
    }
    ctx_auth.add(&target);
    json!({ "path": target.to_string_lossy() })
}

/// Only ever deletes below the fixed projects folder, so it can't become an arbitrary delete.
pub fn cleanup_failed_create(auth: &crate::project::Authorized, projects_dir: &Path, p: &str) -> Value {
    let base = resolve(projects_dir);
    let resolved = resolve(p);
    if resolved == base || !resolved.starts_with(&base) {
        return json!({ "error": "cleanupFailedCreate: path is not under the projects storage dir" });
    }
    let removed = match fs::symlink_metadata(&resolved) {
        Err(_) => Ok(()),
        Ok(m) if m.is_dir() => fs::remove_dir_all(&resolved),
        Ok(_) => fs::remove_file(&resolved),
    };
    if let Err(e) = removed {
        return json!({ "error": e.to_string() });
    }
    auth.remove(&resolved);
    json!({ "ok": true })
}

fn default_projects_dir(ctx: &Ctx) -> PathBuf {
    ctx.documents.join("Frontstage Projects")
}

#[tauri::command]
pub async fn projects_list(ctx: State<'_, Ctx>) -> Result<Value, String> {
    Ok(blocking(|| {
        let rows: Vec<Value> = registry_list(&ctx.user_data)
            .into_iter()
            .map(|e| {
                let ok = Path::new(&e.path).exists();
                let mut v = serde_json::to_value(e).unwrap_or(Value::Null);
                v["isAccessible"] = json!(ok);
                v
            })
            .collect();
        Value::Array(rows)
    }))
}

#[tauri::command]
pub async fn projects_resolve(id: String, ctx: State<'_, Ctx>) -> Result<Option<String>, String> {
    Ok(blocking(|| registry_resolve(&ctx.user_data, &id).map(|e| e.path)))
}

#[tauri::command]
pub async fn projects_create(name: Option<String>, ctx: State<'_, Ctx>) -> Result<Value, String> {
    Ok(blocking(|| create(&ctx.auth, &default_projects_dir(&ctx), name.as_deref())))
}

#[tauri::command]
pub async fn projects_upsert(path: String, name: String, ctx: State<'_, Ctx>) -> Result<Entry, String> {
    blocking(|| registry_upsert(&ctx.user_data, &path, &name))
}

#[tauri::command]
pub async fn projects_cleanup_failed_create(p: String, ctx: State<'_, Ctx>) -> Result<Value, String> {
    Ok(blocking(|| cleanup_failed_create(&ctx.auth, &default_projects_dir(&ctx), &p)))
}

#[cfg(test)]
mod tests {
    //! Port of apps/desktop/test/project-registry.test.ts, plus the Rust half of the project-nav guards.
    use super::*;
    use crate::project::Authorized;
    use crate::util::testutil::TempDir;
    use std::thread::sleep;
    use std::time::Duration;

    #[test]
    fn registry_file_path_joins_user_data() {
        assert_eq!(registry_file_path(Path::new("/x/y")), Path::new("/x/y").join(REGISTRY_FILENAME));
    }

    #[test]
    fn missing_file_is_empty() {
        let d = TempDir::new("reg");
        assert!(load_registry(d.path()).is_empty());
    }

    #[test]
    fn malformed_json_is_empty() {
        let d = TempDir::new("reg");
        fs::write(registry_file_path(d.path()), "{ not json").unwrap();
        assert!(load_registry(d.path()).is_empty());
    }

    #[test]
    fn non_array_json_is_empty() {
        let d = TempDir::new("reg");
        fs::write(registry_file_path(d.path()), r#"{"foo":"bar"}"#).unwrap();
        assert!(load_registry(d.path()).is_empty());
    }

    #[test]
    fn malformed_entries_are_filtered_and_valid_ones_kept() {
        let d = TempDir::new("reg");
        fs::write(
            registry_file_path(d.path()),
            r#"[{"id":"a","name":"A","path":"/a","lastOpenedAt":"2026-01-01T00:00:00.000Z"},{"id":"b"},"not an object"]"#,
        )
        .unwrap();
        let v = load_registry(d.path());
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].id, "a");
    }

    #[test]
    fn upsert_inserts_with_generated_id_and_persists() {
        let d = TempDir::new("reg");
        let e = registry_upsert(d.path(), "/projects/Alpha", "Alpha").unwrap();
        assert_eq!(e.name, "Alpha");
        assert_eq!(e.path, "/projects/Alpha");
        assert!(!e.id.is_empty());
        assert_eq!(load_registry(d.path()), vec![e]);
    }

    #[test]
    fn re_upsert_keeps_id_and_refreshes_name_and_time() {
        let d = TempDir::new("reg");
        let first = registry_upsert(d.path(), "/projects/Alpha", "Alpha").unwrap();
        sleep(Duration::from_millis(5));
        let second = registry_upsert(d.path(), "/projects/Alpha", "Alpha Renamed").unwrap();
        assert_eq!(second.id, first.id);
        assert_eq!(second.name, "Alpha Renamed");
        assert!(second.last_opened_at >= first.last_opened_at);
        assert_eq!(load_registry(d.path()).len(), 1);
    }

    #[test]
    fn distinct_paths_are_distinct_entries() {
        let d = TempDir::new("reg");
        registry_upsert(d.path(), "/projects/Alpha", "Alpha").unwrap();
        registry_upsert(d.path(), "/projects/Beta", "Beta").unwrap();
        assert_eq!(load_registry(d.path()).len(), 2);
    }

    #[test]
    fn list_sorts_most_recently_opened_first() {
        let d = TempDir::new("reg");
        registry_upsert(d.path(), "/projects/Alpha", "Alpha").unwrap();
        sleep(Duration::from_millis(5));
        registry_upsert(d.path(), "/projects/Beta", "Beta").unwrap();
        sleep(Duration::from_millis(5));
        registry_upsert(d.path(), "/projects/Alpha", "Alpha").unwrap();
        let names: Vec<String> = registry_list(d.path()).into_iter().map(|e| e.name).collect();
        assert_eq!(names, ["Alpha", "Beta"]);
    }

    #[test]
    fn resolve_known_id_and_unknown_id() {
        let d = TempDir::new("reg");
        let e = registry_upsert(d.path(), "/projects/Alpha", "Alpha").unwrap();
        assert_eq!(registry_resolve(d.path(), &e.id), Some(e));
        assert_eq!(registry_resolve(d.path(), "nonexistent"), None);
    }

    #[test]
    fn plain_names_are_valid_and_trimmed() {
        assert_eq!(validate_project_name(Some("My Reel")), (true, "My Reel".to_string()));
        assert_eq!(validate_project_name(Some("  My Reel  ")), (true, "My Reel".to_string()));
    }

    #[test]
    fn empty_names_default() {
        for n in [Some(""), Some("   "), None] {
            assert_eq!(validate_project_name(n), (true, DEFAULT_PROJECT_NAME.to_string()));
        }
    }

    #[test]
    fn slashes_and_dot_names_are_rejected() {
        assert_eq!(validate_project_name(Some("a/b")), (false, "a/b".to_string()));
        assert_eq!(validate_project_name(Some("a\\b")), (false, "a\\b".to_string()));
        assert_eq!(validate_project_name(Some(".")), (false, ".".to_string()));
        assert_eq!(validate_project_name(Some("..")), (false, "..".to_string()));
    }

    #[test]
    fn dots_elsewhere_are_fine() {
        assert_eq!(validate_project_name(Some("v1.2 Final")), (true, "v1.2 Final".to_string()));
    }

    #[test]
    fn create_refuses_a_traversal_name_and_a_taken_name() {
        let d = TempDir::new("create");
        let a = Authorized::default();
        let r = create(&a, d.path(), Some("../evil"));
        assert!(r["error"].as_str().unwrap().contains("isn't a valid project name"));
        assert!(!d.path().parent().unwrap().join("evil").exists());
        let ok = create(&a, d.path(), Some("New"));
        a.check(ok["path"].as_str().unwrap()).unwrap();
        assert!(create(&a, d.path(), Some("New"))["error"].as_str().unwrap().contains("already exists"));
    }

    #[test]
    fn cleanup_refuses_anything_outside_the_projects_folder_and_the_folder_itself() {
        let root = TempDir::new("cleanup");
        let base = root.path().join("Frontstage Projects");
        fs::create_dir_all(base.join("Doomed")).unwrap();
        let outside = root.path().join("keep");
        fs::create_dir_all(&outside).unwrap();
        let a = Authorized::default();
        for bad in [base.to_str().unwrap().to_string(), outside.to_str().unwrap().to_string(), format!("{}/../keep", base.display()), format!("{}-sibling/x", base.display())] {
            assert!(cleanup_failed_create(&a, &base, &bad)["error"].is_string(), "{bad}");
        }
        assert!(outside.exists() && base.exists());
        let doomed = base.join("Doomed");
        a.add(&doomed);
        assert_eq!(cleanup_failed_create(&a, &base, doomed.to_str().unwrap())["ok"], json!(true));
        assert!(!doomed.exists());
        assert!(a.check(&doomed).is_err());
    }
}
