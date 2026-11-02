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
- **Decode:** H.264 and VP9 report as supported. The HEVC and AV1 config checks throw `TypeError`,
  so those sources need an H.264 proxy.
- **Export:** 300 frames through raw IPC to ffmpeg gave a valid 10 s 1080p MP4 at 1.5 fps using
  `libx264_youtube` settings (preset slow). `readPixels` averaged 92 ms per frame and the frame send
  averaged 112 ms. IPC alone reached about 20 frames/s at 8.3 MB per frame.

## Phase 1 results

`createRenderer` picks WebGPU when an adapter exists, otherwise `WebGL2Renderer`. `AudioGraph` uses a
`MessagePort` worklet where `SharedArrayBuffer` is missing, and `AudioMixer` decodes with
`decodeAudioData` where `AudioDecoder` is missing. WebGPU, SAB and `AudioDecoder` paths are unchanged.

Run the parity test with `pnpm -F @frontstage/engine-harness exec playwright test -c
playwright.offscreen.config.ts parity`. `apps/studio-tauri/src/phase1.ts` runs the same fixtures on WebKit.

WebKit fps, WebGL2 through the real `composite()`, on `tauri://`, hidden window, one H.264 decoder per
layer, GPU finished each frame:

| Render size / source | 1 layer | 2 layers | 3 layers | 1 layer + 3 colour + gaussian |
|---|---|---|---|---|
| 540p / 540p | 162.5 | 100.9 | 47.1 | 52.5 |
| 540p / 1080p | 91.1 | 45.8 | 35.1 | 39.7 |
| 1080p / 1080p | 58.7 | 35.2 | 23.1 | 16.5 |

What the WKWebView on this Mac lacks, beyond what Phase 0 found:
- `OffscreenCanvas` has no WebGL2 context, so export renders to a detached canvas element.
- `new VideoFrame(canvas)` on an undisplayed WebGL canvas throws "Canvas has no frame", so WebGL2 sinks
  use `readRGBA`.
- 2D canvas has no `filter`, so text blur runs on the CPU (`blurRGBA`).
- `copyTo` rejects RGBX frames. The `VideoFrame` constructor rejects BT.2020/P3/PQ/HLG tags and odd-sized
  I420, and ignores `visibleRect` offsets.
- Decoded H.264 arrives as full-range I420 tagged `fullRange: true`, so planes differ from Chromium's
  while the rendered colour matches.

Existing behaviour the WebGL2 backend reproduces rather than fixes: `importExternalTexture` returns
premultiplied colour for frames with alpha, and `ALPHA_BLEND` then multiplies by alpha again, so soft text
edges come out darker than a straight-alpha blend.

`AudioDecoder` in Chromium keeps 1024 priming samples (about 21-23 ms late against ffmpeg), while
`decodeAudioData` in both browsers lines up with ffmpeg. That delay in the web and Electron paths is unchanged.

## Bug found along the way
`ring-worklet.ts?url` was inlined into production bundles as a raw TypeScript `data:` URL, which
`addModule` rejects, so the engine's audio graph failed to start in production builds of the desktop
and web apps. Dev builds weren't affected. Fixed by loading plain JS through a same-origin blob.
