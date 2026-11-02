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

## Bug found along the way
`ring-worklet.ts?url` was inlined into production bundles as a raw TypeScript `data:` URL, which
`addModule` rejects, so the engine's audio graph failed to start in production builds of the desktop
and web apps. Dev builds weren't affected. Fixed by loading plain JS through a same-origin blob.
