//! Checks of the ffmpeg binary the app runs against the stock build, through the app's own code. Not
//! part of a normal `cargo test`, because they encode for minutes. Run them with the binary under test:
//!
//!   FRONTSTAGE_TEST_FFMPEG=binaries/ffmpeg-x86_64-apple-darwin cargo test ffmpeg_check -- --ignored --nocapture --test-threads=1
//!
//! Two binaries are involved, and it matters which does what:
//! - `app()` is the binary under test. It only runs what the app runs.
//! - `stock()` is apps/desktop's ffmpeg-static. It makes the test media (lavfi, x265, libaom, ...),
//!   measures results (psnr, ssim) and is the baseline.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Instant;

use crate::export::{AudioFormat, Exports, StartOpts};
use crate::frames::{self, Req};
use crate::media::extract_audio;
use crate::project::Authorized;
use crate::proxy::{proxy_path, Proxies};
use crate::tools::{test_generator, Tools};
use crate::util::testutil::TempDir;

fn stock() -> PathBuf {
    test_generator().expect("stock ffmpeg in apps/desktop/node_modules")
}

fn app() -> PathBuf {
    Tools::locate().ffmpeg().expect("ffmpeg under test")
}

fn run(bin: &Path, args: &[&str]) -> (bool, Vec<u8>, String) {
    let o = Command::new(bin).args(args).stdin(Stdio::null()).output().unwrap();
    (o.status.success(), o.stdout, String::from_utf8_lossy(&o.stderr).into_owned())
}

fn banner(path: &Path) -> String {
    run(&stock(), &["-hide_banner", "-i", path.to_str().unwrap()]).2
}

fn stream_line(banner: &str, kind: &str) -> String {
    banner.lines().find(|l| l.starts_with("  Stream #") && l.contains(kind)).unwrap_or("").trim().to_string()
}

/// Average PSNR and SSIM of `a` against `b`, measured by the stock build.
fn psnr_ssim(a: &Path, b: &Path) -> (f64, f64) {
    let (a, b) = (a.to_str().unwrap(), b.to_str().unwrap());
    let (_, _, e) = run(&stock(), &["-hide_banner", "-i", a, "-i", b, "-lavfi", "[0:v]split[a1][a2];[1:v]split[b1][b2];[a1][b1]psnr;[a2][b2]ssim", "-f", "null", "-"]);
    let number_after = |key: &str| e.lines().filter_map(|l| l.split(key).nth(1)).find_map(|v| {
        let v = v.split_whitespace().next()?;
        if v == "inf" { Some(f64::INFINITY) } else { v.parse().ok() }
    });
    (number_after("average:").unwrap_or(f64::NAN), number_after("All:").unwrap_or(f64::NAN))
}

fn cache_key(name: &str) -> String {
    use sha2::{Digest, Sha256};
    crate::util::hex(&Sha256::digest(name.as_bytes()))
}

/// Largest difference between two mono PCM16 WAVs, in sample values, and their lengths.
fn wav_difference(a: &[u8], b: &[u8]) -> (i32, usize, usize) {
    // The header names the muxer's version, so only the data chunk is comparable.
    let samples = |w: &[u8]| -> Vec<i16> {
        let start = w.windows(4).position(|c| c == b"data").map_or(w.len(), |i| i + 8);
        w[start..].chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]])).collect()
    };
    let (a, b) = (samples(a), samples(b));
    let max = a.iter().zip(&b).map(|(x, y)| (*x as i32 - *y as i32).abs()).max().unwrap_or(0);
    (max, a.len(), b.len())
}

const LAVFI_AV: [&str; 8] = ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1", "-t", "1", "-shortest", "-y"];

/// `size`, then the arguments for the stock encoder. All have audio unless they say -an.
const VIDEOS: &[(&str, &str, &str)] = &[
    ("h264.mp4", "320x180", "-c:v libx264 -pix_fmt yuv420p -c:a aac"),
    ("h264.m4v", "320x180", "-c:v libx264 -pix_fmt yuv420p -c:a aac"),
    ("h264-high10.mp4", "320x180", "-c:v libx264 -profile:v high10 -pix_fmt yuv420p10le -c:a aac"),
    ("h264-444-odd.mov", "853x481", "-c:v libx264 -profile:v high444 -pix_fmt yuv444p -c:a aac"),
    ("h264-pq.mov", "320x180", "-c:v libx264 -profile:v high10 -pix_fmt yuv420p10le -color_primaries bt2020 -color_trc smpte2084 -colorspace bt2020nc -c:a aac"),
    ("h264-hlg.mp4", "320x180", "-c:v libx264 -profile:v high10 -pix_fmt yuv420p10le -color_primaries bt2020 -color_trc arib-std-b67 -colorspace bt2020nc -c:a aac"),
    ("h264-pcm24.mov", "320x180", "-c:v libx264 -pix_fmt yuv420p -c:a pcm_s24le"),
    ("h264-alac.mov", "320x180", "-c:v libx264 -pix_fmt yuv420p -c:a alac"),
    ("h264-ac3.mp4", "320x180", "-c:v libx264 -pix_fmt yuv420p -c:a ac3"),
    ("h264-mp3.mp4", "320x180", "-c:v libx264 -pix_fmt yuv420p -c:a libmp3lame"),
    ("h264-opus.mp4", "320x180", "-c:v libx264 -pix_fmt yuv420p -c:a libopus"),
    ("hevc.mp4", "320x180", "-c:v libx265 -tag:v hvc1 -x265-params log-level=error -pix_fmt yuv420p -c:a aac"),
    ("hevc-hev1.mov", "320x180", "-c:v libx265 -x265-params log-level=error -pix_fmt yuv420p -c:a aac"),
    ("hevc-10bit-pq.mov", "320x180", "-c:v libx265 -tag:v hvc1 -x265-params log-level=error:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc -pix_fmt yuv420p10le -color_primaries bt2020 -color_trc smpte2084 -colorspace bt2020nc -c:a aac"),
    ("av1.mp4", "320x180", "-c:v libaom-av1 -cpu-used 8 -pix_fmt yuv420p -c:a aac"),
    ("av1-10bit.mp4", "320x180", "-c:v libaom-av1 -cpu-used 8 -pix_fmt yuv420p10le -c:a aac"),
    ("vp9.mp4", "320x180", "-c:v libvpx-vp9 -pix_fmt yuv420p -c:a aac"),
    ("vp9-10bit.mp4", "320x180", "-c:v libvpx-vp9 -profile:v 2 -pix_fmt yuv420p10le -c:a aac"),
    ("vp9.webm", "320x180", "-c:v libvpx-vp9 -pix_fmt yuv420p -c:a libopus"),
    ("vp8.webm", "320x180", "-c:v libvpx -pix_fmt yuv420p -c:a libvorbis"),
    ("prores-proxy.mov", "320x180", "-c:v prores_ks -profile:v 0 -c:a pcm_s16le"),
    ("prores-hq.mov", "320x180", "-c:v prores_ks -profile:v 3 -c:a pcm_s16le"),
    ("prores-4444.mov", "320x180", "-c:v prores_ks -profile:v 4 -pix_fmt yuva444p10le -c:a pcm_s16le"),
    ("dnxhr.mov", "320x180", "-c:v dnxhd -profile:v dnxhr_lb -pix_fmt yuv422p -c:a pcm_s16le"),
    ("cfhd.mov", "320x180", "-c:v cfhd -pix_fmt yuv422p10le -c:a pcm_s16le"),
    ("dv.mov", "720x480", "-r 30000/1001 -c:v dvvideo -pix_fmt yuv411p -c:a pcm_s16le"),
    ("h264-fullrange.mp4", "320x180", "-c:v libx264 -pix_fmt yuvj420p -c:a aac"),
    ("mjpeg.mov", "320x180", "-c:v mjpeg -pix_fmt yuvj420p -c:a aac"),
    ("mpeg4.mp4", "320x180", "-c:v mpeg4 -c:a aac"),
    ("mpeg2.mov", "320x180", "-c:v mpeg2video -c:a pcm_s16le"),
    ("qtrle.mov", "320x180", "-c:v qtrle -c:a pcm_s16le"),
    ("png.mov", "320x180", "-c:v png -c:a pcm_s16le"),
    ("uyvy.mov", "320x180", "-c:v rawvideo -pix_fmt uyvy422 -c:a pcm_s16le"),
    ("v210.mov", "320x180", "-c:v v210 -c:a pcm_s16le"),
    ("svq1.mov", "320x180", "-c:v svq1 -pix_fmt yuv410p -c:a pcm_s16le"),
    ("h263.3gp", "352x288", "-c:v h263 -c:a aac"),
    ("h264.mkv", "320x180", "-c:v libx264 -pix_fmt yuv420p -c:a flac"),
    ("mpeg4.avi", "320x180", "-c:v mpeg4 -c:a libmp3lame"),
    ("msmpeg4.avi", "320x180", "-c:v msmpeg4 -c:a pcm_s16le"),
    ("wmv2.asf", "320x180", "-c:v wmv2 -c:a wmav2"),
    ("mpeg2.mpg", "320x180", "-c:v mpeg2video -c:a mp2"),
    ("h264.ts", "320x180", "-c:v libx264 -pix_fmt yuv420p -c:a aac"),
    ("mpeg2.mxf", "320x180", "-c:v mpeg2video -c:a pcm_s16le"),
    ("flv1.flv", "320x180", "-c:v flv -c:a libmp3lame"),
];

const AUDIOS: &[(&str, &str)] = &[
    ("s16.wav", "-c:a pcm_s16le"),
    ("s24.wav", "-c:a pcm_s24le"),
    ("f32.wav", "-c:a pcm_f32le"),
    ("alaw.wav", "-c:a pcm_alaw"),
    ("mulaw.wav", "-c:a pcm_mulaw"),
    ("adpcm.wav", "-c:a adpcm_ms"),
    ("a.mp3", "-c:a libmp3lame"),
    ("adts.aac", "-c:a aac"),
    ("aac.m4a", "-c:a aac"),
    ("alac.m4a", "-c:a alac"),
    ("s16.aiff", "-c:a pcm_s16be"),
    ("s24.aiff", "-c:a pcm_s24be"),
    ("alaw.aifc", "-f aiff -c:a pcm_alaw"),
    ("mulaw.aifc", "-f aiff -c:a pcm_mulaw"),
    ("ima4.aifc", "-f aiff -c:a adpcm_ima_qt"),
    ("f32.aifc", "-f aiff -c:a pcm_f32be"),
    ("sowt.aifc", "-f aiff -c:a pcm_s16le"),
    ("a.flac", "-c:a flac"),
    ("vorbis.ogg", "-c:a libvorbis"),
    ("a.opus", "-c:a libopus"),
    ("a.caf", "-c:a pcm_s16le"),
];

#[test]
#[ignore = "encodes for minutes; see the module comment"]
fn format_matrix() {
    let (under_test, baseline) = (app(), stock());
    eprintln!("under test: {}\nbaseline:   {}", under_test.display(), baseline.display());
    let d = TempDir::new("matrix");
    let (cache_app, cache_stock) = (d.path().join("cache-app"), d.path().join("cache-stock"));
    let proxies = Proxies::default();
    let mut failures = vec![];

    eprintln!("\n-- video: proxy conversion, frame sampling and audio extraction through the app's code");
    let mut videos: Vec<(String, String, String)> = VIDEOS.iter().map(|(a, b, c)| (a.to_string(), b.to_string(), c.to_string())).collect();
    videos.push(("h264-rotated90.mp4".into(), "copy".into(), "h264.mp4".into()));
    for (name, size, enc) in &videos {
        let src = d.path().join(name);
        let made = if size == "copy" {
            run(&baseline, &["-y", "-v", "error", "-display_rotation", "90", "-i", d.path().join(enc).to_str().unwrap(), "-c", "copy", src.to_str().unwrap()])
        } else {
            let video = format!("testsrc2=s={size}:r=30:d=1");
            let mut args: Vec<&str> = vec!["-v", "error", "-f", "lavfi", "-i", &video];
            args.extend(LAVFI_AV);
            args.extend(enc.split(' '));
            args.push(src.to_str().unwrap());
            run(&baseline, &args)
        };
        if !made.0 {
            eprintln!("{name:22} NOT MADE by stock: {}", made.2.trim().lines().last().unwrap_or(""));
            failures.push(format!("{name}: test clip could not be made"));
            continue;
        }
        let key = cache_key(name);
        let ours = proxies.ensure(&under_test, &cache_app, &src, &key, &|_| {});
        let theirs = proxies.ensure(&baseline, &cache_stock, &src, &key, &|_| {});
        let source = stream_line(&banner(&src), "Video:");
        let codec = source.split("Video: ").nth(1).unwrap_or("").split(',').next().unwrap_or("").split(" (").next().unwrap_or("").to_string();
        match (&ours, &theirs) {
            (Ok(()), Ok(())) => {
                let (out, base) = (proxy_path(&cache_app, &key), proxy_path(&cache_stock, &key));
                let (psnr, ssim) = psnr_ssim(&out, &base);
                let info = banner(&out);
                let line = stream_line(&info, "Video:");
                // Limited range, as the stock build makes it: not yuvj420p.
                let good_stream = line.contains("Video: h264") && line.contains("yuv420p(") && stream_line(&info, "Audio:").contains("aac");
                // The colour tags the engine reads must match the baseline's too.
                let tags = |l: &str| l.split("yuv420p(").nth(1).and_then(|r| r.split(')').next()).unwrap_or("").to_string();
                let (tags_ours, tags_base) = (tags(&line), tags(&stream_line(&banner(&base), "Video:")));
                let good_stream = good_stream && tags_ours == tags_base;
                let frames = frames::sample_frames(&Req { path: src.to_string_lossy().into_owned(), fps: 2.0, width: 160, max_frames: 2 }, |a| frames::spawn_ffmpeg(&under_test, a));
                let frame_note = match &frames {
                    Ok(f) => format!("{} jpegs", f.len()),
                    Err(e) if e == "not a video file" => "ext not sampled".to_string(),
                    Err(e) => format!("FRAMES FAILED {e}"),
                };
                let (wav_a, wav_b) = (extract_audio(&under_test, src.to_str(), None), extract_audio(&baseline, src.to_str(), None));
                let wav_note = match (&wav_a, &wav_b) {
                    (Ok(a), Ok(b)) => {
                        let (max, la, lb) = wav_difference(a, b);
                        if la != lb || la == 0 || max > 2 {
                            format!("WAV FAILED max diff {max} ({la}/{lb})")
                        } else {
                            format!("wav max diff {max}, {la} samples")
                        }
                    }
                    (a, b) => format!("WAV FAILED app={} stock={}", a.is_ok(), b.is_ok()),
                };
                let bad = !good_stream || !(psnr > 45.0) || frame_note.contains("FAILED") || wav_note.contains("FAILED");
                eprintln!("{name:22} {codec:10} {} psnr {psnr:.2} ssim {ssim:.5}; [{tags_ours}]{}; {frame_note}; {wav_note}", if bad { "FAIL" } else { "ok  " }, if tags_ours == tags_base { String::new() } else { format!(" stock [{tags_base}]") });
                if bad {
                    failures.push(format!("{name}: {line}"));
                }
            }
            _ => {
                eprintln!("{name:22} {codec:10} FAIL app={} stock={}", ours.as_ref().err().map_or("ok", String::as_str).chars().rev().take(200).collect::<String>().chars().rev().collect::<String>(), theirs.is_ok());
                failures.push(name.clone());
            }
        }
    }

    eprintln!("\n-- audio: extraction through the app's code");
    for (name, enc) in AUDIOS {
        let src = d.path().join(name);
        let mut args: Vec<&str> = vec!["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1"];
        args.extend(enc.split(' '));
        args.push(src.to_str().unwrap());
        let made = run(&baseline, &args);
        if !made.0 {
            eprintln!("{name:22} NOT MADE by stock: {}", made.2.trim().lines().last().unwrap_or(""));
            failures.push(format!("{name}: test file could not be made"));
            continue;
        }
        let (a, b) = (extract_audio(&under_test, src.to_str(), None), extract_audio(&baseline, src.to_str(), None));
        match (&a, &b) {
            (Ok(a), Ok(b)) => {
                let (max, la, lb) = wav_difference(a, b);
                let bad = la == 0 || la != lb || max > 2;
                eprintln!("{name:22} {} max diff {max}, {la}/{lb} samples", if bad { "FAIL" } else { "ok  " });
                if bad {
                    failures.push(name.to_string());
                }
            }
            (Err(e), _) => {
                eprintln!("{name:22} FAIL {}", e.chars().rev().take(200).collect::<String>().chars().rev().collect::<String>());
                failures.push(name.to_string());
            }
            (_, Err(e)) => eprintln!("{name:22} stock failed too: {e}"),
        }
    }

    // The app shows images in the webview and never hands them to ffmpeg, so these only record what
    // each binary can read. HEIC comes from macOS's own encoder.
    eprintln!("\n-- images: not an app path, decode capability only");
    let png = d.path().join("i.png");
    assert!(run(&baseline, &["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=640x360:d=0.04", "-frames:v", "1", png.to_str().unwrap()]).0);
    let jpg = d.path().join("i.jpg");
    assert!(run(&baseline, &["-y", "-v", "error", "-i", png.to_str().unwrap(), jpg.to_str().unwrap()]).0);
    let jpeg = d.path().join("i.jpeg");
    std::fs::copy(&jpg, &jpeg).unwrap();
    let tiff = d.path().join("i.tiff");
    assert!(run(&baseline, &["-y", "-v", "error", "-i", png.to_str().unwrap(), "-compression_algo", "lzw", tiff.to_str().unwrap()]).0);
    let heic = d.path().join("i.heic");
    let sips = Command::new("/usr/bin/sips").args(["-s", "format", "heic", png.to_str().unwrap(), "--out", heic.to_str().unwrap()]).stdout(Stdio::null()).stderr(Stdio::null()).status();
    assert!(sips.is_ok_and(|s| s.success()));
    for img in [&png, &jpg, &jpeg, &tiff, &heic] {
        let args = ["-v", "error", "-i", img.to_str().unwrap(), "-frames:v", "1", "-f", "image2pipe", "-vcodec", "mjpeg", "-q:v", "2", "pipe:1"];
        let (a, b) = (run(&under_test, &args), run(&baseline, &args));
        eprintln!("{:22} app {} stock {}", img.file_name().unwrap().to_str().unwrap(), if a.0 && !a.1.is_empty() { "ok" } else { "no" }, if b.0 && !b.1.is_empty() { "ok" } else { "no" });
        if !(a.0 && !a.1.is_empty()) && img.extension().unwrap() != "heic" {
            failures.push(format!("{}: {}", img.display(), a.2));
        }
    }

    eprintln!("\n-- subtitles: read and written as mov_text");
    let srt = d.path().join("s.srt");
    std::fs::write(&srt, "1\n00:00:00,000 --> 00:00:01,000\nHello\n").unwrap();
    let vtt = d.path().join("s.vtt");
    std::fs::write(&vtt, "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello\n").unwrap();
    for (sub, fmt) in [(&srt, "srt"), (&vtt, "webvtt")] {
        let out = d.path().join(format!("{fmt}.mp4"));
        let r = run(&under_test, &["-y", "-v", "error", "-f", fmt, "-i", sub.to_str().unwrap(), "-c:s", "mov_text", out.to_str().unwrap()]);
        let ok = r.0 && banner(&out).contains("Subtitle: mov_text");
        eprintln!("{:22} {}", sub.file_name().unwrap().to_str().unwrap(), if ok { "ok" } else { "FAIL" });
        if !ok {
            failures.push(format!("{fmt}: {}", r.2));
        }
    }
    assert!(failures.is_empty(), "failed: {failures:#?}");
}

/// Top-level box types of an MP4, in file order.
fn top_level_boxes(path: &Path) -> Vec<String> {
    let bytes = std::fs::read(path).unwrap();
    let mut out = vec![];
    let mut i = 0usize;
    while i + 8 <= bytes.len() {
        let mut size = u32::from_be_bytes(bytes[i..i + 4].try_into().unwrap()) as usize;
        if size == 1 {
            size = u64::from_be_bytes(bytes[i + 8..i + 16].try_into().unwrap()) as usize;
        }
        out.push(String::from_utf8_lossy(&bytes[i + 4..i + 8]).into_owned());
        if size < 8 {
            break;
        }
        i += size;
    }
    out
}

fn export_with(bin: &Path, codec: &str, width: usize, height: usize, fps: f64, frames: &[u8], pcm: &[u8], srt: Option<&str>, out: &Path) -> f64 {
    let a = Authorized::default();
    a.add(out.parent().unwrap());
    let x = Exports::default();
    let started = Instant::now();
    x.start(&a, Some(bin.to_path_buf()), StartOpts {
        width: width as i64,
        height: height as i64,
        fps,
        audio: Some(AudioFormat { sample_rate: 48000, channels: 2 }),
        codec: codec.into(),
        out_path: out.to_str().unwrap().into(),
        subtitles_srt: srt.map(str::to_string),
    }).unwrap();
    for frame in frames.chunks(width * height * 4) {
        x.video_frame(frame).unwrap();
    }
    x.audio_data(pcm).unwrap();
    x.finish().unwrap();
    started.elapsed().as_secs_f64()
}

fn audio_difference(a: &Path, b: &Path) -> (usize, usize, f64) {
    let pcm = |p: &Path| -> Vec<f32> {
        run(&stock(), &["-v", "error", "-i", p.to_str().unwrap(), "-vn", "-f", "f32le", "-ac", "2", "-ar", "48000", "pipe:1"]).1.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()
    };
    let (a, b) = (pcm(a), pcm(b));
    let n = a.len().min(b.len()).max(1);
    let rms = (a.iter().zip(&b).map(|(x, y)| ((x - y) as f64).powi(2)).sum::<f64>() / n as f64).sqrt();
    (a.len(), b.len(), rms)
}

/// FRONTSTAGE_TEST_YT_CLIP names a real clip. The same decoded frames and audio go through the real export
/// code twice, once with each binary.
#[test]
#[ignore = "encodes for minutes; see the module comment"]
fn youtube_preset_matches_stock() {
    let clip = std::env::var("FRONTSTAGE_TEST_YT_CLIP").expect("FRONTSTAGE_TEST_YT_CLIP");
    let (start, secs) = (std::env::var("FRONTSTAGE_TEST_YT_START").unwrap_or("30".into()), std::env::var("FRONTSTAGE_TEST_YT_SECS").unwrap_or("10".into()));
    let (under_test, baseline) = (app(), stock());
    eprintln!("under test: {}\nbaseline:   {}", under_test.display(), baseline.display());
    let d = TempDir::new("youtube");

    let decode = |vf: &str| run(&baseline, &["-v", "error", "-ss", &start, "-t", &secs, "-i", &clip, "-an", "-vf", vf, "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"]).1;
    let pcm = run(&baseline, &["-v", "error", "-ss", &start, "-t", &secs, "-i", &clip, "-vn", "-f", "f32le", "-ac", "2", "-ar", "48000", "pipe:1"]).1;
    // Ends well before the video does, which must not shorten the export.
    let srt = "1\n00:00:00,000 --> 00:00:02,000\nHello\n";

    let frames = decode("scale=1920:1080");
    let (w, h) = (1920usize, 1080usize);
    let fps = banner(Path::new(&clip)).lines().find(|l| l.contains("Video:")).and_then(|l| l.split(", ").find_map(|f| f.strip_suffix(" fps").map(str::to_string))).and_then(|f| f.parse::<f64>().ok()).unwrap();
    eprintln!("{} frames at {fps} fps, {} s of audio", frames.len() / (w * h * 4), pcm.len() / (48000 * 8));
    let (ours, theirs) = (d.path().join("trimmed.mp4"), d.path().join("stock.mp4"));
    let t_stock = export_with(&baseline, "libx264_youtube", w, h, fps, &frames, &pcm, Some(srt), &theirs);
    let t_ours = export_with(&under_test, "libx264_youtube", w, h, fps, &frames, &pcm, Some(srt), &ours);
    drop(frames);
    for (name, f, secs) in [("stock", &theirs, t_stock), ("under test", &ours, t_ours)] {
        let info = banner(f);
        eprintln!("\n{name}: {} bytes, {secs:.1} s\n  {}\n  {}\n  {}\n  boxes {:?}", std::fs::metadata(f).unwrap().len(), stream_line(&info, "Video:"), stream_line(&info, "Audio:"), stream_line(&info, "Subtitle:"), top_level_boxes(f));
    }
    let (psnr, ssim) = psnr_ssim(&ours, &theirs);
    let (la, lb, rms) = audio_difference(&ours, &theirs);
    eprintln!("\nyoutube preset, under test vs stock: PSNR {psnr:.3} dB, SSIM {ssim:.6}; audio {la}/{lb} samples, RMS difference {rms:.6}");

    let info = banner(&ours);
    let video = stream_line(&info, "Video:");
    let audio = stream_line(&info, "Audio:");
    assert!(video.contains("h264 (High)") && video.contains("yuv420p(tv, bt709, progressive)") && video.contains("1920x1080"), "{video}");
    assert!(audio.contains("aac") && audio.contains("48000 Hz") && audio.contains("stereo"), "{audio}");
    // -b:a 320k is a target for ffmpeg's AAC encoder. Both builds must land on the same rate.
    assert_eq!(audio.split(", ").last(), stream_line(&banner(&theirs), "Audio:").split(", ").last(), "{audio}");
    assert!(stream_line(&info, "Subtitle:").contains("mov_text"));
    let boxes = top_level_boxes(&ours);
    let at = |b: &str| boxes.iter().position(|x| x == b).unwrap_or(usize::MAX);
    assert!(at("moov") < at("mdat"), "not faststart: {boxes:?}");
    assert!(psnr > 45.0 && ssim > 0.99, "psnr {psnr} ssim {ssim}");
    let wanted_samples = secs.parse::<f64>().unwrap() * 48000.0 * 2.0;
    assert!((la as f64 - wanted_samples).abs() < 48000.0, "{la} samples, wanted about {wanted_samples}");
    // Different AAC encoder builds aren't bit-identical, but they must be close.
    assert!(la.abs_diff(lb) <= 4096 && rms < 0.02, "{la} {lb} {rms}");

    // The two other presets, on a smaller picture.
    let small = decode("scale=640:360");
    for (codec, ext, profile) in [("libx264", "mp4", "h264"), ("prores_ks", "mov", "prores")] {
        let (a, b) = (d.path().join(format!("a.{ext}")), d.path().join(format!("b.{ext}")));
        export_with(&under_test, codec, 640, 360, fps, &small, &pcm, None, &a);
        export_with(&baseline, codec, 640, 360, fps, &small, &pcm, None, &b);
        let (psnr, ssim) = psnr_ssim(&a, &b);
        let info = banner(&a);
        eprintln!("{codec}: {} | {} | PSNR {psnr:.2} SSIM {ssim:.5}", stream_line(&info, "Video:"), stream_line(&info, "Audio:"));
        assert!(stream_line(&info, "Video:").contains(profile) && stream_line(&info, "Video:").contains("bt709,") && stream_line(&info, "Video:") == stream_line(&banner(&b), "Video:"), "{}", stream_line(&banner(&b), "Video:"));
        assert!(psnr > 40.0, "{codec} {psnr}");
    }
}
