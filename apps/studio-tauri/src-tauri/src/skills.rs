//! skills:* channels over ~/.frontstage/skills/<id>/SKILL.md, shared with the Swift app's layout.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Map, Value};
use tauri::State;

use crate::util::blocking;
use crate::{shell, Ctx};

const SKILL_MD: &str = "SKILL.md";
const LEDGER_FILENAME: &str = ".installed.json";

pub fn skills_root_path(home: &Path) -> PathBuf {
    home.join(".frontstage").join("skills")
}

/// A single safe path component.
pub fn is_valid_skill_id(id: &str) -> bool {
    !id.is_empty() && id != "." && id != ".." && !id.contains('/') && !id.contains('\\')
}

pub fn skill_dir_path(root: &Path, id: &str) -> Result<PathBuf, String> {
    if !is_valid_skill_id(id) {
        return Err(format!("invalid skill id: {id}"));
    }
    Ok(root.join(id))
}

pub fn skill_md_path(root: &Path, id: &str) -> Result<PathBuf, String> {
    Ok(skill_dir_path(root, id)?.join(SKILL_MD))
}

#[derive(Serialize, Debug, PartialEq)]
pub struct SkillEntry {
    pub id: String,
    pub text: String,
}

pub fn list_skills(root: &Path) -> Vec<SkillEntry> {
    let Ok(rd) = fs::read_dir(root) else { return vec![] };
    let mut out: Vec<SkillEntry> = rd
        .filter_map(Result::ok)
        .filter_map(|e| {
            let id = e.file_name().into_string().ok()?;
            let bytes = fs::read(root.join(&id).join(SKILL_MD)).ok()?;
            Some(SkillEntry { id, text: String::from_utf8_lossy(&bytes).into_owned() })
        })
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

pub fn read_skill(root: &Path, id: &str) -> Result<Option<String>, String> {
    match fs::read(skill_md_path(root, id)?) {
        Ok(b) => Ok(Some(String::from_utf8_lossy(&b).into_owned())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

pub fn write_skill(root: &Path, id: &str, text: &str) -> Result<(), String> {
    let dir = skill_dir_path(root, id)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::write(dir.join(SKILL_MD), text).map_err(|e| e.to_string())
}

/// Unlinks a symlink rather than following it, like fs.rmSync.
fn remove_path(p: &Path) -> Result<(), String> {
    let result = match fs::symlink_metadata(p) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => Err(e),
        Ok(m) if m.is_dir() => fs::remove_dir_all(p),
        Ok(_) => fs::remove_file(p),
    };
    result.map_err(|e| e.to_string())
}

pub fn remove_skill(root: &Path, id: &str) -> Result<(), String> {
    remove_path(&skill_dir_path(root, id)?)
}

pub fn ledger_file_path(root: &Path) -> PathBuf {
    root.join(LEDGER_FILENAME)
}

pub fn read_ledger_file(root: &Path) -> Map<String, Value> {
    fs::read(ledger_file_path(root))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| if let Value::Object(m) = v { Some(m) } else { None })
        .unwrap_or_default()
}

pub fn write_ledger_file(root: &Path, ledger: &Value) -> Result<(), String> {
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    fs::write(ledger_file_path(root), ledger.to_string()).map_err(|e| e.to_string())
}

pub fn is_allowed_export_agent(agent: &str) -> bool {
    matches!(agent, "claude" | "codex" | "cursor")
}

/// The "frontstage-" prefix means we only ever overwrite our own earlier copy.
pub fn export_dest_dir(home: &Path, agent: &str, id: &str) -> PathBuf {
    home.join(format!(".{agent}")).join("skills").join(format!("frontstage-{id}"))
}

/// cp -R without dereferencing: a symlink is recreated as a symlink, never followed.
fn copy_no_deref(src: &Path, dest: &Path) -> std::io::Result<()> {
    let meta = fs::symlink_metadata(src)?;
    if meta.file_type().is_symlink() {
        let target = fs::read_link(src)?;
        #[cfg(unix)]
        return std::os::unix::fs::symlink(target, dest);
        #[cfg(windows)]
        return if src.is_dir() { std::os::windows::fs::symlink_dir(target, dest) } else { std::os::windows::fs::symlink_file(target, dest) };
    }
    if meta.is_dir() {
        fs::create_dir_all(dest)?;
        for entry in fs::read_dir(src)? {
            let entry = entry?;
            copy_no_deref(&entry.path(), &dest.join(entry.file_name()))?;
        }
        return Ok(());
    }
    fs::copy(src, dest).map(|_| ())
}

pub fn export_skill_to_agent(root: &Path, home: &Path, id: &str, agent: &str) -> Result<PathBuf, String> {
    if !is_allowed_export_agent(agent) {
        return Err(format!("invalid export agent: {agent}"));
    }
    let source = skill_dir_path(root, id)?;
    if !source.exists() {
        return Err(format!("skill not found: {id}"));
    }
    let dest = export_dest_dir(home, agent, id);
    fs::create_dir_all(dest.parent().expect("has a parent")).map_err(|e| e.to_string())?;
    remove_path(&dest)?;
    copy_no_deref(&source, &dest).map_err(|e| e.to_string())?;
    Ok(dest)
}

fn root(ctx: &Ctx) -> PathBuf {
    skills_root_path(&ctx.home)
}

fn cache_path(ctx: &Ctx) -> PathBuf {
    ctx.user_data.join("skills-catalog.json")
}

#[tauri::command]
pub async fn skills_list(ctx: State<'_, Ctx>) -> Result<Vec<SkillEntry>, String> {
    Ok(blocking(|| list_skills(&root(&ctx))))
}

#[tauri::command]
pub async fn skills_read(id: String, ctx: State<'_, Ctx>) -> Result<Option<String>, String> {
    blocking(|| read_skill(&root(&ctx), &id))
}

#[tauri::command]
pub async fn skills_write(id: String, text: String, ctx: State<'_, Ctx>) -> Result<(), String> {
    blocking(|| write_skill(&root(&ctx), &id, &text))
}

#[tauri::command]
pub async fn skills_remove(id: String, ctx: State<'_, Ctx>) -> Result<(), String> {
    blocking(|| remove_skill(&root(&ctx), &id))
}

#[tauri::command]
pub async fn skills_read_ledger(ctx: State<'_, Ctx>) -> Result<Map<String, Value>, String> {
    Ok(blocking(|| read_ledger_file(&root(&ctx))))
}

#[tauri::command]
pub async fn skills_write_ledger(ledger: Value, ctx: State<'_, Ctx>) -> Result<(), String> {
    blocking(|| write_ledger_file(&root(&ctx), &ledger))
}

#[tauri::command]
pub async fn skills_reveal(id: String, ctx: State<'_, Ctx>) -> Result<(), String> {
    shell::reveal(&skill_md_path(&root(&ctx), &id)?)
}

#[tauri::command]
pub async fn skills_open_root(ctx: State<'_, Ctx>) -> Result<(), String> {
    let r = root(&ctx);
    blocking(|| fs::create_dir_all(&r)).map_err(|e| e.to_string())?;
    shell::open_path(&r)
}

#[tauri::command]
pub async fn skills_export_to_agent(id: String, agent: String, ctx: State<'_, Ctx>) -> Result<Value, String> {
    let dest = blocking(|| export_skill_to_agent(&root(&ctx), &ctx.home, &id, &agent))?;
    Ok(json!({ "path": dest.to_string_lossy() }))
}

#[tauri::command]
pub async fn skills_cache_read(ctx: State<'_, Ctx>) -> Result<Option<String>, String> {
    Ok(blocking(|| fs::read_to_string(cache_path(&ctx)).ok()))
}

#[tauri::command]
pub async fn skills_cache_write(text: String, ctx: State<'_, Ctx>) -> Result<(), String> {
    blocking(|| {
        fs::create_dir_all(&ctx.user_data).map_err(|e| e.to_string())?;
        fs::write(cache_path(&ctx), text).map_err(|e| e.to_string())
    })
}

#[cfg(test)]
mod tests {
    //! Port of apps/desktop/test/skills-fs.test.ts.
    use super::*;
    use crate::util::testutil::TempDir;

    fn write_md(dir: &Path, id: &str, text: &str) {
        fs::create_dir_all(dir.join(id)).unwrap();
        fs::write(dir.join(id).join("SKILL.md"), text).unwrap();
    }

    #[test]
    fn root_joins_home() {
        assert_eq!(skills_root_path(Path::new("/x")), Path::new("/x/.frontstage/skills"));
    }

    #[test]
    fn id_guard_accepts_plain_and_dotted_ids() {
        assert!(is_valid_skill_id("my-skill"));
        assert!(is_valid_skill_id("v1.2-final"));
    }

    #[test]
    fn id_guard_rejects_empty_dots_slashes_and_backslashes() {
        for bad in ["", ".", "..", "../../etc/passwd", "a/b", "..\\..\\Windows", "a\\b"] {
            assert!(!is_valid_skill_id(bad), "{bad}");
        }
    }

    #[test]
    fn paths_for_a_valid_id() {
        let r = TempDir::new("skills");
        assert_eq!(skill_dir_path(r.path(), "foo").unwrap(), r.path().join("foo"));
        assert_eq!(skill_md_path(r.path(), "foo").unwrap(), r.path().join("foo/SKILL.md"));
    }

    #[test]
    fn paths_throw_for_every_traversal_attempt() {
        let r = TempDir::new("skills");
        for bad in ["", ".", "..", "../x", "a/b", "a\\b"] {
            assert!(skill_dir_path(r.path(), bad).unwrap_err().contains("invalid skill id"));
            assert!(skill_md_path(r.path(), bad).unwrap_err().contains("invalid skill id"));
        }
    }

    #[test]
    fn list_of_a_missing_root_is_empty() {
        let r = TempDir::new("skills");
        assert!(list_skills(&r.path().join("nonexistent")).is_empty());
    }

    #[test]
    fn list_reads_folders_with_skill_md_and_skips_the_rest() {
        let r = TempDir::new("skills");
        write_md(r.path(), "alpha", "---\nname: Alpha\n---\nbody");
        write_md(r.path(), "beta", "---\nname: Beta\n---\nbody2");
        fs::create_dir_all(r.path().join("no-md")).unwrap();
        fs::write(r.path().join(".installed.json"), "{}").unwrap();
        assert_eq!(
            list_skills(r.path()),
            vec![
                SkillEntry { id: "alpha".into(), text: "---\nname: Alpha\n---\nbody".into() },
                SkillEntry { id: "beta".into(), text: "---\nname: Beta\n---\nbody2".into() },
            ]
        );
    }

    #[test]
    fn write_then_read() {
        let r = TempDir::new("skills");
        write_skill(r.path(), "my-skill", "---\nname: X\ndescription: Y\n---\nbody").unwrap();
        assert_eq!(read_skill(r.path(), "my-skill").unwrap().unwrap(), "---\nname: X\ndescription: Y\n---\nbody");
    }

    #[test]
    fn read_of_a_nonexistent_skill_is_null() {
        let r = TempDir::new("skills");
        assert_eq!(read_skill(r.path(), "nope").unwrap(), None);
    }

    #[test]
    fn remove_deletes_the_whole_folder() {
        let r = TempDir::new("skills");
        write_skill(r.path(), "my-skill", "content").unwrap();
        remove_skill(r.path(), "my-skill").unwrap();
        assert_eq!(read_skill(r.path(), "my-skill").unwrap(), None);
        assert!(!r.path().join("my-skill").exists());
    }

    #[test]
    fn remove_of_a_nonexistent_skill_is_a_no_op() {
        let r = TempDir::new("skills");
        remove_skill(r.path(), "nope").unwrap();
    }

    #[test]
    fn write_read_remove_reject_traversal_ids() {
        let r = TempDir::new("skills");
        assert!(write_skill(r.path(), "../escape", "x").unwrap_err().contains("invalid skill id"));
        assert!(read_skill(r.path(), "../escape").unwrap_err().contains("invalid skill id"));
        assert!(remove_skill(r.path(), "../escape").unwrap_err().contains("invalid skill id"));
        assert!(!r.path().parent().unwrap().join("escape").exists());
    }

    #[test]
    fn missing_ledger_is_empty() {
        let r = TempDir::new("skills");
        assert!(read_ledger_file(r.path()).is_empty());
    }

    #[test]
    fn ledger_round_trips() {
        let r = TempDir::new("skills");
        write_ledger_file(r.path(), &json!({ "alpha": "abc123456789" })).unwrap();
        assert_eq!(Value::Object(read_ledger_file(r.path())), json!({ "alpha": "abc123456789" }));
    }

    #[test]
    fn malformed_ledger_is_empty() {
        let r = TempDir::new("skills");
        fs::write(ledger_file_path(r.path()), "{ not json").unwrap();
        assert!(read_ledger_file(r.path()).is_empty());
    }

    #[test]
    fn non_object_ledger_is_empty() {
        let r = TempDir::new("skills");
        fs::write(ledger_file_path(r.path()), "[1,2,3]").unwrap();
        assert!(read_ledger_file(r.path()).is_empty());
    }

    #[test]
    fn writing_the_ledger_creates_the_root() {
        let r = TempDir::new("skills");
        let fresh = r.path().join("not-yet-created");
        write_ledger_file(&fresh, &json!({ "a": "b" })).unwrap();
        assert_eq!(Value::Object(read_ledger_file(&fresh)), json!({ "a": "b" }));
    }

    #[test]
    fn export_allowlist_accepts_the_three_agents() {
        for a in ["claude", "codex", "cursor"] {
            assert!(is_allowed_export_agent(a));
        }
    }

    #[test]
    fn export_allowlist_rejects_everything_else() {
        for a in ["Claude", "gemini", ""] {
            assert!(!is_allowed_export_agent(a));
        }
    }

    #[test]
    fn export_dest_is_prefixed() {
        assert_eq!(export_dest_dir(Path::new("/home/u"), "claude", "foo"), Path::new("/home/u/.claude/skills/frontstage-foo"));
        assert_eq!(export_dest_dir(Path::new("/home/u"), "codex", "bar"), Path::new("/home/u/.codex/skills/frontstage-bar"));
        assert_eq!(export_dest_dir(Path::new("/home/u"), "cursor", "baz"), Path::new("/home/u/.cursor/skills/frontstage-baz"));
    }

    #[test]
    fn export_copies_to_the_prefixed_dest() {
        let (r, h) = (TempDir::new("skills"), TempDir::new("home"));
        write_skill(r.path(), "my-skill", "---\nname: X\ndescription: Y\n---\nbody").unwrap();
        let dest = export_skill_to_agent(r.path(), h.path(), "my-skill", "claude").unwrap();
        assert_eq!(dest, export_dest_dir(h.path(), "claude", "my-skill"));
        assert_eq!(fs::read_to_string(dest.join("SKILL.md")).unwrap(), "---\nname: X\ndescription: Y\n---\nbody");
    }

    #[test]
    fn export_overwrites_a_prior_copy() {
        let (r, h) = (TempDir::new("skills"), TempDir::new("home"));
        write_skill(r.path(), "my-skill", "v1").unwrap();
        export_skill_to_agent(r.path(), h.path(), "my-skill", "claude").unwrap();
        write_skill(r.path(), "my-skill", "v2").unwrap();
        let dest = export_skill_to_agent(r.path(), h.path(), "my-skill", "claude").unwrap();
        assert_eq!(fs::read_to_string(dest.join("SKILL.md")).unwrap(), "v2");
    }

    #[test]
    fn export_rejects_other_agents_before_touching_the_filesystem() {
        let (r, h) = (TempDir::new("skills"), TempDir::new("home"));
        write_skill(r.path(), "my-skill", "content").unwrap();
        assert!(export_skill_to_agent(r.path(), h.path(), "my-skill", "gemini").unwrap_err().contains("invalid export agent"));
        assert!(!h.path().join(".gemini").exists());
    }

    #[test]
    fn export_rejects_a_traversal_id() {
        let (r, h) = (TempDir::new("skills"), TempDir::new("home"));
        assert!(export_skill_to_agent(r.path(), h.path(), "../escape", "claude").unwrap_err().contains("invalid skill id"));
    }

    #[test]
    fn export_rejects_a_missing_skill() {
        let (r, h) = (TempDir::new("skills"), TempDir::new("home"));
        assert!(export_skill_to_agent(r.path(), h.path(), "nonexistent", "claude").unwrap_err().contains("skill not found"));
    }

    // The vitest case pinned cpSync's options with a mock. This uses a real symlink, which is stronger.
    #[cfg(unix)]
    #[test]
    fn export_copies_symlinks_as_symlinks_without_dereferencing() {
        let (r, h, target) = (TempDir::new("skills"), TempDir::new("home"), TempDir::new("target"));
        fs::write(target.path().join("secret.txt"), "secret").unwrap();
        write_skill(r.path(), "my-skill", "content").unwrap();
        std::os::unix::fs::symlink(target.path(), r.path().join("my-skill/link")).unwrap();
        let dest = export_skill_to_agent(r.path(), h.path(), "my-skill", "claude").unwrap();
        let meta = fs::symlink_metadata(dest.join("link")).unwrap();
        assert!(meta.file_type().is_symlink());
        assert_eq!(fs::read_link(dest.join("link")).unwrap(), target.path());
    }

    #[cfg(unix)]
    #[test]
    fn export_of_a_symlinked_skill_folder_relinks_rather_than_copying_its_target() {
        let (r, h, target) = (TempDir::new("skills"), TempDir::new("home"), TempDir::new("target"));
        fs::write(target.path().join("SKILL.md"), "x").unwrap();
        std::os::unix::fs::symlink(target.path(), r.path().join("linked")).unwrap();
        let dest = export_skill_to_agent(r.path(), h.path(), "linked", "claude").unwrap();
        assert!(fs::symlink_metadata(&dest).unwrap().file_type().is_symlink());
    }

    #[cfg(unix)]
    #[test]
    fn remove_of_a_symlinked_folder_unlinks_it_and_leaves_the_target_untouched() {
        let (r, target) = (TempDir::new("skills"), TempDir::new("target"));
        fs::write(target.path().join("marker.txt"), "must-survive").unwrap();
        let link = r.path().join("linked-skill");
        std::os::unix::fs::symlink(target.path(), &link).unwrap();
        remove_skill(r.path(), "linked-skill").unwrap();
        assert!(fs::symlink_metadata(&link).is_err());
        assert_eq!(fs::read_to_string(target.path().join("marker.txt")).unwrap(), "must-survive");
    }
}
