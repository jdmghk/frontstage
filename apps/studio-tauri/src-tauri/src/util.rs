//! Small helpers shared by the command modules.

use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;

/// Runs blocking work (files, processes, HTTP) off the runtime's workers without copying the
/// borrowed IPC body. Sync commands would run on the main thread and freeze the window.
pub fn blocking<T>(f: impl FnOnce() -> T) -> T {
    tokio::task::block_in_place(f)
}

/// `path.resolve`: absolute and normalised, without touching the filesystem or following links.
pub fn resolve(p: impl AsRef<Path>) -> PathBuf {
    let p = p.as_ref();
    let joined = if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/")).join(p)
    };
    normalize(&joined)
}

pub fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::ParentDir => {
                // Popping at the root stays at the root, same as path.resolve.
                let at_root = out.parent().is_none();
                if !at_root {
                    out.pop();
                }
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

pub fn random_hex(bytes: usize) -> Result<String, String> {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).map_err(|e| format!("no system randomness: {e}"))?;
    Ok(hex(&buf))
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn base64_std(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

pub fn base64_url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// `Date.prototype.toISOString`: UTC with milliseconds. These strings sort chronologically, which
/// the project registry relies on.
pub fn iso_now() -> String {
    let d = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    iso_from_millis(d.as_millis() as i64)
}

pub fn iso_from_millis(ms: i64) -> String {
    let (secs, millis) = (ms.div_euclid(1000), ms.rem_euclid(1000));
    let (days, sod) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z", sod / 3600, sod % 3600 / 60, sod % 60)
}

/// A request header sent by the bridge. Values are percent-encoded because headers are ASCII only.
pub fn header(request: &tauri::ipc::Request<'_>, name: &str) -> Result<String, String> {
    let raw = request.headers().get(name).ok_or_else(|| format!("missing {name} header"))?;
    let raw = raw.to_str().map_err(|_| format!("bad {name} header"))?;
    percent_decode(raw).ok_or_else(|| format!("bad {name} header"))
}

pub fn header_opt(request: &tauri::ipc::Request<'_>, name: &str) -> Result<Option<String>, String> {
    if request.headers().contains_key(name) { header(request, name).map(Some) } else { Ok(None) }
}

/// The inverse of `encodeURIComponent`.
pub fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hi = (*b.get(i + 1)? as char).to_digit(16)?;
            let lo = (*b.get(i + 2)? as char).to_digit(16)?;
            out.push((hi * 16 + lo) as u8);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

pub fn raw_body<'a>(request: &'a tauri::ipc::Request<'_>) -> Result<&'a [u8], String> {
    match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => Ok(b),
        tauri::ipc::InvokeBody::Json(_) => Err("expected a raw binary body, got JSON".into()),
    }
}

/// `String(err)` for an Error, used where the Electron code surfaced that text.
pub fn tail_chars(s: &str, n: usize) -> String {
    let count = s.chars().count();
    s.chars().skip(count.saturating_sub(n)).collect()
}

#[cfg(test)]
pub mod testutil {
    //! A scripted local HTTP server. No test talks to a real provider.

    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};

    #[derive(Clone, Debug)]
    pub struct Seen {
        pub method: String,
        pub url: String,
        pub headers: Vec<(String, String)>,
        pub body: Vec<u8>,
    }

    impl Seen {
        pub fn header(&self, name: &str) -> Option<&str> {
            self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
        }
        pub fn json(&self) -> serde_json::Value {
            serde_json::from_slice(&self.body).unwrap_or(serde_json::Value::Null)
        }
    }

    pub struct Reply {
        pub status: u16,
        pub headers: Vec<(String, String)>,
        pub body: Vec<u8>,
    }

    impl Reply {
        pub fn new(status: u16, body: impl Into<Vec<u8>>) -> Self {
            Reply { status, headers: vec![], body: body.into() }
        }
        pub fn json(status: u16, v: serde_json::Value) -> Self {
            Reply::new(status, v.to_string()).with("content-type", "application/json")
        }
        pub fn with(mut self, k: &str, v: &str) -> Self {
            self.headers.push((k.into(), v.into()));
            self
        }
    }

    pub struct Mock {
        pub port: u16,
        pub seen: Arc<Mutex<Vec<Seen>>>,
        stop: Arc<AtomicBool>,
        server: Arc<tiny_http::Server>,
    }

    impl Mock {
        pub fn base(&self) -> String {
            format!("http://127.0.0.1:{}", self.port)
        }
        pub fn seen(&self) -> Vec<Seen> {
            self.seen.lock().unwrap().clone()
        }
    }

    impl Drop for Mock {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
            self.server.unblock();
        }
    }

    pub fn mock(handler: impl Fn(&Seen) -> Reply + Send + Sync + 'static) -> Mock {
        let server = Arc::new(tiny_http::Server::http("127.0.0.1:0").unwrap());
        let port = server.server_addr().to_ip().unwrap().port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let (s, sn, st) = (server.clone(), seen.clone(), stop.clone());
        std::thread::spawn(move || {
            while !st.load(Ordering::SeqCst) {
                let Ok(mut req) = s.recv() else { break };
                let mut body = Vec::new();
                let _ = req.as_reader().read_to_end(&mut body);
                let record = Seen {
                    method: req.method().to_string(),
                    url: req.url().to_string(),
                    headers: req.headers().iter().map(|h| (h.field.to_string(), h.value.to_string())).collect(),
                    body,
                };
                sn.lock().unwrap().push(record.clone());
                let r = handler(&record);
                let mut resp = tiny_http::Response::from_data(r.body).with_status_code(r.status);
                for (k, v) in &r.headers {
                    resp.add_header(tiny_http::Header::from_bytes(k.as_bytes(), v.as_bytes()).unwrap());
                }
                let _ = req.respond(resp);
            }
        });
        Mock { port, seen, stop, server }
    }

    pub fn temp_dir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("frontstage-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// Removes the directory when the test ends, pass or fail.
    pub struct TempDir(pub std::path::PathBuf);
    impl TempDir {
        pub fn new(tag: &str) -> Self {
            TempDir(temp_dir(tag))
        }
        pub fn path(&self) -> &std::path::Path {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_is_lexical_like_path_resolve() {
        assert_eq!(normalize(Path::new("/a/b/../c/./d")), PathBuf::from("/a/c/d"));
        assert_eq!(normalize(Path::new("/../..")), PathBuf::from("/"));
    }

    #[test]
    fn iso_matches_to_iso_string() {
        assert_eq!(iso_from_millis(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_from_millis(1_767_225_600_123), "2026-01-01T00:00:00.123Z");
        assert_eq!(iso_from_millis(1_709_164_800_000), "2024-02-29T00:00:00.000Z");
    }

    #[test]
    fn percent_decode_matches_encode_uri_component() {
        assert_eq!(percent_decode("a%20b%2Fc%E2%80%9C").unwrap(), "a b/c\u{201c}");
        assert!(percent_decode("%zz").is_none());
        assert!(percent_decode("%2").is_none());
    }
}
