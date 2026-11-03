//! studio:writeFlowPack: a folder of text and binary files (the Google Flow hand-off pack and the
//! Voice tab's dialogue export) in a directory the user chooses.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::ipc::Request;
use tauri::{AppHandle, State};

use crate::util::{blocking, raw_body};
use crate::{dialogs, shell, Ctx};

/// One path segment: no separators, reserved or control characters, never "." or "..".
pub fn safe_name(n: &str) -> bool {
    let len = n.encode_utf16().count();
    (1..=120).contains(&len)
        && n.trim() != ""
        && n != "."
        && n != ".."
        && !n.chars().any(|c| matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\u{0}'..='\u{1f}'))
}

#[derive(Deserialize)]
pub struct Pack {
    #[serde(rename = "folderName")]
    pub folder_name: String,
    #[serde(default)]
    pub files: Vec<TextFile>,
    #[serde(default)]
    pub images: Vec<ImageMeta>,
}

#[derive(Deserialize)]
pub struct TextFile {
    pub name: String,
    pub text: String,
}

#[derive(Deserialize)]
pub struct ImageMeta {
    pub name: String,
    pub size: usize,
}

/// Body layout: u32 LE metadata length, metadata JSON, then each image's bytes in order.
pub fn parse_body(body: &[u8]) -> Result<(Pack, &[u8]), String> {
    let len_bytes: [u8; 4] = body.get(..4).and_then(|b| b.try_into().ok()).ok_or("bad flow pack body")?;
    let len = u32::from_le_bytes(len_bytes) as usize;
    let meta = body.get(4..4 + len).ok_or("bad flow pack body")?;
    let pack: Pack = serde_json::from_slice(meta).map_err(|e| format!("bad flow pack metadata: {e}"))?;
    Ok((pack, &body[4 + len..]))
}

pub fn write_pack(chosen: &Path, pack: &Pack, mut images: &[u8]) -> Result<PathBuf, Value> {
    if !safe_name(&pack.folder_name) {
        return Err(json!({ "error": "invalid folder name" }));
    }
    let dir = chosen.join(&pack.folder_name);
    let fail = |e: std::io::Error| json!({ "error": e.to_string() });
    fs::create_dir_all(&dir).map_err(fail)?;
    for f in &pack.files {
        if !safe_name(&f.name) {
            return Err(json!({ "error": format!("invalid file name: {}", f.name) }));
        }
        fs::write(dir.join(&f.name), &f.text).map_err(fail)?;
    }
    for img in &pack.images {
        if !safe_name(&img.name) {
            return Err(json!({ "error": format!("invalid file name: {}", img.name) }));
        }
        if img.size > images.len() {
            return Err(json!({ "error": "bad flow pack body" }));
        }
        let (bytes, rest) = images.split_at(img.size);
        fs::write(dir.join(&img.name), bytes).map_err(fail)?;
        images = rest;
    }
    Ok(dir)
}

#[tauri::command]
pub async fn studio_write_flow_pack(request: Request<'_>, app: AppHandle, ctx: State<'_, Ctx>) -> Result<Value, String> {
    let (pack, images) = parse_body(raw_body(&request)?)?;
    let chosen = match ctx.test_picks_flow() {
        Some(p) => Some(p),
        None => dialogs::pick_folder(&app, Some(format!("Choose where to save \"{}\"", pack.folder_name))).await,
    };
    let Some(chosen) = chosen else { return Ok(json!({ "canceled": true })) };
    Ok(match blocking(|| write_pack(Path::new(&chosen), &pack, images)) {
        Ok(dir) => {
            if !cfg!(feature = "webkit-tests") {
                let _ = shell::open_path(&dir);
            }
            json!({ "path": dir.to_string_lossy() })
        }
        Err(v) => v,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::testutil::TempDir;

    fn body(meta: Value, images: &[u8]) -> Vec<u8> {
        let m = meta.to_string().into_bytes();
        let mut out = (m.len() as u32).to_le_bytes().to_vec();
        out.extend(m);
        out.extend(images);
        out
    }

    #[test]
    fn safe_name_refuses_separators_reserved_control_and_dot_names() {
        for bad in ["", " ", ".", "..", "a/b", "a\\b", "a:b", "a*b", "a?b", "a\"b", "a<b", "a>b", "a|b", "a\nb", &"x".repeat(121)] {
            assert!(!safe_name(bad), "{bad:?}");
        }
        assert!(safe_name("Scene 1 prompts.txt"));
    }

    #[test]
    fn a_pack_writes_text_and_binary_files_under_the_folder() {
        let d = TempDir::new("flow");
        let raw = body(json!({"folderName":"Pack","files":[{"name":"a.txt","text":"hi"}],"images":[{"name":"1.png","size":2},{"name":"2.png","size":1}]}), &[7, 8, 9]);
        let (pack, images) = parse_body(&raw).unwrap();
        let dir = write_pack(d.path(), &pack, images).unwrap();
        assert_eq!(fs::read_to_string(dir.join("a.txt")).unwrap(), "hi");
        assert_eq!(fs::read(dir.join("1.png")).unwrap(), [7, 8]);
        assert_eq!(fs::read(dir.join("2.png")).unwrap(), [9]);
    }

    #[test]
    fn traversal_in_a_folder_or_file_name_writes_nothing_outside() {
        let d = TempDir::new("flow");
        let chosen = d.path().join("chosen");
        fs::create_dir_all(&chosen).unwrap();
        let (p, i) = (body(json!({"folderName":"../evil"}), &[]), ());
        let _ = i;
        let (pack, images) = parse_body(&p).unwrap();
        assert_eq!(write_pack(&chosen, &pack, images).unwrap_err()["error"], "invalid folder name");
        assert!(!d.path().join("evil").exists());

        let p = body(json!({"folderName":"ok","files":[{"name":"../../evil.txt","text":"x"}]}), &[]);
        let (pack, images) = parse_body(&p).unwrap();
        assert!(write_pack(&chosen, &pack, images).unwrap_err()["error"].as_str().unwrap().contains("invalid file name"));
        assert!(!d.path().join("evil.txt").exists());
    }

    #[test]
    fn truncated_bodies_are_errors_not_panics() {
        assert!(parse_body(&[1, 0]).is_err());
        assert!(parse_body(&[200, 0, 0, 0, 1]).is_err());
        let p = body(json!({"folderName":"ok","images":[{"name":"a.png","size":5}]}), &[1]);
        let (pack, images) = parse_body(&p).unwrap();
        let d = TempDir::new("flow");
        assert!(write_pack(d.path(), &pack, images).is_err());
    }
}
