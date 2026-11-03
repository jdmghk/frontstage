//! media:sampleFrames: still frames from a local video for choreography analysis. JPEGs come back
//! over a pipe; nothing is written to disk.

use std::path::Path;
use std::process::Stdio;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;

use crate::util::{base64_std, blocking};
use crate::Ctx;

pub const MAX_FRAMES: i64 = 20;
const VIDEO_EXT: [&str; 8] = ["mp4", "mov", "m4v", "mkv", "webm", "avi", "mpg", "mpeg"];

#[derive(Deserialize, Clone, Debug)]
pub struct Req {
    pub path: String,
    pub fps: f64,
    pub width: i64,
    #[serde(rename = "maxFrames")]
    pub max_frames: i64,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Frame {
    #[serde(rename = "timeSec")]
    pub time_sec: f64,
    pub base64: String,
}

pub fn frame_args(input: &str, fps: f64, width: i64, max_frames: i64) -> Vec<String> {
    let mut v: Vec<String> = ["-hide_banner", "-loglevel", "error", "-i"].map(String::from).to_vec();
    v.push(input.to_string());
    v.push("-vf".into());
    v.push(format!("fps={fps},scale={width}:-2"));
    v.push("-frames:v".into());
    v.push(max_frames.to_string());
    v.extend(["-f", "image2pipe", "-vcodec", "mjpeg", "-q:v", "4", "pipe:1"].map(String::from));
    v
}

/// Splits a concatenated MJPEG stream into JPEGs (SOI ff d8 ... EOI ff d9).
pub fn split_jpegs(buf: &[u8]) -> Vec<&[u8]> {
    let mut out = Vec::new();
    let mut start = None;
    let mut i = 0;
    while i + 1 < buf.len() {
        if buf[i] == 0xff {
            if buf[i + 1] == 0xd8 && start.is_none() {
                start = Some(i);
            } else if buf[i + 1] == 0xd9 {
                if let Some(s) = start.take() {
                    out.push(&buf[s..i + 2]);
                    i += 1;
                }
            }
        }
        i += 1;
    }
    out
}

pub fn validate_request(r: &Req) -> Result<(), String> {
    let ext = Path::new(&r.path).extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase);
    if !ext.is_some_and(|e| VIDEO_EXT.contains(&e.as_str())) {
        return Err("not a video file".into());
    }
    if !Path::new(&r.path).is_file() {
        return Err("video file not found".into());
    }
    if !(r.fps > 0.0 && r.fps <= 8.0) {
        return Err("fps out of range".into());
    }
    if !(160..=1280).contains(&r.width) {
        return Err("width out of range".into());
    }
    if !(1..=MAX_FRAMES).contains(&r.max_frames) {
        return Err("maxFrames out of range".into());
    }
    Ok(())
}

pub struct Output {
    pub ok: bool,
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

pub fn spawn_ffmpeg(bin: &Path, args: &[String]) -> Result<Output, String> {
    let o = crate::tools::command(bin).args(args).stdin(Stdio::null()).output().map_err(|e| e.to_string())?;
    Ok(Output { ok: o.status.success(), code: o.status.code(), stdout: o.stdout, stderr: o.stderr })
}

/// frame i is at i / fps seconds. `run` is injectable for tests.
pub fn sample_frames(req: &Req, run: impl FnOnce(&[String]) -> Result<Output, String>) -> Result<Vec<Frame>, String> {
    validate_request(req)?;
    let o = run(&frame_args(&req.path, req.fps, req.width, req.max_frames))?;
    if !o.ok {
        let err = String::from_utf8_lossy(&o.stderr);
        let last = err.trim().lines().last().filter(|l| !l.is_empty()).map(str::to_string);
        return Err(format!("ffmpeg failed: {}", last.unwrap_or_else(|| format!("exit {}", o.code.unwrap_or(-1)))));
    }
    let frames = split_jpegs(&o.stdout);
    if frames.is_empty() {
        return Err("no frames could be read from this video".into());
    }
    Ok(frames.into_iter().take(req.max_frames as usize).enumerate().map(|(i, f)| Frame { time_sec: i as f64 / req.fps, base64: base64_std(f) }).collect())
}

#[tauri::command]
pub async fn media_sample_frames(req: Req, ctx: State<'_, Ctx>) -> Result<Value, String> {
    Ok(blocking(|| {
        let Some(bin) = ctx.tools.ffmpeg() else { return json!({ "error": "ffmpeg is not available" }) };
        match sample_frames(&req, |args| spawn_ffmpeg(&bin, args)) {
            Ok(frames) => json!({ "frames": frames }),
            Err(e) => json!({ "error": e }),
        }
    }))
}

#[cfg(test)]
mod tests {
    //! Port of apps/desktop/test/frame-sampler.test.ts.
    use super::*;
    use crate::util::testutil::TempDir;
    use base64::Engine;

    fn jpeg(n: u8) -> Vec<u8> {
        vec![0xff, 0xd8, n, n, 0xff, 0xd9]
    }

    fn video(d: &TempDir) -> String {
        let f = d.path().join("ref.mp4");
        std::fs::write(&f, "x").unwrap();
        f.to_string_lossy().into_owned()
    }

    fn req(path: &str, fps: f64, width: i64, max_frames: i64) -> Req {
        Req { path: path.into(), fps, width, max_frames }
    }

    #[test]
    fn ffmpeg_args_sample_scale_cap_and_pipe_mjpeg() {
        let want = ["-hide_banner", "-loglevel", "error", "-i", "/v.mp4", "-vf", "fps=2,scale=768:-2", "-frames:v", "12", "-f", "image2pipe", "-vcodec", "mjpeg", "-q:v", "4", "pipe:1"];
        assert_eq!(frame_args("/v.mp4", 2.0, 768, 12), want);
    }

    #[test]
    fn splits_a_concatenated_jpeg_stream() {
        let all = [jpeg(1), jpeg(2), jpeg(3)].concat();
        let got: Vec<u8> = split_jpegs(&all).iter().map(|b| b[2]).collect();
        assert_eq!(got, [1, 2, 3]);
    }

    #[test]
    fn rejects_non_video_paths_and_out_of_range_settings_before_running_ffmpeg() {
        let d = TempDir::new("frames");
        let f = video(&d);
        assert!(validate_request(&req("/etc/passwd", 1.0, 768, 5)).unwrap_err().contains("not a video"));
        assert!(validate_request(&req(&f, 50.0, 768, 5)).unwrap_err().contains("fps"));
        assert!(validate_request(&req(&f, 1.0, 768, 99)).unwrap_err().contains("maxFrames"));
        assert!(validate_request(&req(&f, 1.0, 10, 5)).unwrap_err().contains("width"));
        let mut ran = false;
        assert!(sample_frames(&req("/etc/passwd", 1.0, 768, 5), |_| { ran = true; Err("no".into()) }).is_err());
        assert!(!ran);
    }

    #[test]
    fn returns_base64_frames_with_their_times() {
        let d = TempDir::new("frames");
        let frames = sample_frames(&req(&video(&d), 2.0, 768, 5), |_| Ok(Output { ok: true, code: Some(0), stdout: [jpeg(1), jpeg(2)].concat(), stderr: vec![] })).unwrap();
        let times: Vec<f64> = frames.iter().map(|f| f.time_sec).collect();
        assert_eq!(times, [0.0, 0.5]);
        assert_eq!(base64::engine::general_purpose::STANDARD.decode(&frames[0].base64).unwrap()[2], 1);
    }

    #[test]
    fn an_ffmpeg_failure_surfaces_its_last_error_line() {
        let d = TempDir::new("frames");
        let e = sample_frames(&req(&video(&d), 1.0, 768, 5), |_| {
            Ok(Output { ok: false, code: Some(1), stdout: vec![], stderr: b"first\nInvalid data found when processing input\n".to_vec() })
        })
        .unwrap_err();
        assert!(e.contains("Invalid data found"), "{e}");
    }
}
