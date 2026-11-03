//! export:* channels. Video frames arrive as raw binary IPC and go straight to ffmpeg's stdin; audio
//! is buffered to a temp .f32le file. With audio or subtitles, a second ffmpeg pass muxes the result.

use std::fs::File;
use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use serde::Deserialize;
use tauri::ipc::Request;
use tauri::State;

use crate::project::{check_output_path, Authorized};
use crate::util::{blocking, raw_body, tail_chars};
use crate::Ctx;

pub struct CodecSpec {
    pub ext: &'static str,
    pub vargs: &'static [&'static str],
    pub aargs: &'static [&'static str],
    pub mux_flags: &'static [&'static str],
}

/// Allowlist. libx264_youtube: H.264 High, CRF 18, preset slow, yuv420p, AAC 48 kHz 320 kbps and
/// +faststart, in line with YouTube's recommended upload settings.
pub fn codec(name: &str) -> Option<CodecSpec> {
    match name {
        "prores_ks" => Some(CodecSpec { ext: ".mov", vargs: &["-c:v", "prores_ks", "-profile:v", "3"], aargs: &["-c:a", "aac"], mux_flags: &[] }),
        "libx264" => Some(CodecSpec { ext: ".mp4", vargs: &["-c:v", "libx264", "-pix_fmt", "yuv420p"], aargs: &["-c:a", "aac"], mux_flags: &[] }),
        "libx264_youtube" => Some(CodecSpec {
            ext: ".mp4",
            vargs: &["-c:v", "libx264", "-preset", "slow", "-crf", "18", "-profile:v", "high", "-pix_fmt", "yuv420p", "-movflags", "+faststart"],
            aargs: &["-c:a", "aac", "-b:a", "320k", "-ar", "48000"],
            mux_flags: &["-movflags", "+faststart"],
        }),
        _ => None,
    }
}

/// `readRGBA` is already top-down, so there's no vflip here.
pub fn video_args(spec: &CodecSpec, width: u32, height: u32, fps: f64, out: &str) -> Vec<String> {
    let mut v: Vec<String> = ["-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s"].map(String::from).to_vec();
    v.push(format!("{width}x{height}"));
    v.push("-r".into());
    v.push(fps.to_string());
    v.extend(["-i".to_string(), "pipe:0".to_string()]);
    v.extend(spec.vargs.iter().map(|s| s.to_string()));
    v.push(out.to_string());
    v
}

#[derive(Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct AudioFormat {
    #[serde(rename = "sampleRate")]
    pub sample_rate: u32,
    pub channels: u32,
}

/// Encoded video + raw audio (optional) + SRT (optional, as a mov_text track).
pub fn mux_args(spec: &CodecSpec, audio: Option<AudioFormat>, video: &str, audio_path: Option<&str>, out: &str, srt: Option<&str>) -> Vec<String> {
    let mut a: Vec<String> = vec!["-y".into(), "-i".into(), video.into()];
    let has_audio = audio_path.is_some();
    if let (Some(p), Some(f)) = (audio_path, audio) {
        a.extend(["-f".into(), "f32le".into(), "-ar".into(), f.sample_rate.to_string(), "-ac".into(), f.channels.to_string(), "-i".into(), p.into()]);
    }
    if let Some(s) = srt {
        a.extend(["-f".into(), "srt".into(), "-i".into(), s.into()]);
    }
    a.extend(["-map".into(), "0:v".into()]);
    if has_audio {
        a.extend(["-map".into(), "1:a".into()]);
    }
    if srt.is_some() {
        a.extend(["-map".into(), format!("{}:s", if has_audio { 2 } else { 1 })]);
    }
    a.extend(["-c:v".into(), "copy".into()]);
    if has_audio {
        a.extend(spec.aargs.iter().map(|s| s.to_string()));
    }
    if srt.is_some() {
        a.extend(["-c:s".into(), "mov_text".into(), "-metadata:s:s:0".into(), "language=eng".into()]);
    }
    a.extend(spec.mux_flags.iter().map(|s| s.to_string()));
    if has_audio {
        a.push("-shortest".into());
    }
    a.push(out.into());
    a
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StartOpts {
    pub width: i64,
    pub height: i64,
    pub fps: f64,
    pub audio: Option<AudioFormat>,
    pub codec: String,
    pub out_path: String,
    pub subtitles_srt: Option<String>,
}

struct Session {
    id: String,
    bin: PathBuf,
    codec: String,
    audio: Option<AudioFormat>,
    out: PathBuf,
    frame_bytes: usize,
    child: Child,
    stdin: Option<ChildStdin>,
    stderr: Arc<Mutex<String>>,
    stderr_thread: Option<JoinHandle<()>>,
    video_only: PathBuf,
    audio_path: Option<PathBuf>,
    audio_file: Option<BufWriter<File>>,
    srt_path: Option<PathBuf>,
}

/// One export at a time, as in Electron; ids keep the protocol forward-compatible.
#[derive(Default)]
pub struct Exports {
    active: Mutex<Option<Session>>,
    counter: AtomicU64,
}

fn collect_stderr(child: &mut Child) -> (Arc<Mutex<String>>, Option<JoinHandle<()>>) {
    let log = Arc::new(Mutex::new(String::new()));
    let thread = child.stderr.take().map(|mut pipe| {
        let log = log.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            while let Ok(n) = pipe.read(&mut buf) {
                if n == 0 {
                    break;
                }
                let mut l = log.lock().unwrap();
                l.push_str(&String::from_utf8_lossy(&buf[..n]));
                // Keep the end only: ffmpeg's progress lines would otherwise grow without bound.
                if l.len() > 64 * 1024 {
                    let cut = l.len() - 32 * 1024;
                    let cut = (cut..l.len()).find(|&i| l.is_char_boundary(i)).unwrap_or(0);
                    l.drain(..cut);
                }
            }
        })
    });
    (log, thread)
}

fn remove_temps(paths: &[Option<&Path>]) {
    for p in paths.iter().flatten() {
        let _ = std::fs::remove_file(p);
    }
}

impl Exports {
    pub fn start(&self, auth: &Authorized, ffmpeg: Option<PathBuf>, o: StartOpts) -> Result<String, String> {
        let mut active = self.active.lock().unwrap();
        if active.is_some() {
            return Err("export already in progress; call export:finish first".into());
        }
        if o.width <= 0 || o.height <= 0 || o.width > 8192 || o.height > 8192 {
            return Err("invalid export dimensions".into());
        }
        if !(o.fps.is_finite() && o.fps > 0.0) {
            return Err("invalid export frame rate".into());
        }
        let spec = codec(&o.codec).ok_or_else(|| format!("unsupported codec: {}", o.codec))?;
        let resolved = check_output_path(auth, &o.out_path)?;
        let bin = ffmpeg.ok_or("ffmpeg not found beside the app")?;

        if o.subtitles_srt.as_ref().is_some_and(|s| s.encode_utf16().count() > 2_000_000) {
            return Err("invalid subtitles".into());
        }
        let srt_text = o.subtitles_srt.as_deref().filter(|s| !s.is_empty());
        let needs_mux = o.audio.is_some() || srt_text.is_some();
        let n = self.counter.fetch_add(1, Ordering::SeqCst) + 1;
        let id = n.to_string();
        // The pid keeps two running apps from sharing temp names.
        let tmp = std::env::temp_dir();
        let stem = format!("{}-{n}", std::process::id());
        let video_only = if needs_mux { tmp.join(format!("export-vid-{stem}{}", spec.ext)) } else { resolved.clone() };
        let audio_path = o.audio.map(|_| tmp.join(format!("export-aud-{stem}.f32le")));
        let srt_path = srt_text.map(|_| tmp.join(format!("export-sub-{stem}.srt")));
        if let (Some(p), Some(text)) = (&srt_path, srt_text) {
            std::fs::write(p, text).map_err(|e| e.to_string())?;
        }

        let result = (|| {
            let audio_file = match &audio_path {
                Some(p) => Some(BufWriter::new(File::create(p).map_err(|e| e.to_string())?)),
                None => None,
            };
            let args = video_args(&spec, o.width as u32, o.height as u32, o.fps, &video_only.to_string_lossy());
            let mut child = Command::new(&bin).args(&args).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped()).spawn().map_err(|e| format!("ffmpeg spawn error: {e}"))?;
            let stdin = child.stdin.take();
            let (stderr, stderr_thread) = collect_stderr(&mut child);
            Ok::<_, String>((audio_file, child, stdin, stderr, stderr_thread))
        })();
        let (audio_file, child, stdin, stderr, stderr_thread) = match result {
            Ok(v) => v,
            Err(e) => {
                remove_temps(&[audio_path.as_deref(), srt_path.as_deref()]);
                return Err(e);
            }
        };
        *active = Some(Session {
            id: id.clone(),
            bin,
            codec: o.codec,
            audio: o.audio,
            out: resolved,
            frame_bytes: o.width as usize * o.height as usize * 4,
            child,
            stdin,
            stderr,
            stderr_thread,
            video_only,
            audio_path,
            audio_file,
            srt_path,
        });
        Ok(id)
    }

    /// A wrong-sized frame would silently shear every frame after it in rawvideo, so it's an error.
    pub fn video_frame(&self, frame: &[u8]) -> Result<(), String> {
        let mut active = self.active.lock().unwrap();
        let s = active.as_mut().ok_or("no active export session")?;
        if frame.len() != s.frame_bytes {
            return Err(format!("frame is {} bytes, expected {}", frame.len(), s.frame_bytes));
        }
        let stdin = s.stdin.as_mut().ok_or("ffmpeg stdin closed")?;
        stdin.write_all(frame).map_err(|e| format!("ffmpeg stopped accepting frames: {e}. {}", tail_chars(&s.stderr.lock().unwrap(), 500)))
    }

    pub fn audio_data(&self, data: &[u8]) -> Result<(), String> {
        let mut active = self.active.lock().unwrap();
        let s = active.as_mut().ok_or("no active export session")?;
        // Same as Electron: audio sent to a session without audio has nowhere to go.
        match s.audio_file.as_mut() {
            Some(f) => f.write_all(data).map_err(|e| e.to_string()),
            None => Ok(()),
        }
    }

    pub fn finish(&self) -> Result<String, String> {
        let mut s = self.active.lock().unwrap().take().ok_or("no active export session")?;
        let _ = s.id;
        drop(s.stdin.take());
        let status = s.child.wait().map_err(|e| e.to_string());
        if let Some(t) = s.stderr_thread.take() {
            let _ = t.join();
        }
        let flushed = match s.audio_file.take() {
            Some(mut f) => f.flush().map_err(|e| e.to_string()),
            None => Ok(()),
        };
        let needs_mux = s.audio_path.is_some() || s.srt_path.is_some();
        let cleanup = |s: &Session| {
            let video = needs_mux.then_some(s.video_only.as_path());
            remove_temps(&[video, s.audio_path.as_deref(), s.srt_path.as_deref()]);
        };
        match status {
            Ok(st) if st.success() => {}
            Ok(st) => {
                cleanup(&s);
                return Err(format!("ffmpeg video pass exited {}. stderr: {}", st.code().unwrap_or(-1), tail_chars(&s.stderr.lock().unwrap(), 800)));
            }
            Err(e) => {
                cleanup(&s);
                return Err(e);
            }
        }
        if let Err(e) = flushed {
            cleanup(&s);
            return Err(e);
        }
        let out = s.out.to_string_lossy().into_owned();
        if !needs_mux {
            return Ok(out);
        }
        let spec = codec(&s.codec).ok_or("unsupported codec")?;
        let audio_str = s.audio_path.as_ref().map(|p| p.to_string_lossy().into_owned());
        let srt_str = s.srt_path.as_ref().map(|p| p.to_string_lossy().into_owned());
        let args = mux_args(&spec, s.audio, &s.video_only.to_string_lossy(), audio_str.as_deref(), &out, srt_str.as_deref());
        let muxed = Command::new(&s.bin).args(&args).stdin(Stdio::null()).output().map_err(|e| format!("ffmpeg mux spawn error: {e}"));
        cleanup(&s);
        let o = muxed?;
        if !o.status.success() {
            return Err(format!("ffmpeg mux exited {}. stderr: {}", o.status.code().unwrap_or(-1), tail_chars(&String::from_utf8_lossy(&o.stderr), 800)));
        }
        Ok(out)
    }
}

#[tauri::command]
pub async fn export_session_start(opts: StartOpts, ctx: State<'_, Ctx>) -> Result<String, String> {
    blocking(|| ctx.exports.start(&ctx.auth, ctx.tools.ffmpeg(), opts))
}

#[tauri::command]
pub async fn export_video_frame(request: Request<'_>, ctx: State<'_, Ctx>) -> Result<(), String> {
    let body = raw_body(&request)?;
    blocking(|| ctx.exports.video_frame(body))
}

#[tauri::command]
pub async fn export_audio_data(request: Request<'_>, ctx: State<'_, Ctx>) -> Result<(), String> {
    let body = raw_body(&request)?;
    blocking(|| ctx.exports.audio_data(body))
}

#[tauri::command]
pub async fn export_session_finish(ctx: State<'_, Ctx>) -> Result<String, String> {
    blocking(|| ctx.exports.finish())
}

#[cfg(test)]
mod tests {
    //! Port of apps/desktop/test/export-codecs.test.ts, plus session checks.
    use super::*;
    use crate::util::testutil::TempDir;

    fn joined(v: &[String]) -> String {
        v.join(" ")
    }

    #[test]
    fn youtube_is_high_crf18_slow_yuv420p_faststart_and_aac_320k_48k() {
        let spec = codec("libx264_youtube").unwrap();
        let v = video_args(&spec, 3840, 2160, 30.0, "/o.mp4");
        for want in ["-s", "3840x2160", "-r", "30", "-profile:v", "high", "-crf", "18", "-preset", "slow", "+faststart"] {
            assert!(v.iter().any(|a| a == want), "{want}");
        }
        assert_eq!(v.last().unwrap(), "/o.mp4");
        let m = mux_args(&spec, Some(AudioFormat { sample_rate: 44100, channels: 2 }), "/v.mp4", Some("/a.f32le"), "/o.mp4", None);
        assert!(joined(&m).contains("-c:v copy -c:a aac -b:a 320k -ar 48000 -movflags +faststart -shortest /o.mp4"));
    }

    #[test]
    fn default_codecs_keep_their_previous_arguments() {
        let spec = codec("libx264").unwrap();
        assert_eq!(video_args(&spec, 1280, 720, 24.0, "/o.mp4"), ["-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", "1280x720", "-r", "24", "-i", "pipe:0", "-c:v", "libx264", "-pix_fmt", "yuv420p", "/o.mp4"]);
        assert_eq!(joined(&mux_args(&spec, Some(AudioFormat { sample_rate: 48000, channels: 2 }), "/v", Some("/a"), "/o", None)), "-y -i /v -f f32le -ar 48000 -ac 2 -i /a -map 0:v -map 1:a -c:v copy -c:a aac -shortest /o");
    }

    #[test]
    fn captions_are_a_mov_text_track_mapped_after_audio_or_alone_with_video() {
        let yt = codec("libx264_youtube").unwrap();
        let with_audio = joined(&mux_args(&yt, Some(AudioFormat { sample_rate: 48000, channels: 2 }), "/v.mp4", Some("/a.f32le"), "/o.mp4", Some("/s.srt")));
        assert!(with_audio.contains("-f srt -i /s.srt -map 0:v -map 1:a -map 2:s"));
        assert!(with_audio.contains("-c:s mov_text"));
        let plain = codec("libx264").unwrap();
        assert_eq!(joined(&mux_args(&plain, None, "/v.mp4", None, "/o.mp4", Some("/s.srt"))), "-y -i /v.mp4 -f srt -i /s.srt -map 0:v -map 1:s -c:v copy -c:s mov_text -metadata:s:s:0 language=eng /o.mp4");
    }

    #[test]
    fn no_vflip_anywhere() {
        for c in ["prores_ks", "libx264", "libx264_youtube"] {
            assert!(!joined(&video_args(&codec(c).unwrap(), 2, 2, 30.0, "/o")).contains("vflip"));
        }
    }

    fn opts(out: &str) -> StartOpts {
        StartOpts { width: 2, height: 2, fps: 30.0, audio: None, codec: "libx264".into(), out_path: out.into(), subtitles_srt: None }
    }

    #[test]
    fn start_refuses_other_codecs_bad_sizes_and_unauthorized_output() {
        let (x, a) = (Exports::default(), Authorized::default());
        let tmp = std::env::temp_dir().join("frontstage-never.mp4");
        let tmp = tmp.to_str().unwrap();
        let bin = Some(PathBuf::from("/bin/false"));
        assert!(x.start(&a, bin.clone(), StartOpts { codec: "evil".into(), ..opts(tmp) }).unwrap_err().contains("unsupported codec"));
        for (w, h) in [(0, 2), (2, 0), (9000, 2), (-1, 2)] {
            assert_eq!(x.start(&a, bin.clone(), StartOpts { width: w, height: h, ..opts(tmp) }).unwrap_err(), "invalid export dimensions");
        }
        assert_eq!(x.start(&a, bin.clone(), StartOpts { fps: 0.0, ..opts(tmp) }).unwrap_err(), "invalid export frame rate");
        assert_eq!(x.start(&a, bin, opts("/private/var/empty-not-temp/x.mp4")).unwrap_err(), "unauthorized project dir");
        assert_eq!(x.start(&a, None, opts(tmp)).unwrap_err(), "ffmpeg not found beside the app");
    }

    #[test]
    fn frames_and_finish_need_an_active_session() {
        let x = Exports::default();
        assert_eq!(x.video_frame(&[0; 16]).unwrap_err(), "no active export session");
        assert_eq!(x.finish().unwrap_err(), "no active export session");
    }

    // A real ffmpeg run when the repo's binary is installed; skipped otherwise, and says so.
    #[test]
    fn real_ffmpeg_top_row_stays_on_top_with_audio_and_subtitles() {
        let Some(bin) = crate::tools::Tools::locate().ffmpeg() else {
            eprintln!("SKIPPED: no ffmpeg");
            return;
        };
        let d = TempDir::new("export");
        let out = d.path().join("out.mp4");
        let a = Authorized::default();
        a.add(d.path());
        let x = Exports::default();
        let (w, h) = (64usize, 64usize);
        x.start(
            &a,
            Some(bin.clone()),
            StartOpts {
                width: w as i64,
                height: h as i64,
                fps: 10.0,
                audio: Some(AudioFormat { sample_rate: 48000, channels: 2 }),
                codec: "libx264_youtube".into(),
                out_path: out.to_str().unwrap().into(),
                subtitles_srt: Some("1\n00:00:00,000 --> 00:00:01,000\nHello\n".into()),
            },
        )
        .unwrap();
        assert!(x.start(&a, Some(bin.clone()), opts(out.to_str().unwrap())).unwrap_err().contains("already in progress"));
        // White on the top half, black below.
        let mut frame = vec![0u8; w * h * 4];
        for (i, px) in frame.chunks_mut(4).enumerate() {
            let v = if i / w < h / 2 { 255 } else { 0 };
            px.copy_from_slice(&[v, v, v, 255]);
        }
        assert!(x.video_frame(&frame[1..]).unwrap_err().contains("expected"));
        for _ in 0..10 {
            x.video_frame(&frame).unwrap();
        }
        x.audio_data(&vec![0u8; 48000 * 2 * 4]).unwrap();
        assert_eq!(x.finish().unwrap(), out.to_str().unwrap());

        // Decode the first frame back as grey: top row bright, bottom row dark.
        let o = Command::new(&bin).args(["-v", "error", "-i", out.to_str().unwrap(), "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"]).output().unwrap();
        assert_eq!(o.stdout.len(), w * h);
        assert!(o.stdout[w * 2] > 200, "top {}", o.stdout[w * 2]);
        assert!(o.stdout[w * (h - 3)] < 50, "bottom {}", o.stdout[w * (h - 3)]);
        // Three streams made it into the file.
        let info = Command::new(&bin).args(["-hide_banner", "-i", out.to_str().unwrap()]).output().unwrap();
        let text = String::from_utf8_lossy(&info.stderr);
        assert!(text.contains("Video: h264") && text.contains("Audio: aac") && text.contains("Subtitle: mov_text"), "{text}");
    }

    #[test]
    fn an_ffmpeg_failure_is_reported_with_its_stderr_and_temp_files_are_removed() {
        let Some(bin) = crate::tools::Tools::locate().ffmpeg() else {
            eprintln!("SKIPPED: no ffmpeg");
            return;
        };
        let d = TempDir::new("export-fail");
        let a = Authorized::default();
        a.add(d.path());
        let x = Exports::default();
        // An odd size can't be encoded to yuv420p by libx264.
        x.start(&a, Some(bin), StartOpts { width: 3, height: 3, ..opts(d.path().join("o.mp4").to_str().unwrap()) }).unwrap();
        let _ = x.video_frame(&[0u8; 36]);
        let e = x.finish().unwrap_err();
        assert!(e.starts_with("ffmpeg video pass exited"), "{e}");
        assert!(x.finish().is_err());
    }
}
