//! Opening things with the OS, by spawning its own opener. Saves a plugin and its dependencies.

use std::path::Path;
use std::process::{Command, Stdio};

fn run(mut c: Command) -> Result<(), String> {
    // Automated runs must not open Finder or a browser in front of the user.
    if cfg!(feature = "webkit-tests") {
        return Ok(());
    }
    c.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    c.spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Opens a folder or file.
pub fn open_path(p: &Path) -> Result<(), String> {
    if cfg!(target_os = "macos") {
        let mut c = Command::new("/usr/bin/open");
        c.arg("--").arg(p);
        run(c)
    } else if cfg!(windows) {
        let mut c = Command::new("explorer");
        c.arg(p);
        run(c)
    } else {
        let mut c = Command::new("xdg-open");
        c.arg(p);
        run(c)
    }
}

/// Shows a file selected in Finder or Explorer.
pub fn reveal(p: &Path) -> Result<(), String> {
    if cfg!(target_os = "macos") {
        let mut c = Command::new("/usr/bin/open");
        c.arg("-R").arg("--").arg(p);
        run(c)
    } else if cfg!(windows) {
        let mut arg = std::ffi::OsString::from("/select,");
        arg.push(p);
        let mut c = Command::new("explorer");
        c.arg(arg);
        run(c)
    } else {
        open_path(p.parent().unwrap_or(p))
    }
}

/// Only http(s), so a page can't hand the OS a file:// or app-scheme URL.
pub fn is_openable_url(url: &url::Url) -> bool {
    matches!(url.scheme(), "http" | "https")
}

pub fn open_url(url: &str) -> Result<(), String> {
    let parsed = url::Url::parse(url).map_err(|e| e.to_string())?;
    if !is_openable_url(&parsed) {
        return Err(format!("refusing to open {}", parsed.scheme()));
    }
    if cfg!(target_os = "macos") {
        let mut c = Command::new("/usr/bin/open");
        c.arg(parsed.as_str());
        run(c)
    } else if cfg!(windows) {
        let mut c = Command::new("rundll32");
        c.args(["url.dll,FileProtocolHandler", parsed.as_str()]);
        run(c)
    } else {
        let mut c = Command::new("xdg-open");
        c.arg(parsed.as_str());
        run(c)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_http_and_https_urls_can_be_opened() {
        for bad in ["file:///etc/passwd", "javascript:alert(1)", "tauri://localhost/", "smb://x/y", "not a url"] {
            assert!(open_url(bad).is_err(), "{bad}");
        }
        assert!(is_openable_url(&url::Url::parse("https://github.com/x").unwrap()));
    }
}
