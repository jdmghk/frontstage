//! media:* channels: audio extraction, timecode reads, path and URL imports, .cube reads.

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::ipc::{Request, Response};
use tauri::State;

use crate::net::{self, Net};
use crate::project::{assert_inside, Authorized};
use crate::tools;
use crate::util::{blocking, raw_body, resolve, tail_chars};
use crate::Ctx;

// Keep in sync with packages/ai's IMPORT_EXT_TO_TYPE.
const IMPORT_ALLOWED_EXTENSIONS: [&str; 15] = ["mp4", "mov", "mp3", "wav", "aac", "m4a", "aiff", "aifc", "flac", "png", "jpg", "jpeg", "tiff", "heic", "srt"];
const IMPORT_VTT: &str = "vtt";
const IMPORT_MAX_BYTES: u64 = 5 * 1024 * 1024 * 1024;
const IMPORT_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const IMPORT_MAX_SCAN_DEPTH: usize = 8;
const IMPORT_MAX_SCAN_FILES: usize = 500;
const LUT_MAX_BYTES: u64 = 64 * 1024 * 1024;

pub fn import_ext(p: &str) -> String {
    Path::new(p).extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase()
}

fn is_allowed_ext(ext: &str) -> bool {
    IMPORT_ALLOWED_EXTENSIONS.contains(&ext) || ext == IMPORT_VTT
}

// ── Audio extraction ────────────────────────────────────────────────────────

fn audio_args(input: &str) -> Vec<String> {
    ["-i", input, "-vn", "-ac", "1", "-ar", "16000", "-f", "wav", "pipe:1"].map(String::from).to_vec()
}

/// Mono 16 kHz PCM16 WAV. stdin is fed from a thread so a large input can't deadlock against the
/// stdout read.
pub fn extract_audio(bin: &Path, input: Option<&str>, bytes: Option<&[u8]>) -> Result<Vec<u8>, String> {
    if input.is_some() == bytes.is_some() {
        return Err("media:extractAudio requires exactly one of path or bytes".into());
    }
    let args = audio_args(input.unwrap_or("pipe:0"));
    let mut child = tools::command(bin).args(&args).stdin(if bytes.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| format!("ffmpeg spawn error: {e}"))?;
    let mut stdin = child.stdin.take();
    let mut stderr_pipe = child.stderr.take();
    let stderr_thread = std::thread::spawn(move || {
        let mut s = Vec::new();
        if let Some(p) = stderr_pipe.as_mut() {
            let _ = p.read_to_end(&mut s);
        }
        s
    });
    let mut wav = Vec::new();
    std::thread::scope(|scope| {
        if let (Some(mut pipe), Some(b)) = (stdin.take(), bytes) {
            // EPIPE just means ffmpeg finished before reading everything.
            scope.spawn(move || {
                let _ = pipe.write_all(b);
            });
        }
        if let Some(mut out) = child.stdout.take() {
            let _ = out.read_to_end(&mut wav);
        }
    });
    let status = child.wait().map_err(|e| e.to_string())?;
    let stderr = stderr_thread.join().unwrap_or_default();
    if !status.success() {
        return Err(format!("ffmpeg exited with code {}. stderr: {}", status.code().unwrap_or(-1), tail_chars(&String::from_utf8_lossy(&stderr), 500)));
    }
    Ok(wav)
}

#[tauri::command]
pub async fn media_extract_audio_path(path: String, ctx: State<'_, Ctx>) -> Result<Response, String> {
    let bin = ctx.tools.require_ffmpeg()?;
    blocking(|| extract_audio(&bin, Some(&path), None)).map(Response::new)
}

#[tauri::command]
pub async fn media_extract_audio_bytes(request: Request<'_>, ctx: State<'_, Ctx>) -> Result<Response, String> {
    let bin = ctx.tools.require_ffmpeg()?;
    let body = raw_body(&request)?;
    blocking(|| extract_audio(&bin, None, Some(body))).map(Response::new)
}

// ── Timecode ────────────────────────────────────────────────────────────────

#[derive(Serialize, Debug, PartialEq, Clone)]
pub struct TimecodeProbe {
    pub tag: String,
    pub fps: f64,
}

/// A stream line's "29.97 fps" field. ffmpeg prints two decimals, and "1k" for 1000. The renderer's
/// parseTimecodeTag only uses this rounded to a whole number.
fn banner_fps(stream_line: &str) -> Option<f64> {
    let value = stream_line.split(", ").find_map(|field| field.trim().strip_suffix(" fps"))?;
    let fps = match value.strip_suffix('k') {
        Some(thousands) => thousands.parse::<f64>().ok()? * 1000.0,
        None => value.parse::<f64>().ok()?,
    };
    (fps.is_finite() && fps > 0.0).then_some(fps)
}

/// From the stderr of `ffmpeg -i`. The first stream with a timecode tag gives the tag and, if it's a
/// video stream, the rate. A tmcd track no video track links to prints no rate, so the first video
/// stream gives it.
///
/// Indentation is what separates a stream's metadata from the file's (4 spaces). It's 6 in ffmpeg 6 and
/// 8 in ffmpeg 7. ffmpeg starts a line inside a multi-line value with ": ", so a value can't pose as a key.
pub fn parse_timecode_banner(stderr: &str) -> Option<TimecodeProbe> {
    let mut tagged: Option<(String, Option<f64>)> = None;
    let mut first_video_fps = None;
    let mut seen_video = false;
    let mut current_fps = None;
    let mut in_stream = false;
    for line in stderr.lines() {
        if line.starts_with("Output #") {
            break;
        }
        if line.starts_with("  Stream #") {
            in_stream = true;
            current_fps = banner_fps(line);
            if line.contains(": Video: ") && !seen_video {
                seen_video = true;
                first_video_fps = current_fps;
            }
        } else if in_stream && tagged.is_none() {
            if !line.starts_with("      ") {
                continue;
            }
            if let Some((key, value)) = line.split_once(':') {
                if key.trim() == "timecode" {
                    tagged = Some((value.trim().to_string(), current_fps));
                }
            }
        }
    }
    let (tag, fps) = tagged?;
    Some(TimecodeProbe { tag, fps: fps.or(first_video_fps)? })
}

fn probe_one(bin: &Path, file: &str) -> Option<TimecodeProbe> {
    // With no output file ffmpeg prints the banner and exits 1, so the exit code says nothing here.
    let o = tools::command(bin).args(["-hide_banner", "-i", file]).stdin(Stdio::null()).stdout(Stdio::null()).output().ok()?;
    parse_timecode_banner(&String::from_utf8_lossy(&o.stderr))
}

/// Never fails: a missing ffmpeg or a file with no timecode is simply absent from the result.
pub fn read_timecode(bin: Option<&Path>, paths: &[Value]) -> HashMap<String, TimecodeProbe> {
    let Some(bin) = bin else { return HashMap::new() };
    let files: Vec<&str> = paths.iter().filter_map(Value::as_str).collect();
    let mut out = HashMap::new();
    std::thread::scope(|scope| {
        for group in files.chunks(4) {
            let handles: Vec<_> = group.iter().map(|f| (*f, scope.spawn(move || probe_one(bin, f)))).collect();
            for (f, h) in handles {
                if let Ok(Some(p)) = h.join() {
                    out.insert(f.to_string(), p);
                }
            }
        }
    });
    out
}

#[tauri::command]
pub async fn media_read_timecode(paths: Value, ctx: State<'_, Ctx>) -> Result<HashMap<String, TimecodeProbe>, String> {
    let list = paths.as_array().cloned().unwrap_or_default();
    let bin = ctx.tools.ffmpeg();
    Ok(blocking(|| read_timecode(bin.as_deref(), &list)))
}

// ── Import ──────────────────────────────────────────────────────────────────

#[derive(Serialize, Debug, PartialEq, Clone)]
pub struct ScanFile {
    pub abs: String,
    pub rel: String,
    pub ext: String,
    pub size: u64,
}

/// Bounded and symlink-safe: lstat, skip links, cap depth and file count.
fn walk(root: &Path, rel_dir: &str, files: &mut Vec<ScanFile>, dirs: &mut Vec<String>, depth: usize) -> Result<(), String> {
    if depth > IMPORT_MAX_SCAN_DEPTH {
        return Err(format!("Directory too deep to import (over {IMPORT_MAX_SCAN_DEPTH} levels)"));
    }
    let abs_dir = if rel_dir.is_empty() { root.to_path_buf() } else { root.join(rel_dir) };
    let Ok(rd) = fs::read_dir(&abs_dir) else { return Ok(()) };
    let mut names: Vec<String> = rd.filter_map(Result::ok).filter_map(|e| e.file_name().into_string().ok()).collect();
    names.sort();
    for name in names {
        let ent_rel = if rel_dir.is_empty() { name.clone() } else { format!("{rel_dir}/{name}") };
        let ent_abs: PathBuf = abs_dir.join(&name);
        let Ok(st) = fs::symlink_metadata(&ent_abs) else { continue };
        if st.file_type().is_symlink() {
            continue;
        }
        if st.is_dir() {
            dirs.push(ent_rel.clone());
            walk(root, &ent_rel, files, dirs, depth + 1)?;
        } else if st.is_file() {
            let ext = import_ext(&name);
            if !is_allowed_ext(&ext) {
                continue;
            }
            if files.len() >= IMPORT_MAX_SCAN_FILES {
                return Err(format!("Directory too large to import (over {IMPORT_MAX_SCAN_FILES} media files)"));
            }
            files.push(ScanFile { abs: ent_abs.to_string_lossy().into_owned(), rel: ent_rel, ext, size: st.len() });
        }
    }
    Ok(())
}

pub fn import_scan(auth: &Authorized, dir: &str, abs_path: &str) -> Result<Value, String> {
    auth.check(dir)?;
    let (rd, target) = (resolve(dir), resolve(abs_path));
    if target == rd || target.starts_with(&rd) {
        return Ok(json!({ "error": "cannot import a path inside the project directory" }));
    }
    let Ok(stat) = fs::metadata(&target) else { return Ok(json!({ "error": format!("path not found: {abs_path}") })) };
    if stat.is_file() {
        let path_str = target.to_string_lossy().into_owned();
        let ext = import_ext(&path_str);
        let files: Vec<ScanFile> = if is_allowed_ext(&ext) {
            vec![ScanFile { abs: path_str.clone(), rel: target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(), ext, size: stat.len() }]
        } else {
            vec![]
        };
        return Ok(json!({ "files": files, "dirs": [], "isFile": true }));
    }
    if !stat.is_dir() {
        return Ok(json!({ "error": format!("unsupported path type: {abs_path}") }));
    }
    let (mut files, mut dirs) = (vec![], vec![]);
    if let Err(e) = walk(&target, "", &mut files, &mut dirs, 0) {
        return Ok(json!({ "error": e }));
    }
    Ok(json!({ "files": files, "dirs": dirs }))
}

pub fn import_copy(auth: &Authorized, dir: &str, abs_path: &str, rel_path: &str) -> Result<Value, String> {
    auth.check(dir)?;
    let ext = import_ext(abs_path);
    if !is_allowed_ext(&ext) {
        return Ok(json!({ "error": format!("unsupported file extension: .{ext}") }));
    }
    let dest = assert_inside(dir, rel_path)?;
    let copied = dest.parent().map_or(Ok(()), fs::create_dir_all).and_then(|()| fs::copy(abs_path, &dest));
    Ok(match copied {
        Ok(_) => json!({ "ok": true }),
        Err(e) => json!({ "error": format!("copy failed: {e}") }),
    })
}

pub fn import_download(auth: &Authorized, net: &dyn Net, dir: &str, url: &str, rel_path: &str) -> Result<Value, String> {
    auth.check(dir)?;
    let ext = import_ext(rel_path);
    if !is_allowed_ext(&ext) {
        return Ok(json!({ "error": format!("unsupported file extension: .{ext}") }));
    }
    let dest = assert_inside(dir, rel_path)?;
    Ok(match net::download_to_file(net, url, &dest, IMPORT_MAX_BYTES, IMPORT_TIMEOUT) {
        Ok(size) => json!({ "ok": true, "size": size }),
        Err(e) => json!({ "error": e }),
    })
}

/// .cube only, size-capped: unlike the imports this reads an arbitrary absolute path.
pub fn read_local_file(abs_path: &str) -> Result<Vec<u8>, String> {
    let ext = import_ext(abs_path);
    if ext != "cube" {
        return Err(format!("unsupported file extension: .{ext}"));
    }
    let stat = fs::metadata(abs_path).map_err(|_| format!("path not found: {abs_path}"))?;
    if !stat.is_file() {
        return Err(format!("not a file: {abs_path}"));
    }
    if stat.len() > LUT_MAX_BYTES {
        return Err(format!("file too large (max {}MB)", LUT_MAX_BYTES / (1024 * 1024)));
    }
    fs::read(abs_path).map_err(|e| format!("read failed: {e}"))
}

#[tauri::command]
pub async fn media_import_scan(dir: String, abs_path: String, ctx: State<'_, Ctx>) -> Result<Value, String> {
    blocking(|| import_scan(&ctx.auth, &dir, &abs_path))
}

#[tauri::command]
pub async fn media_import_copy(dir: String, abs_path: String, rel_path: String, ctx: State<'_, Ctx>) -> Result<Value, String> {
    blocking(|| import_copy(&ctx.auth, &dir, &abs_path, &rel_path))
}

#[tauri::command]
pub async fn media_import_download(dir: String, url: String, rel_path: String, ctx: State<'_, Ctx>) -> Result<Value, String> {
    blocking(|| import_download(&ctx.auth, ctx.net.as_ref(), &dir, &url, &rel_path))
}

#[tauri::command]
pub async fn media_read_local_file(abs_path: String) -> Result<Response, String> {
    blocking(|| read_local_file(&abs_path)).map(Response::new)
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::tests::FakeNet;
    use crate::util::testutil::{mock, Reply, TempDir};
    use std::process::Command;

    fn authed() -> (Authorized, TempDir) {
        let d = TempDir::new("media");
        let a = Authorized::default();
        a.add(d.path());
        (a, d)
    }

    #[test]
    fn extract_audio_needs_exactly_one_input() {
        let bin = Path::new("/bin/false");
        assert!(extract_audio(bin, None, None).unwrap_err().contains("exactly one"));
        assert!(extract_audio(bin, Some("x"), Some(&[1])).unwrap_err().contains("exactly one"));
    }

    #[test]
    fn extract_audio_reports_ffmpeg_failure_with_stderr() {
        let Some(bin) = crate::tools::Tools::locate().ffmpeg() else {
            eprintln!("SKIPPED: no ffmpeg");
            return;
        };
        let e = extract_audio(&bin, Some("/definitely/not/here.mp4"), None).unwrap_err();
        assert!(e.starts_with("ffmpeg exited with code"), "{e}");
    }

    #[test]
    fn extract_audio_works_through_a_pipe_with_a_large_input() {
        let (Some(gen), Some(bin)) = (crate::tools::test_generator(), crate::tools::Tools::locate().ffmpeg()) else {
            eprintln!("SKIPPED: no ffmpeg");
            return;
        };
        // 30 s of silence as WAV: bigger than a pipe buffer in both directions.
        let wav = Command::new(&gen).args(["-v", "error", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", "30", "-f", "wav", "pipe:1"]).output().unwrap().stdout;
        let out = extract_audio(&bin, None, Some(&wav)).unwrap();
        let secs = (out.len() - 44) as f64 / (16000.0 * 2.0);
        assert!((secs - 30.0).abs() < 0.1, "{secs}");
    }

    #[test]
    fn frame_rate_parsing() {
        let line = |fps: &str| format!("  Stream #0:0[0x1]: Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 64x48 [SAR 1:1 DAR 4:3], 30 kb/s, {fps}, 29.97 tbr, 30k tbn (default)");
        assert_eq!(banner_fps(&line("29.97 fps")), Some(29.97));
        assert_eq!(banner_fps(&line("25 fps")), Some(25.0));
        assert_eq!(banner_fps(&line("1k fps")), Some(1000.0));
        assert_eq!(banner_fps(&line("0 fps")), None);
        assert_eq!(banner_fps(&line("x fps")), None);
        assert_eq!(banner_fps("  Stream #0:2[0x3](eng): Data: none (tmcd / 0x64636D74), 0 kb/s"), None);
    }

    const TAGGED: &str = "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'a.mov':
  Metadata:
    major_brand     : qt  
  Duration: 00:00:00.50, start: 0.000000, bitrate: 148 kb/s
  Stream #0:0[0x1]: Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 64x48, 30 kb/s, 23.98 fps, 23.98 tbr, 24k tbn (default)
    Metadata:
      handler_name    : Core Media Video
      timecode        : 01:00:00;02
  Stream #0:1[0x2](eng): Data: none (tmcd / 0x64636D74), 0 kb/s
    Metadata:
      timecode        : 01:00:00;02
At least one output file must be specified
";

    #[test]
    fn probe_output_takes_the_stream_with_a_timecode_tag() {
        let p = parse_timecode_banner(TAGGED).unwrap();
        assert_eq!(p.tag, "01:00:00;02");
        assert_eq!(p.fps.round(), 24.0);
        let audio_first = "  Stream #0:0: Audio: aac, 48000 Hz, mono\n    Metadata:\n      handler_name    : x\n  Stream #0:1: Video: h264, yuv420p, 25 fps, 25 tbr\n    Metadata:\n      timecode        : 02:00:00:00\n";
        assert_eq!(parse_timecode_banner(audio_first), Some(TimecodeProbe { tag: "02:00:00:00".into(), fps: 25.0 }));
        // A tmcd track with no link from the video track: the video stream gives the rate.
        let unlinked = "  Stream #0:0: Video: h264, yuv420p, 30 fps, 30 tbr\n  Stream #0:1: Data: none (tmcd / 0x64636D74)\n    Metadata:\n      timecode        : 03:00:00:00\n";
        assert_eq!(parse_timecode_banner(unlinked), Some(TimecodeProbe { tag: "03:00:00:00".into(), fps: 30.0 }));
        for bad in [
            "nope",
            "",
            "  Stream #0:0: Video: h264, yuv420p, 30 fps, 30 tbr\n",
            // No rate anywhere, like ffprobe's "0/0".
            "  Stream #0:0: Video: h264, yuv420p, 30 tbr\n    Metadata:\n      timecode        : 01:00:00:00\n",
            "  Stream #0:0: Data: none (tmcd / 0x64636D74)\n    Metadata:\n      timecode        : 01:00:00:00\n",
        ] {
            assert_eq!(parse_timecode_banner(bad), None, "{bad}");
        }
    }

    // The layout ffmpeg 7 prints: stream metadata two spaces deeper than ffmpeg 6's.
    #[test]
    fn both_banner_layouts_parse() {
        let v7 = "  Stream #0:0[0x1](und): Video: h264 (High), yuv420p, 30 kb/s, 30 fps, 30 tbr\n      Metadata:\n        handler_name    : VideoHandler\n        timecode        : 01:00:00:00\n";
        assert_eq!(parse_timecode_banner(v7), Some(TimecodeProbe { tag: "01:00:00:00".into(), fps: 30.0 }));
    }

    #[test]
    fn metadata_text_cant_pose_as_a_stream_or_a_stream_tag() {
        let spoof = "Input #0, mov, from 'a.mp4':
  Metadata:
    title           :   timecode        : 09:09:09:09
    comment         : Stream #0:0: Video: h264, 12.00 fps
    timecode        : 08:00:00:00
  Duration: 00:00:00.50, start: 0.000000, bitrate: 58 kb/s
  Stream #0:0: Video: h264, yuv420p, 30 fps, 30 tbr
    Metadata:
      title           : first line
                      : timecode : 07:00:00:00
";
        assert_eq!(parse_timecode_banner(spoof), None);
    }

    #[test]
    fn read_timecode_never_fails() {
        assert!(read_timecode(None, &[json!("/x.mp4")]).is_empty());
        assert!(read_timecode(Some(Path::new("/definitely/not/ffmpeg")), &[json!("/x.mp4"), json!(3)]).is_empty());
    }

    // Real tagged clips, written by the stock ffmpeg and read by the app's. `quanta` is what the
    // renderer's parseTimecodeTag derives from fps.
    #[test]
    fn real_tagged_clips_read_the_same_as_ffprobe_did() {
        let (Some(gen), Some(bin)) = (crate::tools::test_generator(), crate::tools::Tools::locate().ffmpeg()) else {
            eprintln!("SKIPPED: no ffmpeg");
            return;
        };
        let d = TempDir::new("timecode");
        let cases = [
            ("a.mp4", "30", Some("01:00:00:00"), 30.0),
            ("b.mov", "30000/1001", Some("01:00:00;02"), 30.0),
            ("c.mov", "24000/1001", Some("10:11:12:13"), 24.0),
            ("d.mp4", "25", Some("00:59:59:24"), 25.0),
            ("e.mov", "60000/1001", Some("00:10:00;04"), 60.0),
            ("f.mp4", "30", None, 0.0),
        ];
        let mut paths = vec![];
        for (name, rate, tc, _) in &cases {
            let out = d.path().join(name);
            let src = format!("testsrc2=s=64x48:r={rate}:d=0.2");
            let mut c = Command::new(&gen);
            c.args(["-y", "-v", "error", "-f", "lavfi", "-i", &src, "-c:v", "libx264"]);
            if let Some(tc) = tc {
                c.args(["-timecode", tc]);
            }
            assert!(c.arg(&out).stdin(Stdio::null()).status().unwrap().success());
            paths.push(json!(out.to_str().unwrap()));
        }
        let not_media = d.path().join("g.mp4");
        fs::write(&not_media, "not a video").unwrap();
        paths.push(json!(not_media.to_str().unwrap()));
        let got = read_timecode(Some(&bin), &paths);
        for (name, _, tc, quanta) in &cases {
            let p = got.get(d.path().join(name).to_str().unwrap());
            match tc {
                Some(tc) => {
                    let p = p.unwrap_or_else(|| panic!("{name}: no timecode"));
                    assert_eq!(p.tag, *tc, "{name}");
                    assert_eq!(p.fps.round(), *quanta, "{name}");
                }
                None => assert!(p.is_none(), "{name}"),
            }
        }
        assert_eq!(got.len(), 5);
    }

    #[test]
    fn scan_needs_an_authorized_dir_and_refuses_paths_inside_the_project() {
        let (a, d) = authed();
        let dir = d.path().to_str().unwrap();
        let other = TempDir::new("other");
        assert_eq!(import_scan(&a, other.path().to_str().unwrap(), dir).unwrap_err(), "unauthorized project dir");
        assert!(import_scan(&a, dir, dir).unwrap()["error"].as_str().unwrap().contains("inside the project"));
        assert!(import_scan(&a, dir, &format!("{dir}/media")).unwrap()["error"].as_str().unwrap().contains("inside the project"));
        assert!(import_scan(&a, dir, "/definitely/not/here").unwrap()["error"].as_str().unwrap().contains("path not found"));
    }

    #[test]
    fn scan_filters_extensions_skips_symlinks_and_caps_depth_and_count() {
        let (a, d) = authed();
        let dir = d.path().to_str().unwrap();
        let src = TempDir::new("src");
        fs::create_dir_all(src.path().join("sub")).unwrap();
        fs::write(src.path().join("a.MP4"), "x").unwrap();
        fs::write(src.path().join("notes.txt"), "x").unwrap();
        fs::write(src.path().join("sub/b.wav"), "xx").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("/etc", src.path().join("link")).unwrap();
        let r = import_scan(&a, dir, src.path().to_str().unwrap()).unwrap();
        assert_eq!(r["dirs"], json!(["sub"]));
        let rels: Vec<&str> = r["files"].as_array().unwrap().iter().map(|f| f["rel"].as_str().unwrap()).collect();
        assert_eq!(rels, ["a.MP4", "sub/b.wav"]);
        assert_eq!(r["files"][0]["ext"], "mp4");
        assert!(r.get("isFile").is_none());

        let one = import_scan(&a, dir, src.path().join("a.MP4").to_str().unwrap()).unwrap();
        assert_eq!(one["isFile"], true);
        assert_eq!(one["files"][0]["rel"], "a.MP4");

        let deep = TempDir::new("deep");
        let mut p = deep.path().to_path_buf();
        for i in 0..10 {
            p = p.join(i.to_string());
        }
        fs::create_dir_all(&p).unwrap();
        assert!(import_scan(&a, dir, deep.path().to_str().unwrap()).unwrap()["error"].as_str().unwrap().contains("too deep"));

        let wide = TempDir::new("wide");
        for i in 0..501 {
            fs::write(wide.path().join(format!("{i}.png")), "").unwrap();
        }
        assert!(import_scan(&a, dir, wide.path().to_str().unwrap()).unwrap()["error"].as_str().unwrap().contains("too large"));
    }

    #[test]
    fn copy_refuses_bad_extensions_unauthorized_dirs_and_escaping_destinations() {
        let (a, d) = authed();
        let dir = d.path().to_str().unwrap();
        let src = TempDir::new("src");
        let f = src.path().join("a.mp4");
        fs::write(&f, "video").unwrap();
        let fs_ = f.to_str().unwrap();
        assert_eq!(import_copy(&a, dir, "/etc/passwd", "media/x").unwrap()["error"], "unsupported file extension: .");
        assert!(import_copy(&a, src.path().to_str().unwrap(), fs_, "x.mp4").is_err());
        assert!(import_copy(&a, dir, fs_, "../escape.mp4").unwrap_err().contains("path escapes"));
        assert!(!d.path().parent().unwrap().join("escape.mp4").exists());
        assert_eq!(import_copy(&a, dir, fs_, "media/a.mp4").unwrap()["ok"], true);
        assert_eq!(fs::read_to_string(d.path().join("media/a.mp4")).unwrap(), "video");
    }

    #[test]
    fn local_file_reads_are_cube_only_and_capped() {
        let d = TempDir::new("lut");
        assert_eq!(read_local_file("/etc/passwd").unwrap_err(), "unsupported file extension: .");
        assert_eq!(read_local_file("/etc/hosts.txt").unwrap_err(), "unsupported file extension: .txt");
        assert!(read_local_file("/definitely/not/here.cube").unwrap_err().contains("path not found"));
        fs::create_dir_all(d.path().join("dir.cube")).unwrap();
        assert!(read_local_file(d.path().join("dir.cube").to_str().unwrap()).unwrap_err().contains("not a file"));
        let f = d.path().join("a.CUBE");
        fs::write(&f, "LUT").unwrap();
        assert_eq!(read_local_file(f.to_str().unwrap()).unwrap(), b"LUT");
        let big = fs::File::create(d.path().join("big.cube")).unwrap();
        big.set_len(LUT_MAX_BYTES + 1).unwrap();
        assert!(read_local_file(d.path().join("big.cube").to_str().unwrap()).unwrap_err().contains("too large"));
    }

    #[test]
    fn url_import_checks_authorization_extension_and_containment_before_any_network() {
        let (a, d) = authed();
        let dir = d.path().to_str().unwrap();
        let m = mock(|_| Reply::new(200, "x"));
        let net = FakeNet::new(m.port, &[("a.example", &["93.184.216.1"])]);
        let other = TempDir::new("other");
        assert!(import_download(&a, &net, other.path().to_str().unwrap(), "http://a.example/x", "x.mp4").is_err());
        assert!(import_download(&a, &net, dir, "http://a.example/x", "x.exe").unwrap()["error"].as_str().unwrap().contains("unsupported file extension"));
        assert!(import_download(&a, &net, dir, "http://a.example/x", "../x.mp4").unwrap_err().contains("path escapes"));
        assert!(net.lookups.lock().unwrap().is_empty());
        assert!(m.seen().is_empty());
    }

    #[test]
    fn url_import_denied_targets_write_nothing() {
        let (a, d) = authed();
        let dir = d.path().to_str().unwrap();
        let m = mock(|_| Reply::new(200, "x"));
        let net = FakeNet::new(m.port, &[("meta.evil", &["169.254.169.254"]), ("a.example", &["93.184.216.1"])]);
        assert_eq!(import_download(&a, &net, dir, "http://meta.evil/x", "x.mp4").unwrap()["error"], "url host not allowed");
        assert_eq!(import_download(&a, &net, dir, "https://127.0.0.1/x", "x.mp4").unwrap()["error"], "url host not allowed");
        assert_eq!(import_download(&a, &net, dir, "not a url", "x.mp4").unwrap()["error"], "invalid url");
        assert!(m.seen().is_empty());
        assert!(!d.path().join("x.mp4").exists());
        assert_eq!(import_download(&a, &net, dir, "http://a.example/x", "x.mp4").unwrap()["size"], 1);
    }
}
