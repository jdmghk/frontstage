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
