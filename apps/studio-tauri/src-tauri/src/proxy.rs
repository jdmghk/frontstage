//! H.264 conversion for clips this webview can't decode. The project keeps pointing at the original;
//! the proxy sits in the app's cache, named from the source's content, and is only what playback and
//! export read. Deleting the cache loses nothing.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Condvar, Mutex};

use serde_json::json;
use sha2::{Digest, Sha256};
use tauri::ipc::{Request, Response};
use tauri::{AppHandle, Emitter, State};

use crate::project::{assert_inside, Authorized};
use crate::tools;
use crate::util::{blocking, header, hex, raw_body, tail_chars};
use crate::Ctx;

const SAMPLE: u64 = 4 * 1024 * 1024;

/// Size + first and last 4 MB: cheap on a many-GB file, and both ends hold boxes that differ between
/// any two encodes. The same file gets the same key from a path or from bytes.
pub fn key_of_bytes(bytes: &[u8]) -> String {
    let n = bytes.len() as u64;
    let mut h = Sha256::new();
    h.update(n.to_le_bytes());
    h.update(&bytes[..n.min(SAMPLE) as usize]);
    if n > SAMPLE {
        h.update(&bytes[(n - SAMPLE.min(n - SAMPLE)) as usize..]);
    }
    hex(&h.finalize())
}

pub fn key_of_file(path: &Path) -> std::io::Result<String> {
    let mut f = File::open(path)?;
    let n = f.metadata()?.len();
    let mut h = Sha256::new();
    h.update(n.to_le_bytes());
    let mut head = vec![0u8; n.min(SAMPLE) as usize];
    f.read_exact(&mut head)?;
    h.update(&head);
    if n > SAMPLE {
        let tail_len = SAMPLE.min(n - SAMPLE);
        f.seek(SeekFrom::Start(n - tail_len))?;
        let mut tail = vec![0u8; tail_len as usize];
        f.read_exact(&mut tail)?;
        h.update(&tail);
    }
    Ok(hex(&h.finalize()))
}

pub fn is_valid_key(key: &str) -> bool {
    key.len() == 64 && key.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// From `ffmpeg -i`'s banner: whether the stream is PQ or HLG, and its duration.
#[derive(Debug, PartialEq, Default)]
pub struct SourceInfo {
    pub hdr: bool,
    pub duration_sec: Option<f64>,
}

pub fn parse_banner(stderr: &str) -> SourceInfo {
    // By indentation: a file's own title or comment can contain this text too.
    let video = stderr.lines().find(|l| l.starts_with("  Stream #") && l.contains("Video:")).unwrap_or("");
    let hdr = video.contains("smpte2084") || video.contains("arib-std-b67");
    let duration_sec = stderr.lines().find_map(|l| l.trim().strip_prefix("Duration: ")).and_then(|r| r.split(',').next()).and_then(parse_clock);
    SourceInfo { hdr, duration_sec }
}

fn parse_clock(s: &str) -> Option<f64> {
    let mut parts = s.split(':');
    let (h, m, sec) = (parts.next()?.parse::<f64>().ok()?, parts.next()?.parse::<f64>().ok()?, parts.next()?.parse::<f64>().ok()?);
    Some(h * 3600.0 + m * 60.0 + sec)
}

/// Near-transparent and fast enough to wait for; export renders from this, so quality matters more
/// than size. x264 needs even dimensions, so odd sources lose their last row or column. Timestamps
/// pass through, keeping variable frame rates and the clip's duration. SDR keeps the source's colour
/// tags, which the engine reads; only tone-mapped HDR becomes BT.709.
pub fn proxy_args(input: &str, output: &str, hdr: bool) -> Vec<String> {
    let even = "crop=trunc(iw/2)*2:trunc(ih/2)*2";
    let filter = if hdr {
        format!("{even},zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p")
    } else {
        format!("{even},format=yuv420p")
    };
    let mut a: Vec<String> = ["-y", "-hide_banner", "-nostats", "-progress", "pipe:1", "-i", input, "-map", "0:v:0", "-map", "0:a:0?", "-vf"].map(String::from).to_vec();
    a.push(filter);
    a.extend(["-fps_mode", "passthrough", "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-profile:v", "high"].map(String::from));
    if hdr {
        a.extend(["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"].map(String::from));
    }
    a.extend(["-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart", output].map(String::from));
    a
}

enum Flight {
    Running,
    Done(Result<(), String>),
}

/// One conversion per source at a time, and one in total: this Mac has two cores.
#[derive(Default)]
pub struct Proxies {
    flights: Mutex<HashMap<String, Arc<(Mutex<Flight>, Condvar)>>>,
    gate: Mutex<()>,
}

pub fn proxy_path(cache: &Path, key: &str) -> PathBuf {
    cache.join("proxies").join(format!("{key}.mp4"))
}

impl Proxies {
    /// Returns when the proxy exists, however many callers asked for it.
    pub fn ensure(&self, bin: &Path, cache: &Path, input: &Path, key: &str, progress: &(dyn Fn(f64) + Send + Sync)) -> Result<(), String> {
        let out = proxy_path(cache, key);
        if out.is_file() {
            return Ok(());
        }
        let (flight, leader) = {
            let mut flights = self.flights.lock().unwrap();
            match flights.get(key) {
                Some(f) => (f.clone(), false),
                None => {
                    let f = Arc::new((Mutex::new(Flight::Running), Condvar::new()));
                    flights.insert(key.to_string(), f.clone());
                    (f, true)
                }
            }
        };
        if !leader {
            let (lock, cv) = &*flight;
            let mut st = lock.lock().unwrap();
            while matches!(*st, Flight::Running) {
                st = cv.wait(st).unwrap();
            }
            return match &*st {
                Flight::Done(r) => r.clone(),
                Flight::Running => unreachable!(),
            };
        }
        let result = {
            let _one_at_a_time = self.gate.lock().unwrap();
            convert(bin, input, &out, progress)
        };
        self.flights.lock().unwrap().remove(key);
        let (lock, cv) = &*flight;
        *lock.lock().unwrap() = Flight::Done(result.clone());
        cv.notify_all();
        result
    }
}

fn convert(bin: &Path, input: &Path, out: &Path, progress: &(dyn Fn(f64) + Send + Sync)) -> Result<(), String> {
    let dir = out.parent().expect("has a parent");
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let input_str = input.to_string_lossy();
    let banner = tools::command(bin).args(["-hide_banner", "-i", input_str.as_ref()]).stdin(Stdio::null()).output().map_err(|e| format!("ffmpeg spawn error: {e}"))?;
    let info = parse_banner(&String::from_utf8_lossy(&banner.stderr));

    let part = dir.join(format!("{}.part.mp4", out.file_stem().and_then(|s| s.to_str()).unwrap_or("proxy")));
    let args = proxy_args(&input_str, &part.to_string_lossy(), info.hdr);
    let mut child = tools::command(bin).args(&args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| format!("ffmpeg spawn error: {e}"))?;
    let mut stderr_pipe = child.stderr.take();
    let stderr_thread = std::thread::spawn(move || {
        let mut s = Vec::new();
        if let Some(p) = stderr_pipe.as_mut() {
            let _ = p.read_to_end(&mut s);
        }
        s
    });
    if let Some(stdout) = child.stdout.take() {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let (Some(us), Some(total)) = (line.strip_prefix("out_time_us=").and_then(|v| v.parse::<f64>().ok()), info.duration_sec) {
                if total > 0.0 {
                    progress((us / 1_000_000.0 / total).clamp(0.0, 1.0));
                }
            }
        }
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    let stderr = stderr_thread.join().unwrap_or_default();
    if !status.success() {
        let _ = fs::remove_file(&part);
        return Err(format!("ffmpeg exited with code {}. {}", status.code().unwrap_or(-1), tail_chars(&String::from_utf8_lossy(&stderr), 500)));
    }
    fs::rename(&part, out).map_err(|e| {
        let _ = fs::remove_file(&part);
        e.to_string()
    })
}

/// The file a project-relative clip lives at, after the usual authorisation.
pub fn source_in_project(auth: &Authorized, dir: &str, rel: &str) -> Result<PathBuf, String> {
    auth.check(dir)?;
    let f = assert_inside(dir, rel)?;
    if !f.is_file() {
        return Err(format!("media not found: {rel}"));
    }
    Ok(f)
}

/// By key only, which can't name anything outside the cache folder.
pub fn read_proxy(cache: &Path, key: &str) -> Result<Vec<u8>, String> {
    if !is_valid_key(key) {
        return Err("invalid proxy key".into());
    }
    fs::read(proxy_path(cache, key)).map_err(|e| e.to_string())
}

fn emit_progress(app: &AppHandle, key: &str, fraction: f64) {
    let _ = app.emit_to("main", "media:proxy-progress", json!({ "key": key, "fraction": fraction }));
}

#[tauri::command]
pub async fn media_proxy_ensure_path(dir: String, rel: String, app: AppHandle, ctx: State<'_, Ctx>) -> Result<String, String> {
    let bin = ctx.tools.require_ffmpeg()?;
    blocking(|| {
        let src = source_in_project(&ctx.auth, &dir, &rel)?;
        let key = key_of_file(&src).map_err(|e| e.to_string())?;
        let k = key.clone();
        ctx.proxies.ensure(&bin, &ctx.cache, &src, &key, &move |f| emit_progress(&app, &k, f))?;
        Ok(key)
    })
}

/// A clip that isn't saved into a project yet is only in the renderer's memory. It's written to a
/// temp file for ffmpeg and removed afterwards. Same key as `key_of_file` once saved.
#[tauri::command]
pub async fn media_proxy_ensure_bytes(request: Request<'_>, app: AppHandle, ctx: State<'_, Ctx>) -> Result<String, String> {
    let bin = ctx.tools.require_ffmpeg()?;
    let ext = header(&request, "x-ext")?;
    if !ext.bytes().all(|b| b.is_ascii_alphanumeric()) || ext.is_empty() || ext.len() > 8 {
        return Err("invalid extension".into());
    }
    let body = raw_body(&request)?;
    blocking(|| {
        let key = key_of_bytes(body);
        if proxy_path(&ctx.cache, &key).is_file() {
            return Ok(key);
        }
        let tmp = std::env::temp_dir().join(format!("frontstage-proxy-src-{}-{key}.{ext}", std::process::id()));
        let written = File::create(&tmp).and_then(|mut f| f.write_all(body));
        let k = key.clone();
        let result = written.map_err(|e| e.to_string()).and_then(|()| ctx.proxies.ensure(&bin, &ctx.cache, &tmp, &key, &move |f| emit_progress(&app, &k, f)));
        let _ = fs::remove_file(&tmp);
        result.map(|()| key)
    })
}

#[tauri::command]
pub async fn media_proxy_read(key: String, ctx: State<'_, Ctx>) -> Result<Response, String> {
    blocking(|| read_proxy(&ctx.cache, &key)).map(Response::new)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::testutil::TempDir;
    use std::process::Command;

    #[test]
    fn key_is_the_same_from_bytes_and_from_a_file_at_every_size_class() {
        let d = TempDir::new("proxy-key");
        for size in [0usize, 1, 1024, SAMPLE as usize, SAMPLE as usize + 1, SAMPLE as usize * 2, SAMPLE as usize * 3] {
            let bytes: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();
            let f = d.path().join("f.bin");
            fs::write(&f, &bytes).unwrap();
            assert_eq!(key_of_bytes(&bytes), key_of_file(&f).unwrap(), "size {size}");
        }
    }

    #[test]
    fn different_content_gets_a_different_key() {
        assert_ne!(key_of_bytes(b"aaaa"), key_of_bytes(b"aaab"));
        assert_ne!(key_of_bytes(b"aaaa"), key_of_bytes(b"aaaaa"));
    }

    #[test]
    fn reading_a_proxy_refuses_anything_but_a_key() {
        let d = TempDir::new("proxy-read");
        fs::write(d.path().join("secret.mp4"), "x").unwrap();
        for bad in ["", "../secret", "../../etc/passwd", "secret", &"g".repeat(64), &"A".repeat(64), &format!("../{}", "a".repeat(61))] {
            assert_eq!(read_proxy(d.path(), bad).unwrap_err(), "invalid proxy key", "{bad}");
        }
    }

    #[test]
    fn a_project_source_needs_authorization_and_containment() {
        let d = TempDir::new("proxy-src");
        let a = Authorized::default();
        let dir = d.path().to_str().unwrap();
        fs::write(d.path().join("a.mov"), "x").unwrap();
        assert_eq!(source_in_project(&a, dir, "a.mov").unwrap_err(), "unauthorized project dir");
        a.add(d.path());
        assert_eq!(source_in_project(&a, dir, "a.mov").unwrap(), resolve_for(d.path(), "a.mov"));
        assert!(source_in_project(&a, dir, "../a.mov").unwrap_err().contains("path escapes"));
        assert!(source_in_project(&a, dir, "b.mov").unwrap_err().contains("media not found"));
    }

    fn resolve_for(dir: &Path, f: &str) -> PathBuf {
        crate::util::resolve(dir).join(f)
    }

    #[test]
    fn the_banner_gives_hdr_and_duration() {
        let hdr = "Input #0, mov\n  Duration: 00:01:02.50, start: 0.000000, bitrate: 100 kb/s\n  Stream #0:0(und): Video: hevc (Main 10) (hvc1), yuv420p10le(tv, bt2020nc/bt2020/smpte2084), 640x360\n";
        assert_eq!(parse_banner(hdr), SourceInfo { hdr: true, duration_sec: Some(62.5) });
        let hlg = "  Stream #0:0: Video: h264 (High 10), yuv420p10le(tv, bt2020nc/bt2020/arib-std-b67), 640x360\n";
        assert!(parse_banner(hlg).hdr);
        let spoofed = "  Metadata:\n    comment         : Stream #0:0: Video: smpte2084\n  Stream #0:0: Video: h264, yuv420p(tv, bt709), 640x360\n";
        assert!(!parse_banner(spoofed).hdr);
        let sdr = "  Duration: N/A, bitrate: N/A\n  Stream #0:0: Video: h264, yuv420p(tv, bt709), 640x360\n";
        assert_eq!(parse_banner(sdr), SourceInfo { hdr: false, duration_sec: None });
    }

    #[test]
    fn arguments_make_8_bit_420_h264_with_aac_when_there_is_audio() {
        let a = proxy_args("/in.mov", "/out.mp4", false).join(" ");
        assert!(a.contains("-map 0:v:0 -map 0:a:0?"));
        assert!(a.contains("format=yuv420p"));
        assert!(a.contains("-c:v libx264"));
        assert!(a.contains("-c:a aac"));
        assert!(!a.contains("tonemap"));
        assert!(proxy_args("/in.mov", "/out.mp4", true).join(" ").contains("tonemap=hable"));
    }

    fn ffmpeg() -> Option<PathBuf> {
        crate::tools::Tools::locate().ffmpeg()
    }

    // Clips come from the stock ffmpeg (lavfi, 10-bit x264); the trimmed one only has to convert them.
    fn make_clip(out: &Path, extra: &[&str]) {
        let gen = crate::tools::test_generator().expect("stock ffmpeg");
        let st = Command::new(gen)
            .args(["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=64x48:rate=10:duration=1", "-f", "lavfi", "-i", "sine=frequency=440:duration=1"])
            .args(extra)
            .arg(out)
            .stdout(Stdio::null())
            .status()
            .unwrap();
        assert!(st.success());
    }

    #[test]
    fn a_10_bit_clip_becomes_8_bit_h264_with_audio_and_the_source_is_untouched() {
        let (Some(bin), Some(gen)) = (ffmpeg(), crate::tools::test_generator()) else {
            eprintln!("SKIPPED: no ffmpeg");
            return;
        };
        let d = TempDir::new("proxy-real");
        let src = d.path().join("in.mp4");
        make_clip(&src, &["-c:v", "libx264", "-profile:v", "high10", "-pix_fmt", "yuv420p10le", "-c:a", "aac"]);
        let before = fs::read(&src).unwrap();
        let cache = d.path().join("cache");
        let key = key_of_file(&src).unwrap();
        let seen = Arc::new(Mutex::new(vec![]));
        let s2 = seen.clone();
        Proxies::default().ensure(&bin, &cache, &src, &key, &move |f| s2.lock().unwrap().push(f)).unwrap();
        assert_eq!(fs::read(&src).unwrap(), before);
        let out = proxy_path(&cache, &key);
        let info = Command::new(&gen).args(["-hide_banner", "-i", out.to_str().unwrap()]).output().unwrap();
        let text = String::from_utf8_lossy(&info.stderr);
        assert!(text.contains("Video: h264") && text.contains("yuv420p(") && text.contains("Audio: aac"), "{text}");
        assert!(!text.contains("yuv420p10le"), "{text}");
        assert!(seen.lock().unwrap().iter().all(|f| (0.0..=1.0).contains(f)));
        assert!(!cache.join("proxies").join(format!("{key}.part.mp4")).exists());
    }

    #[test]
    fn a_second_call_reuses_the_proxy_and_concurrent_calls_convert_once() {
        let (Some(bin), Some(_)) = (ffmpeg(), crate::tools::test_generator()) else {
            eprintln!("SKIPPED: no ffmpeg");
            return;
        };
        let d = TempDir::new("proxy-once");
        let src = d.path().join("in.mp4");
        make_clip(&src, &["-c:v", "libx264", "-pix_fmt", "yuv444p", "-c:a", "aac"]);
        let cache = d.path().join("cache");
        let key = key_of_file(&src).unwrap();
        let p = Proxies::default();
        std::thread::scope(|s| {
            for _ in 0..3 {
                s.spawn(|| p.ensure(&bin, &cache, &src, &key, &|_| {}).unwrap());
            }
        });
        let out = proxy_path(&cache, &key);
        let first = fs::metadata(&out).unwrap().modified().unwrap();
        p.ensure(Path::new("/definitely/not/ffmpeg"), &cache, &src, &key, &|_| {}).unwrap();
        assert_eq!(fs::metadata(&out).unwrap().modified().unwrap(), first);
    }

    #[test]
    fn a_failed_conversion_reports_ffmpegs_error_and_leaves_nothing_in_the_cache() {
        let Some(bin) = ffmpeg() else {
            eprintln!("SKIPPED: no ffmpeg");
            return;
        };
        let d = TempDir::new("proxy-bad");
        let src = d.path().join("in.mp4");
        fs::write(&src, "not a video").unwrap();
        let cache = d.path().join("cache");
        let e = Proxies::default().ensure(&bin, &cache, &src, "abc", &|_| {}).unwrap_err();
        assert!(e.starts_with("ffmpeg exited with code"), "{e}");
        assert_eq!(fs::read_dir(cache.join("proxies")).unwrap().count(), 0);
    }
}
