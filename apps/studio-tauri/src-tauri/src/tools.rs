//! Where the ffmpeg and ffprobe binaries live. The only place that knows; Phase 3 replaces ffprobe
//! and packages a trimmed ffmpeg without touching any caller.

use std::path::{Path, PathBuf};

pub struct Tools {
    ffmpeg: Option<PathBuf>,
    ffprobe: Option<PathBuf>,
}

fn exe(name: &str) -> String {
    format!("{name}{}", std::env::consts::EXE_SUFFIX)
}

/// Beside the app binary (Tauri's sidecar location), then the app's Resources folder.
fn packaged(name: &str) -> Vec<PathBuf> {
    let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf)) else { return vec![] };
    vec![dir.join(exe(name)), dir.join("../Resources/bin").join(exe(name))]
}

/// The npm-installed binaries, for running from the repo. Not compiled into a release build unless
/// it's a test build.
#[cfg(any(debug_assertions, feature = "webkit-tests"))]
fn from_repo(name: &str) -> Option<PathBuf> {
    let desktop = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../desktop/node_modules");
    let candidates = match name {
        "ffmpeg" => vec![desktop.join("ffmpeg-static").join(exe("ffmpeg"))],
        _ => {
            let arch = if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" };
            let os = if cfg!(windows) { "win32" } else if cfg!(target_os = "macos") { "darwin" } else { "linux" };
            vec![desktop.join("ffprobe-static/bin").join(os).join(arch).join(exe("ffprobe"))]
        }
    };
    candidates.into_iter().find(|p| p.is_file())
}

#[cfg(not(any(debug_assertions, feature = "webkit-tests")))]
fn from_repo(_name: &str) -> Option<PathBuf> {
    None
}

fn find(name: &str) -> Option<PathBuf> {
    packaged(name).into_iter().find(|p| p.is_file()).or_else(|| from_repo(name))
}

impl Tools {
    pub fn locate() -> Self {
        Tools { ffmpeg: find("ffmpeg"), ffprobe: find("ffprobe") }
    }
    pub fn ffmpeg(&self) -> Option<PathBuf> {
        self.ffmpeg.clone()
    }
    pub fn ffprobe(&self) -> Option<PathBuf> {
        self.ffprobe.clone()
    }
    pub fn require_ffmpeg(&self) -> Result<PathBuf, String> {
        self.ffmpeg().ok_or_else(|| "ffmpeg not found beside the app".to_string())
    }
}
