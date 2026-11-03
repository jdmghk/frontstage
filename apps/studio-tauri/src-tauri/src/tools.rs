//! Where the ffmpeg binary lives. The only place that knows.
//!
//! A packaged app has it beside the app binary, where Tauri puts `bundle.externalBin`:
//! `Frontstage.app/Contents/MacOS/ffmpeg`, or `ffmpeg.exe` beside `Frontstage.exe`. PATH is never searched.
//! Debug and test builds fall back to the repo's copies. A shipped build has no fallback.

use std::path::{Path, PathBuf};
use std::process::Command;

pub struct Tools {
    ffmpeg: Option<PathBuf>,
}

fn exe(name: &str) -> String {
    format!("{name}{}", std::env::consts::EXE_SUFFIX)
}

fn beside(app_binary: &Path) -> Option<PathBuf> {
    app_binary.parent().map(|dir| dir.join(exe("ffmpeg"))).filter(|p| p.is_file())
}

/// `FRONTSTAGE_TEST_FFMPEG` picks the binary under test, so `cargo test` can run against the trimmed
/// build. Otherwise the npm-installed stock binary. Not compiled into a shipped build.
#[cfg(any(debug_assertions, feature = "webkit-tests"))]
fn from_repo() -> Option<PathBuf> {
    std::env::var_os("FRONTSTAGE_TEST_FFMPEG").map(PathBuf::from).filter(|p| p.is_file()).or_else(stock)
}

#[cfg(not(any(debug_assertions, feature = "webkit-tests")))]
fn from_repo() -> Option<PathBuf> {
    None
}

#[cfg(any(debug_assertions, feature = "webkit-tests"))]
fn stock() -> Option<PathBuf> {
    Some(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../desktop/node_modules/ffmpeg-static").join(exe("ffmpeg"))).filter(|p| p.is_file())
}

/// The stock ffmpeg, for tests only: makes test clips (lavfi, x265, libaom) and checks outputs, none of
/// which the app itself needs or the trimmed build has. App behaviour under test uses `Tools::locate`.
#[cfg(test)]
pub fn test_generator() -> Option<PathBuf> {
    stock()
}

impl Tools {
    pub fn locate() -> Self {
        let packaged = std::env::current_exe().ok().and_then(|e| beside(&e));
        Tools { ffmpeg: packaged.or_else(from_repo) }
    }
    pub fn ffmpeg(&self) -> Option<PathBuf> {
        self.ffmpeg.clone()
    }
    pub fn require_ffmpeg(&self) -> Result<PathBuf, String> {
        self.ffmpeg().ok_or_else(|| "ffmpeg not found beside the app".to_string())
    }
}

/// A `Command` for the ffmpeg binary. On Windows a console program started from a GUI app would open a
/// console window for every run.
pub fn command(bin: &Path) -> Command {
    #[allow(unused_mut)]
    let mut c = Command::new(bin);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::testutil::TempDir;

    #[test]
    fn the_packaged_binary_is_found_beside_the_app_binary_and_nowhere_else() {
        let d = TempDir::new("tools");
        let macos = d.path().join("Frontstage.app/Contents/MacOS");
        std::fs::create_dir_all(&macos).unwrap();
        let app = macos.join("frontstage");
        assert_eq!(beside(&app), None, "nothing there yet, and PATH must not count");
        std::fs::write(macos.join(exe("ffmpeg")), "").unwrap();
        assert_eq!(beside(&app), Some(macos.join(exe("ffmpeg"))));
    }

    #[test]
    fn a_folder_named_ffmpeg_is_not_a_binary() {
        let d = TempDir::new("tools-dir");
        std::fs::create_dir_all(d.path().join(exe("ffmpeg"))).unwrap();
        assert_eq!(beside(&d.path().join("frontstage")), None);
    }
}
