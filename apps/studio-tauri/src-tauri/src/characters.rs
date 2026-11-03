//! characters:* channels over ~/.frontstage/characters/<id>/<file>.

use std::fs;
use std::path::{Path, PathBuf};

use tauri::ipc::{Request, Response};
use tauri::State;

use crate::util::{blocking, header, raw_body};
use crate::Ctx;

const MAX_FILE_BYTES: usize = 50 * 1024 * 1024;

pub fn characters_root_path(home: &Path) -> PathBuf {
    home.join(".frontstage").join("characters")
}

pub fn is_valid_character_id(id: &str) -> bool {
    (1..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

pub fn is_valid_character_file(name: &str) -> bool {
    (1..=128).contains(&name.len()) && name != "." && name != ".." && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'.' || b == b'-')
}

fn file_path(root: &Path, id: &str, name: Option<&str>) -> Result<PathBuf, String> {
    if !is_valid_character_id(id) {
        return Err(format!("invalid character id: {id}"));
    }
    match name {
        Some(n) if !is_valid_character_file(n) => Err(format!("invalid file name: {n}")),
        Some(n) => Ok(root.join(id).join(n)),
        None => Ok(root.join(id)),
    }
}

pub fn list_character_ids(root: &Path) -> Vec<String> {
    let Ok(rd) = fs::read_dir(root) else { return vec![] };
    let mut ids: Vec<String> = rd
        .filter_map(Result::ok)
        .filter(|d| d.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter_map(|d| d.file_name().into_string().ok())
        .filter(|n| is_valid_character_id(n))
        .collect();
    ids.sort();
    ids
}

pub fn read_character_file(root: &Path, id: &str, name: &str) -> Result<Option<Vec<u8>>, String> {
    match fs::read(file_path(root, id, Some(name))?) {
        Ok(b) => Ok(Some(b)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

pub fn write_character_file(root: &Path, id: &str, name: &str, bytes: &[u8]) -> Result<(), String> {
    let f = file_path(root, id, Some(name))?;
    if bytes.len() > MAX_FILE_BYTES {
        return Err(format!("file too large: {name}"));
    }
    fs::create_dir_all(f.parent().expect("has a parent")).map_err(|e| e.to_string())?;
    fs::write(f, bytes).map_err(|e| e.to_string())
}

pub fn remove_character(root: &Path, id: &str) -> Result<(), String> {
    match fs::remove_dir_all(file_path(root, id, None)?) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

#[tauri::command]
pub async fn characters_list_ids(ctx: State<'_, Ctx>) -> Result<Vec<String>, String> {
    Ok(blocking(|| list_character_ids(&characters_root_path(&ctx.home))))
}

/// Raw bytes, or JSON null when the file doesn't exist.
#[tauri::command]
pub async fn characters_read_file(id: String, name: String, ctx: State<'_, Ctx>) -> Result<Response, String> {
    Ok(match blocking(|| read_character_file(&characters_root_path(&ctx.home), &id, &name))? {
        Some(b) => Response::new(b),
        None => Response::new("null".to_string()),
    })
}

#[tauri::command]
pub async fn characters_write_file(request: Request<'_>, ctx: State<'_, Ctx>) -> Result<(), String> {
    let (id, name) = (header(&request, "x-id")?, header(&request, "x-name")?);
    let body = raw_body(&request)?;
    blocking(|| write_character_file(&characters_root_path(&ctx.home), &id, &name, body))
}

#[tauri::command]
pub async fn characters_remove(id: String, ctx: State<'_, Ctx>) -> Result<(), String> {
    blocking(|| remove_character(&characters_root_path(&ctx.home), &id))
}

#[cfg(test)]
mod tests {
    //! Port of apps/desktop/test/characters-fs.test.ts.
    use super::*;
    use crate::util::testutil::TempDir;

    #[test]
    fn root_lives_under_home_frontstage_characters() {
        assert_eq!(characters_root_path(Path::new("/home/u")), Path::new("/home/u/.frontstage/characters"));
    }

    #[test]
    fn rejects_traversal_in_ids_and_file_names() {
        let root = TempDir::new("chars");
        for bad in ["", ".", "..", "a/b", "a\\b", "../x"] {
            assert!(!is_valid_character_id(bad), "{bad}");
        }
        assert!(!is_valid_character_file(".."));
        assert!(!is_valid_character_file("../character.json"));
        assert!(write_character_file(root.path(), "../escape", "x.png", &[1]).unwrap_err().contains("invalid character id"));
        assert!(read_character_file(root.path(), "kai", "../../etc").unwrap_err().contains("invalid file name"));
        assert!(!root.path().parent().unwrap().join("escape").exists());
    }

    #[test]
    fn write_list_read_remove_round_trip() {
        let root = TempDir::new("chars");
        write_character_file(root.path(), "kai", "character.json", b"{}").unwrap();
        write_character_file(root.path(), "kai", "ref-1.png", &[137, 80]).unwrap();
        fs::create_dir_all(root.path().join("not valid!")).unwrap();
        assert_eq!(list_character_ids(root.path()), ["kai"]);
        assert_eq!(read_character_file(root.path(), "kai", "ref-1.png").unwrap().unwrap(), [137, 80]);
        assert_eq!(read_character_file(root.path(), "kai", "missing.png").unwrap(), None);
        remove_character(root.path(), "kai").unwrap();
        assert!(list_character_ids(root.path()).is_empty());
    }

    #[test]
    fn a_missing_root_lists_nothing() {
        let root = TempDir::new("chars");
        assert!(list_character_ids(&root.path().join("nope")).is_empty());
    }

    #[test]
    fn an_oversized_file_is_refused() {
        let root = TempDir::new("chars");
        let big = vec![0u8; MAX_FILE_BYTES + 1];
        assert!(write_character_file(root.path(), "kai", "big.png", &big).unwrap_err().contains("file too large"));
    }
}
