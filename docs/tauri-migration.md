# Moving the desktop app from Electron to Tauri

Goal: a much smaller download and install. The React UI stays. Electron's Node main process becomes
Rust, and `apps/studio-tauri` lives beside `apps/desktop` until it reaches parity.

## Phase 0 results (macOS 13.7.8, Intel dual-core m3, Safari 18.6)

| Measure | Electron 31 | Tauri 2 (WebKit) |
|---|---|---|
| Installed app | 585 MB | 84 MB (spike: shell + ffmpeg, no full UI, no ffprobe) |
| DMG | 234 MB | 31 MB (same caveat) |
| Peak memory, summed RSS, bench run | 372 MB | 540 MB |
| H.264 1080p decode only | 153 fps | 141 fps |
| Video to WebGL, `texImage2D(VideoFrame)`, 540p | 191-209 fps | 14-15 fps |
| Video to WebGL, `copyTo` + plane upload, 540p | 46-48 fps | 48-58 fps |
| Video to WebGL, `copyTo` + plane upload, 1080p | 43 fps | 40 fps |

These are one-layer numbers. WebKit ran with `visibilityState: hidden` (timers 10x slow), so WebKit
figures may be conservative. Multi-layer compositions have not been measured yet.

Decisions and limits that follow from this:
- **Memory is not expected to improve.** The move reduces disk size, not RAM.
- **Upload path:** on WebKit, upload I420/NV12 planes and convert in the shader. `texImage2D(VideoFrame)`
  is too slow on this Mac.
- **Audio:** `crossOriginIsolated` stays false on `tauri://`, even with COOP/COEP set. It's true on a
  loopback http origin, but that needs a local server and remote IPC permissions. We keep `tauri://`
  and use a `MessagePort` audio ring where `SharedArrayBuffer` is missing.
- **Decode:** H.264 and 8-bit VP9 work. The HEVC and AV1 config checks throw `TypeError`, so those sources
  need an H.264 proxy. Phase 1 adds more cases to that list.
- **Export:** 300 frames through raw IPC to ffmpeg gave a valid 10 s 1080p MP4 at 1.5 fps using
  `libx264_youtube` settings (preset slow). `readPixels` averaged 92 ms per frame and the frame send
  averaged 112 ms. IPC alone reached about 20 frames/s at 8.3 MB per frame.

## Phase 1 results

`createRenderer` picks WebGPU when an adapter exists, otherwise `WebGL2Renderer`. `AudioGraph` uses a
`MessagePort` worklet where `SharedArrayBuffer` is missing. WebGPU, SAB and `AudioDecoder` paths are unchanged.

**Audio decode, final choice: `AudioContext.decodeAudioData` on the source bytes, with no Rust hook.** On
`tauri://` it decoded AAC at 44.1 kHz mono and 48 kHz stereo at the track's own rate and channel count, with
burst onsets within 0.02 ms of ffmpeg and zero sample shift. A 7.1 MB 1080p file took 35-46 ms. It has not been
tried on a long file; the whole file and its PCM are held in memory, as they already were with `AudioDecoder`.

### Tests

- Parity: `pnpm -F @frontstage/engine-harness exec playwright test -c playwright.headless.config.ts parity`.
  118 fixtures through both backends in Chromium: 64 exact, 47 within 1 level, 7 above that (below).
- The same fixtures on WebKit against Chromium's WebGPU output (`apps/studio-tauri/src/phase1.ts`), on
  `tauri://`: 115 of 118 ran and none failed. Of the 103 fixtures compared strictly, 57 are exact and 44 within 1
  level. The 3 skipped can't be built by hand on WebKit (BT.2020 tags, odd-sized I420, `visibleRect` offset), so
  real clips cover them below.
- Tolerance is 2 levels per channel, widened to 4 for `multi-layer-3`, `same-frame-twice` and
  `source-i420-odd-size`. All three resample CPU-backed YUV, where Chromium's reference goes through an RGBA8
  intermediate and WebGL2 stays in float.
- Report-only: `blend-colorBurn/colorDodge/hue-yuv-top` (max 204/5/23, same RGBA8 cause, at near-neutral values
  where those blends are singular) and `source-raw-rgbx-stray-x-byte` (Chromium uses a non-255 X byte as alpha).
  `effect-grain` is report-only too and matched exactly on both, so the sin-hash doesn't differ here.
- Text and decoded H.264 can't match across browsers because their source pixels differ. WebKit text matches its
  own raster within 0.6 levels. A real 1080p frame matches ffmpeg with a mean difference of 0.39 levels.

### Real encoded clips on WKWebView

Each clip went through the engine's real path (demux, `VideoDecodeManager`, compositor, `composite`) and was
compared with an ffmpeg decode of the same frame, on `tauri://`. The white marker's position was checked against
where it was drawn. "Mean" is mean absolute difference in levels.

| Clip | Result | Marker | Mean | Outcome |
|---|---|---|---|---|
| H.264 8-bit BT.709 640x360 | correct | exact | 0.08 | works |
| H.264 8-bit 854x482 | correct | exact | 0.06 | works |
| VP9 8-bit BT.709 640x360 | correct | exact | 0.06 | works |
| VP9 8-bit 853x481 (odd) | correct | exact | 0.15 | engine fix: WebKit rounds odd chroma down |
| H.264 8-bit BT.601, tagged | correct matrix, sRGB gamut | exact | 0.40 | engine fix: WebKit tags every frame BT.709 |
| H.264 8-bit SD, untagged | treated as BT.601, like Chromium | exact | 0.40 | engine fix |
| H.264 8-bit BT.2020 SDR | correct matrix, sRGB gamut | exact | 1.11 | engine fix |
| H.264 left/top SPS crop | picture shifted by the crop offset, pad visible | off by (8,6), (64,48) | - | **proxy** |
| H.264 10-bit, BT.709/PQ/HLG | reports supported, decodes to garbage | lost | 68 | **proxy** |
| H.264 4:4:4 853x481 | reports supported, never configures | - | - | **proxy** |
| HEVC 8-bit, 10-bit PQ | config check throws, also with the real `hvcC` | - | - | **proxy** |
| AV1 8-bit | config check throws, also with the real `av1C` | - | - | **proxy** |
| VP9 10-bit PQ | reports unsupported | - | - | **proxy** |

For a clip marked **proxy**, nothing wrong is shown: the compositor warns and skips it, leaving that layer empty.
For the H.264 cases, `VideoDecodeManager.create` throws `EngineUnsupported` with a reason from `videoProxyReason`,
which Phase 2 can use for its message. Phase 2 needs the H.264 conversion on import for all of them.

The BT.601 and BT.2020 means are against ffmpeg's matrix-only conversion. The difference is the gamut step, which
matches Chromium's output, for example BT.2020 red is (255,0,0) on both.

An odd-sized 4:2:0 H.264 can't exist: x264 refuses to encode it, since SPS crop units are 2 samples.

### Open decision: midtones differ from WebGPU on hardware-decoded video

On macOS, Chromium's `importExternalTexture` treats hardware-decoded (NV12) SDR video as gamma 1.961 and
re-encodes it to sRGB, which lifts midtones: grey 128 becomes 139, 50 becomes 57, 230 becomes 233. Software-decoded
frames don't get this, and neither does WebKit, so WebKit matches ffmpeg and differs from this path by up to 11
levels. The parity suite doesn't catch it because its 320x240 fixture decodes in software here. This was measured
in Chromium, not Electron. Matching it would be a small stage in `toOutput`, but would move WebKit away from
ffmpeg, so it has been left for review.

### Also found

- Chromium's hardware decode on macOS drops left/top SPS crop too (same shift, same pad). That path is unchanged.
- The demuxer gives no `description` for HEVC, so HEVC can't decode through the engine in Chromium either.
- `OffscreenCanvas` has no WebGL2 context on WebKit, so export renders to a detached canvas element.
- `new VideoFrame(canvas)` on an undisplayed WebGL canvas throws "Canvas has no frame", so WebGL2 sinks use `readRGBA`.
- 2D canvas has no `filter`, so text blur runs on the CPU (`blurRGBA`). Against a real canvas blur in Chromium:
  alpha mean difference 1.2, max 20.
- Decoded H.264 arrives as full-range I420 tagged `fullRange: true`, so planes differ from Chromium's.
- Existing behaviour reproduced, not fixed: `importExternalTexture` returns premultiplied colour for frames with
  alpha, and `ALPHA_BLEND` multiplies by alpha again, so soft text edges come out darker than a straight blend.
- `AudioDecoder` in Chromium keeps 1024 priming samples (21-23 ms late against ffmpeg). `decodeAudioData` lines
  up with ffmpeg. The web and Electron paths are unchanged.

### WebKit fps

WebGL2 through the real `composite()`, on `tauri://`, in a hidden window, with one H.264 decoder per layer and the
GPU finished each frame. Each cell is a quiet run / a run with the Mac under heavy outside load (load average
about 100). The quiet run predates the last decoder changes, which don't touch the render path. Quiet runs varied
by up to about 50% in the 3-layer rows.

| Render size / source | 1 layer | 2 layers | 3 layers | 1 layer + 3 colour + gaussian |
|---|---|---|---|---|
| 540p / 540p | 176.5 / 95.9 | 97.5 / 57.4 | 72.6 / 42.0 | 53.4 / 48.4 |
| 540p / 1080p | 87.5 / 57.4 | 48.4 / 26.7 | 21.2 / 13.3 | 37.2 / 30.4 |
| 1080p / 1080p | 58.2 / 36.7 | 33.3 / 10.5 | 23.3 / 8.8 | 15.8 / 14.0 |

Playback through `PlaybackEngine` at 640x360 from the 1080p clip, with `requestAnimationFrame` driven by a message
loop because it doesn't fire in the hidden window: 174 of 174 frames at 29.9 fps quiet, 154 of 186 under load. No
audio underruns in either.

### Not proven

- Audible sound. Automated runs checked the clock, buffers, and a 439 Hz tone on the worklet's output, not speakers.
- Display and timing in a visible window. Every number above is from a hidden window, and playback used a stand-in
  for `requestAnimationFrame`.
- Electron itself. WebGPU was checked in Playwright's Chromium, and only one Mac was tested.
- Long files through `decodeAudioData`, and a full-length 1080p export through the real ffmpeg sink.
- Other WebKit versions. The rejection rule and colour fixes were tested on macOS 13.7 / Safari 18.6 only, and a
  newer WebKit that decodes these streams correctly would still be sent to the proxy.
- `audio-graph.spec.ts` is unreliable: the SAB test failed on first run on the unmodified Phase 0 commit too, and
  both tests failed under heavy load.

Test media comes from `apps/studio-tauri/scripts/gen-clips.py`; none of it is committed.

## Phase 2 results

`apps/studio-tauri` now runs the real editor from `apps/desktop/src/renderer` on `tauri://`. Electron's main process is
Rust modules in `src-tauri/src`, and `src/tauri-bridge.ts` exposes the same `window.desktop*` objects as the preload.

| Size, macOS x64 | |
|---|---|
| Release binary before (Phase 1 shell with its test pages) | 9.03 MB |
| Release binary now, with the full editor UI | 9.28 MB |
| `Frontstage.app` now, without ffmpeg | 9.0 MB |
| ffmpeg and ffprobe, not bundled until Phase 3 | 78.9 MB and 62.2 MB |

Phase 3 bundles ffmpeg and removes ffprobe. Before that, a release app needed both binaries copied in by hand.

The UI adds so little because onnxruntime's 21.6 MB wasm is left out of the bundle: transformers.js always sets its
`wasmPaths` to the CDN, so the copy Vite adds is never loaded.

### Dependencies

Each is justified in `src-tauri/Cargo.toml`. Tauri's default features are off. `ureq` replaces `reqwest` from the plan: it's
smaller, uses the OS TLS stack through native-tls, and has a resolver hook for DNS pinning. That hook is outside ureq's
semver promise, so ureq is pinned exactly. `tiny_http` serves MCP and the OAuth redirect. `rfd` replaces the dialog plugin.

### Tests

- `cargo test` in `src-tauri`. Mock HTTP only; a real Keychain round trip under a throwaway service name; real ffmpeg
  and the official MCP SDK when the repo's `node_modules` are installed.
- `test/bridge-parity.test.ts` compares the bridge with the preload and with the registered Rust commands.
- `scripts/smoke.sh` drives the real editor in a hidden WKWebView, in a test build:
  `VITE_TEST_PAGES=1 pnpm build:web`, `cargo build --features webkit-tests`, then `scripts/smoke.sh <scratch-dir>`.

`desktop-interop-export` and `desktop-project-nav` stay in vitest. They test renderer TypeScript that this app runs
unchanged, so a Rust copy would test nothing the app uses. Their Rust halves have their own cargo tests.

The test pages and spike commands exist only with `--features webkit-tests` and `VITE_TEST_PAGES=1`.

### H.264 conversion

Clips the webview can't decode (`videoDecodeProblem`) are converted when imported, or when first read after a reopen. The
proxy is in the app's cache, named from the source's content. The manifest and the project's media file don't change, and
uploads and interchange exports still use the original. Preview and export read the proxy, so an export of such a clip is
a generation further from the source (CRF 16, preset veryfast). The cache isn't size-limited yet.

### Behaviour that differs from Electron

- Morphic sign-in sends and checks an OAuth `state`. Electron sent none. Not yet tried against the real server.
- fal and Morphic result downloads go through the SSRF guard. Electron's fal download had no guard.
- Claude's text after a mid-stream fallback block is the answer. Electron joined it to the declined model's partial text,
  which could never parse.
- The local MCP server answers with `application/json` and returns 405 to GET and DELETE. Electron's SDK server answered
  with SSE. Both are allowed by the spec, and the official client works against it.
- Long secrets are split across several entries, because Windows limits each to 2560 bytes.
- Keys, Morphic sign-in, recents, the MCP token and window state start empty: this app has its own data folder and
  Keychain service. Keys can't be carried over, so a notice asks the user to re-enter them.
- The macOS menu has its own app menu, so File no longer appears under the app's name. Force Reload and Toggle DevTools
  are gone.
- wry doesn't implement `alert`, `confirm` or `prompt`, which silently answered no. `js_dialogs.rs` adds them on macOS.

## Phase 3 results

### Size, macOS x64

| | Electron | Stock ffmpeg, computed | Now | Target |
|---|---|---|---|---|
| Installed app | 585 MB | about 88 MB (9.3 + 78.9) | **23.2 MiB** (`du`: 23,760 KB) | 100 MB or less |
| DMG | 234 MB | about 31 MB (Phase 0 spike) | **8.3 MiB** (8,703,513 bytes) | about 40 MB or less |
| ffmpeg | 78.9 MB | 78.9 MB | 14.9 MB (14,885,024 bytes) | |
| ffprobe | 62.2 MB | none | none | |

Those are the shipping build, unsigned. The app binary is 9.3 MB. The stock column wasn't built, except for the spike's DMG.

### The bundled ffmpeg

`scripts/build-ffmpeg.sh <triple>` builds FFmpeg 7.1.5, x264, dav1d 1.5.4 and zimg 3.0.6 from pinned commits and checksums into
`src-tauri/binaries/` (gitignored). `pnpm bundle` adds it through `tauri.bundle.conf.json`, so it lands at
`Frontstage.app/Contents/MacOS/ffmpeg`, which is the only place `tools.rs` looks in a shipped build. PATH is never searched.
The separate config keeps `cargo build` and `cargo test` working on a checkout with no binary. Use `CI=true` when bundling, which
makes Tauri's DMG step skip its Finder scripting, so no window opens.

| | Stock (ffmpeg-static 6.1.1) | Trimmed |
|---|---|---|
| Decoders / encoders | 522 / 210 | 99 / 6 |
| Formats | 408 | 39 |

- **Time:** 23.6 minutes for a full x64 build at `-j2` under heavy outside load (x264 1.3, dav1d 6, zimg 2, ffmpeg 14), and
  6 minutes for ffmpeg alone with the libraries kept.
- **System libraries:** nothing beyond what macOS ships: libSystem, libc++, libz, CoreFoundation, CoreVideo and CoreMedia.
- **Deployment target:** `minos 13.0`. It has only run on 13.7.8.
- **No network protocols:** only `file` and `pipe`, so a crafted file can't make ffmpeg fetch anything.
- **Dropped and not missed by any test:** Hap (needs snappy), hardware decoding and the rarer codecs. A clip in a dropped codec
  fails conversion with ffmpeg's error, where stock would have converted it.

**Apple Silicon:** the same script cross-compiles from this Intel Mac in 13 minutes to a 10.3 MB ad-hoc-signed binary with `minos 13.0` and the same system libraries. It can't run here (`bad CPU type`), so it has never been executed. No arm64 app or DMG has been built.

### Format matrix

`FRONTSTAGE_TEST_FFMPEG=<binary> cargo test ffmpeg_check::format_matrix -- --ignored --nocapture --test-threads=1` runs each file through
the app's real conversion, frame sampling and audio extraction, with both binaries. Everything passed. Clips are 1 s of synthetic video
with a 440 Hz tone, made by the stock build. No camera originals were available.

- **Video, 45 files, all PSNR inf and SSIM 1.0 against stock's proxy, with the same colour tags:** H.264 (8-bit, High 10, 4:4:4 at an odd size,
  full range, PQ, HLG, rotated), H.264 with PCM, ALAC, AC-3, MP3 and Opus audio, HEVC (hvc1, hev1, 10-bit PQ), AV1 (8, 10-bit), VP9 (8, 10-bit, WebM), VP8,
  ProRes (Proxy, HQ, 4444), DNxHR, CineForm, DV, MJPEG, MPEG-4, MPEG-2, QuickTime RLE, PNG, UYVY, v210, SVQ1, H.263 in 3GP, and the
  MKV, AVI, ASF, MPEG-PS, MPEG-TS, MXF, FLV and M4V containers.
- **Audio, 21 files, within 1 sample value of stock, same lengths:** WAV (s16, s24, f32, A-law, mu-law, ADPCM), MP3, ADTS AAC, M4A (AAC, ALAC),
  AIFF (s16, s24), AIFC (A-law, mu-law, IMA4, f32, sowt), FLAC, Vorbis, Opus, CAF.
- **Images:** PNG, JPG, JPEG and TIFF decode. HEIC from macOS's `sips` decodes on the trimmed build and not on stock. The app shows images in the
  webview and never hands them to ffmpeg, so this only records capability.
- **Subtitles:** SRT and VTT read and written as `mov_text`.

Two binaries, and it matters which is which: `apps/desktop`'s stock ffmpeg makes the test media and takes the measurements, in `smoke.sh` and in the
cargo tests, because it has lavfi, x265 and libaom. The trimmed one is what the app runs. `tools::test_generator` and `$FF` are stock;
`Tools::locate` and `FRONTSTAGE_TEST_FFMPEG` are the binary under test. `env.tools.ffmpegPath` in the smoke result names the file the app ran.

### YouTube preset against stock

The same frames and audio, from 10 s of the Sintel trailer at 1080p24 (`sintel_trailer-1080p.mp4` from download.blender.org, CC-BY), with an SRT, through the real
`Exports` code with each binary.

| | Stock | Trimmed |
|---|---|---|
| Video | h264 High, yuv420p(tv, bt709), 1920x1080, 5013 kb/s | identical |
| Audio | aac LC, 48000 Hz, stereo, 309 kb/s | identical |
| Subtitles | mov_text | identical |
| Boxes | ftyp, moov, free, mdat (faststart) | identical |
| File | 6,663,938 bytes | 6,663,923 bytes |

PSNR is inf and SSIM is 1.000000, so the decoded video is the same, and the audio's RMS difference is 0. The 15 bytes are ffmpeg's version strings. The two
builds' x264 produce the same pictures here. 309 kb/s is ffmpeg's AAC encoder on this audio with `-b:a 320k`, on both builds.
`libx264` and `prores_ks` also match stock (at 640x360), with the same stream line. The test is `ffmpeg_check::youtube_preset_matches_stock`.

### What moving to ffmpeg 7 would have broken

Each of these passed or would have passed a weaker check. The tests now catch them.

- **Colour tags:** ffmpeg 7 takes tags from the frames and ignores `-color_primaries` and `-color_trc` on the encoder, so exports came out `bt709/unknown/unknown`.
  The tags now come from `setparams` in the filter, which both versions honour. Electron still uses the old arguments with ffmpeg 6.
- **Full-range sources:** `format=yuv420p` no longer converts them to limited range, so MJPEG proxies differed (PSNR 43.5) and were tagged full range.
  `proxy_args` now asks for it with `scale=out_range=tv`.
- **Banner layout:** stream metadata is indented 8 spaces, not 6.
- **configure ignores unknown names silently:** the encoder is `movtext`, not `mov_text`. The script now checks that every name it asked for was enabled.

### Bug found: captions cut exports short

`-shortest` counts the subtitle track, so an export with captions ended at the last caption. A 10 s YouTube export with a caption ending at 2 s came out 2 s long, on
stock too. Tauri now ends a captioned export at the video's length with `-t`. **Electron has the same bug and isn't changed**
(`apps/desktop/src/main/export-codecs.mjs`).

### ffprobe

`media_read_timecode` now parses `ffmpeg -i`. The renderer's `parseTimecodeTag` only uses the rate rounded to a whole number, so the banner's two decimals are enough. The cargo tests port the
old cases and add real tagged clips at 30, 29.97 DF, 23.976, 25 and 59.94 DF. Tags and rounded rates match what the old ffprobe printed for the same clips, and MKV, WebM and MXF
file-level tags are ignored by both. The smoke run read `01:00:00:00` at 30 fps through the packaged app.

Known differences from ffprobe:
- A file with a tmcd track and no video stream gives no timecode, so it exports from 0. ffprobe read the track's own rate.
- A variable rate within 0.005 of x.5 could round the other way.

`apps/desktop` keeps both its binaries. `smoke.sh` still uses its ffprobe to check results.

### Licence obligations

The trimmed binary is built with `--enable-gpl` and includes x264, so it is **GPL-2.0-or-later** as a whole. dav1d is BSD-2-Clause and zimg is WTFPL. Frontstage itself is GPLv3, which is compatible. No non-free option is enabled.
To distribute the DMG:

1. **Licence text and notices:** in the app at `Contents/Resources/licenses/` (`GPL-3.0.txt`, `NOTICE.txt`, `THIRD-PARTY-NOTICES.txt` with dav1d's and zimg's licences). The About panel points there.
2. **Corresponding source, which is the one not yet in place:** publish the exact sources and build script next to each download. `SOURCE_ARCHIVE=1 scripts/build-ffmpeg.sh` makes `binaries/ffmpeg-sources.tar.xz`, and the installer
   workflow uploads it. The notice promises this, so a release that omits it breaks the notice. Links to upstream alone aren't a safe substitute, because the distributor stays responsible for them staying available.
3. **Frontstage's own source** at the same version, as for any GPL release. No extra restrictions on recipients.

Patents are separate from all of this: H.264, HEVC and AAC may need licences in some countries, for whoever distributes. This isn't legal advice, and a person should decide on patents before a wider release.
The Windows build uses a stock binary with many more bundled libraries, so its source obligation is harder: see below.

### Minimum macOS: 13.7

`bundle.macOS.minimumSystemVersion` was 13.0, whose Safari 16.1 predates WebCodecs. It's now 13.7.

| Needed | Safari, per MDN browser-compat-data 8.1.8 | Measured in WKWebView here (13.7.8, Safari 18.6) |
|---|---|---|
| `VideoDecoder`, `VideoFrame.copyTo` | 16.4 | present, and it decodes |
| `OffscreenCanvas` 2D | 16.4 | present |
| `OffscreenCanvas` WebGL2 | 17, not needed | absent, the engine uses a detached canvas |
| `AudioWorklet` | 14.1 | present |
| WebGL2 | 15 | present |

- **From documentation:** the API floor is Safari 16.4. A text scan of the bundle found nothing else newer than that (`Promise.withResolvers`, `Object.groupBy` and others are absent), but a scan can't see everything. Safari 16.4 shipping with
  macOS 13.3 is from memory: Apple's page couldn't be read during this work. So the documented floor is about 13.3. Safari 18.1 on 13.7.1 is from Eclectic Light's report.
- **Measured:** this Mac only. `WebKit.framework` here is 18615.3.12, which is Safari 18.6, so a Safari update changes what WKWebView runs.
- **Why 13.7 and not 13.3:** nothing has run on WebKit 16.4 to 18.5, and the engine's fixes (the decode rejection rule, colour handling, odd chroma) were all worked out on 18.6. BCD describes Safari, not WKWebView. Every Mac on Ventura can update to 13.7 for free, so the
  cost is small, and the cost of guessing wrong is wrong pictures. Lower it after a real run on an older system.
- **Limits of this:** the OS version doesn't pin WebKit, since Safari updates separately. Macs on 13.7 with an older Safari, and macOS 14, 15 and 26, pass the check and are untested. Newer WebKit has WebGPU and `AudioDecoder`, so
  those Macs would take different engine paths than the ones measured.

### Windows: untested and uncompiled

Nothing for Windows has been compiled, installed or run. These are in place and unproven:

- `.github/workflows/tauri-installers.yml`, run by hand and producing artifacts only. It has never run, for any platform.
- `tauri.bundle.windows.conf.json`, `icons/icon.ico` (one 256x256 PNG) and `scripts/fetch-ffmpeg.mjs`, which fetches stock FFmpeg 6.1.1 essentials (gyan.dev, through ffmpeg-static's release, SHA-256 pinned, 29.6 MB compressed).
- `tools::command` sets `CREATE_NO_WINDOW`, so a console shouldn't open for each ffmpeg run.

Before shipping it: run the format matrix on Windows, and either publish source for every library in that stock build or build a trimmed one. The trimmed script is macOS only.

### Verification

- `pnpm turbo run test typecheck --concurrency=1`: 20 of 20 tasks, 3,090 tests. 18 tasks came from turbo's cache, since this phase changed only `apps/studio-tauri`.
- `cargo test`: 204 passed, 2 ignored (the checks above), with stock and with `FRONTSTAGE_TEST_FFMPEG` set to the trimmed build.
- `scripts/smoke.sh <dir> <...>/Frontstage.app/Contents/MacOS/frontstage`: a packaged release build with `--features webkit-tests`, whose result names `Contents/MacOS/ffmpeg` as the binary it ran. 30 of 30 steps, no errors. The band readback is b51a1c, as before.
- The shipping DMG, mounted read-only: same ffmpeg as built, and it runs. The app binary has no test pages or repo paths in it. **The shipping build itself hasn't been launched**, because it can only open a visible window. That's Phase 4.

### Not proven

- Apple Silicon. The arm64 ffmpeg compiles and links and nothing more. Its format matrix, app and DMG are all still to do, on an Apple Silicon Mac or the workflow's `macos-14` job.
- Quarantine: an unsigned download's sidecar under Gatekeeper hasn't been tried. Users may need to clear the quarantine attribute.
- Real camera files through the trimmed build. Only the Sintel export input and synthetic clips were used.
- Long or large files, beyond 10 s at 1080p.

## Bug found along the way
`ring-worklet.ts?url` was inlined into production bundles as a raw TypeScript `data:` URL, which
`addModule` rejects, so the engine's audio graph failed to start in production builds of the desktop
and web apps. Dev builds weren't affected. Fixed by loading plain JS through a same-origin blob.

## Phase 1 review notes
- The `audio-graph` harness failures were not load alone. All four captured hangs stopped in `AudioContext.resume()`
  with no user gesture, on both transports. With `--autoplay-policy=no-user-gesture-required` in the headless config,
  the spec passed 16 of 16 under the same outside load (before: 12 of 16). This points to Chromium's autoplay policy
  and not the worklet code. Neither Electron nor Tauri sets that flag, so the real play path relies on the click.
- The fixture now waits for the audio clock to advance (up to 15 s) instead of a fixed 350 ms.
- Midtones: WebKit keeps matching ffmpeg. Chromium's hardware-decode lift (128 to 139) stays a known difference.
- Still open for Phase 4: re-measure fps in a visible window on a quiet machine. Outside load was 40-360 during review.

## Phase 2 review notes
- Exports were BT.601 with no colour tags, in Electron too. For (200,30,30) at 1080p, Y was 85 where BT.709 needs 73, and
  players assume BT.709 for HD. Both apps now convert with BT.709 and tag it. A cargo test checks Y and the tags after the mux.
- `smoke.sh` now prints b51a1c for the red band. That's its own readback (`scale` to rgb24 decoding BT.709 as BT.601):
  c2291b encoded as BT.709 and decoded as BT.601 works out to (181,26,29). The earlier c2291b vs c91e1e difference is the gamut step for
  SD video (SMPTE 170M to BT.709 of c91e1e computes to c42a1d).
- A failed Tauri export now aborts its session (kills ffmpeg, removes partial files). Electron has no such channel and keeps
  its existing behaviour, including "already in progress" after a failure.
- The Rust SSRF check is now stricter than Electron's: it also covers 192.0.0.0/24, 198.18.0.0/15, multicast and reserved
  IPv4, NAT64 and 6to4 embedded IPv4, IPv4-compatible IPv6, site-local and multicast IPv6. Electron's list is unchanged.


## Phase 4 results

All on the same Mac (macOS 13.7.8, Intel dual-core m3), 7 November 2026 unless a row says otherwise. Load is `uptime`'s 1-minute
average at the start and end of each run; "speed" is `pmset -g therm`'s CPU speed limit, since this fanless Mac also throttles
itself (it read 33 to 100 during these runs). No run here was on an idle machine: the lowest load seen was 2.3.

### Shipping build

Built from `d9c0da9` (same app code as `f08da83`) with `CI=true pnpm bundle`.

| | Electron 31 (`electron-builder --mac dir --x64`, rebuilt today) | Tauri 2 |
|---|---|---|
| Installed app (`du -sk`) | 609,636 KB (595 MiB) | **23,760 KB (23.2 MiB)** |
| DMG | 244,826,601 bytes (233.5 MiB, `hdiutil` UDZO) | **8,703,372 bytes (8.3 MiB)** |

The Tauri app is unsigned (`codesign`: not signed at all; `spctl`: rejected), so Gatekeeper's Open Anyway step is needed. The binary has no test
pages or test commands in it, and `Contents/MacOS/ffmpeg` is byte-identical to `binaries/ffmpeg-x86_64-apple-darwin`.

`smoke.sh` on a packaged `--features webkit-tests` build of the same commit: 30 of 30 (env plus 29 steps), no errors, no CSP reports, the result names the
bundled `Contents/MacOS/ffmpeg`, red band b51a1c as before, no Keychain entries left under the test service. Load 3.5 to 4.0.

### First launch of the shipping build

Launched from a copy of the DMG's contents with `open -g`, with `HOME` and `CFFIXED_USER_HOME` pointing at a scratch folder, and a scratch-only
library injected with `DYLD_INSERT_LIBRARIES`. The library is not part of the app. It blocks focus changes and Keychain lookups, and reads the page
through WebKit's own API, because a shipping build has no test hooks.

- **Starts, stays up, loads the editor:** up for 2 min 51 s, then quit through `NSRunningApplication.terminate`, gone within 1 s. A WebKit snapshot
  shows the full editor (Media, Preview, Timeline, Inspector) with an empty project titled *Untitled*. No page errors, `console.error` calls or
  unhandled rejections were seen. All 13 `window.desktop*` objects were present. `crossOriginIsolated` false, no `navigator.gpu`, no `AudioDecoder`, as expected here.
- **It asks for focus even with `open -g`.** tao calls `activateIgnoringOtherApps` at launch (three calls, one with `true`) and `makeKeyAndOrderFront`.
  The injected library blocked these. Launched normally that's what a user wants, but a background launch will take focus.
- **No Keychain lookups** at startup: the blocking hooks never fired.
- **Files:** only under the scratch home: `Application Support/studio.frontstage.tauri/{mcp-token,window-state.json}`, WebKit caches and website data,
  and Saved Application State. The real `~/Library` folders named after the app (left there by earlier test runs) were unchanged, by name, size and mtime.
  There was no Electron data folder (`~/Library/Application Support/Frontstage`) on this Mac to protect.
- **Focus:** frontmost was `loginwindow` (the screen was locked) before and during the run. At 2 min 46 s the window became visible, key and
  1440x900, and the app became frontmost. This lines up with someone unlocking the Mac and clicking or zooming the window; the app's own activation
  calls at that moment were blocked. After the quit, Preview was frontmost.
- **Not seen:** menus, dialogs, sound, drag and drop, and the picture in an unobscured window. A shipping build has no hooks, so they're left to the
  user's checklist.

### Memory, RSS summed over every process

Tauri counts the app, its children and every `com.apple.WebKit.*` helper (WebContent, GPU, Networking) that appeared after launch. Electron counts the
main process and all its helpers. ffmpeg is shown separately. RSS double-counts shared pages, so these overstate both.

| Run | Electron | Tauri | Load |
|---|---|---|---|
| Editor open, idle | 268 MB median, 274 peak (hidden window, real editor, 90 s) | 214 MB median, 258 peak (shipping build, window behind others, 2 min 51 s) | E 9.5 to 3.5; T 2.9 to 24.6 |
| Playback, `phase1.html` `playback` section | peaks 390 and 414 MB | peaks 297 and 282 MB | 9.8 to 10.6, then 50 to 39 |
| 1080p YouTube export, app alone | peaks 433 to 556 MB | peaks 328 to 354 MB | 3.5 to 100 |
| Same, with ffmpeg | 1,100 to 1,224 MB | 1,004 to 1,031 MB | |

**Memory came out lower on Tauri in these runs**, which reverses Phase 0's peak of 372 MB on Electron against 540 MB on WebKit. That was a different page
(`bench.html`), so the two can't be set side by side. Electron's main process grew to 975 MB in one export on 3 November under load 258: Electron's
frame send doesn't wait, so frames queue in the main process when ffmpeg falls behind. The Tauri sink waits for each frame.

### Export speed

Both apps ran the same `export_speed` section of `phase1.html`: 300 frames of `clip1080.mp4` at 1920x1080, with its audio, through `runExport` and the
desktop `FfmpegIpcSink` with `libx264_youtube`, into each app's real export code. Electron used its WebGPU renderer and stock ffmpeg 6.1.1, Tauri WebGL2
and the trimmed ffmpeg 7.1.5. Both outputs: H.264 High, yuv420p, BT.709, 300 frames, AAC 469 frames. PSNR between them is 48.8 dB (the renderers' pixels differ slightly).

| Run, 7 Nov | Seconds | Frames/s | Load start to end |
|---|---|---|---|
| Tauri a | 39.6 | 7.57 | 3.5 to 3.8 |
| Electron a | 54.6 | 5.49 | 3.8 to 7.2 |
| Electron b | 65.8 | 4.56 | 7.2 to 100 |
| Tauri b | 84.2 | 3.56 | 100 to 50 |
| Electron c | 54.5 | 5.50 | 4.1 to 9.4 |
| Tauri c | 57.1 | 5.26 | 9.4 to 6.8 |
| Electron d | 56.3 | 5.32 | 6.8 to 9.2 |
| Tauri d | 64.7 | 4.64 | 9.2 (the app's exit then took 7 minutes, likely the Mac sleeping) |

On 3 November, under loads of 11 to 258: Electron 140.3 s and 276.8 s, Tauri 152.5 s and 140.7 s.

**About the same.** The fastest run was Tauri's, at the lowest load, but at matched loads of 4 to 9 the two were within about 10% either way, and load
moved more than that within single runs. Phase 0's 1.5 frames/s came from the spike's raw path under heavy load and isn't comparable.

### Preview fps

`phase1.html`'s `fps` section in the packaged test build, which now records `document.visibilityState` and whether `requestAnimationFrame` ran.
Every run below reported `hidden` from start to end and no `requestAnimationFrame` calls, so **all of these are throttled, hidden-window numbers, not
on-screen ones**.

| Render / source | 1 layer | 2 layers | 3 layers | 1 layer + 3 colour + gaussian |
|---|---|---|---|---|
| 540p / 540p | 142.6 / 147.1 / 175.8 | 105.9 / 84.1 / 69.0 | 51.9 / 45.6 / 64.2 | 82.2 / 64.9 / 85.6 |
| 540p / 1080p | 100.0 / 107.4 / 92.2 | 46.2 / 50.3 / 46.6 | 19.3 / 25.5 / 27.5 | 56.9 / 57.7 / 54.4 |
| 1080p / 1080p | 70.0 / 72.8 / 74.4 | 34.4 / 36.8 / 35.0 | 22.4 / 23.4 / 23.5 | 29.5 / 29.9 / 27.7 |

Runs: hidden Accessory window, load 11.1 to 9.8 (speed 100 to 83); hidden Accessory window, load 38.7 to 25.2 (speed 83); Regular-policy window launched
with `open -g`, load 5.5 to 4.7, with the screen locked, so it never reached the screen.

Earlier runs, for the record: on 3 November a Regular window launched with `open -g` and kept at the back was `visible` for its first 18 s, and
`requestAnimationFrame` ran there (134 calls, about 7 a second, the page being busy). Then another window covered it, it went `hidden` and
`requestAnimationFrame` stopped for the rest of the run. Its 1080p cells (4.4, 2.4, 3.4, 4.9) ran while it was covered. A hidden run that day at load
5.5 to 8.4 gave 1.6 and 2.2 fps for 1080p with 2 and 3 layers (composite p50 324 and 372 ms), against 25.7 and 12.4 a few minutes later. One-off
collapses like these are why each number needs its load and a repeat.

Playback through `PlaybackEngine` (640x360 from the 1080p clip, `requestAnimationFrame` stood in for by a message loop) showed 174 of 174 frames at
29.9 fps with no audio underruns, at load 9.8 to 10.6 and again at 45 to 39.

**On-screen numbers need the user:** open the test build's `phase1.html?only=fps` (or any 1080p timeline in the app) in a window that's in front and
uncovered, leave the Mac alone for the 90 seconds it takes, and note whether `page.rafPerSec` is near 60.

### Tests

- `pnpm turbo run test typecheck --concurrency=1`: 20 of 20 tasks, 3,092 tests passed, 4 tasks from turbo's cache. Load 3.6 to 6.3, 3 min 12 s.
- `cargo test` in `src-tauri`: 204 passed, 0 failed, 2 ignored (the format matrix and YouTube checks, which need `--ignored`). Load 6.3 to 9.3.
- `smoke.sh` on the packaged test build: above.

### Not proven

- Anything a person has to see, hear or click: picture and sound in an uncovered window, menus, file pickers, JS dialogs, drag and drop, Reveal and Open
  skills folder. Morphic sign-in with the new `state` value, real Claude and fal calls, and saving a real key in an unsigned app's Keychain. These are on
  the user's checklist.
- Gatekeeper and quarantine on a downloaded DMG. The DMG here was built locally and never quarantined.
- Long exports, real HDR footage and real camera files. Windows and Apple Silicon.
- Whether `apps/desktop` can go. That's the user's decision, and needs `morphic-client.mjs` moved or the proxy ported first.
