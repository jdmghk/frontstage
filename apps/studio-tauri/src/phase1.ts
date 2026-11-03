// Phase 1 checks in the real webview: backend parity against Chromium's WebGPU, no-SAB audio, audio
// decode, export paths, playback and fps. Reports through Tauri commands on tauri://, or the loopback
// driver over HTTP. Run by a driver; nothing here ships.
import {
  AudioGraph, AudioMixer, PlaybackEngine, WebGL2Renderer, demuxMp4, decodeAudioBytesFallback, hasWebCodecsAudio,
  buildAudioChunks, AudioDecodeManager, createRenderer, createExportCanvas, preferredAudioTransport, renderSpanToMp4, runExport,
  type AudioTransport, type CompositeLayer, type MediaByteSource,
} from "@frontstage/engine";
import { defaultCrop, fitTransform, type Clip, type Effect, type Timeline } from "@frontstage/core";
import { invoke } from "@tauri-apps/api/core";
import { PARITY_CASES, DEFAULT_TOLERANCE, W, H, Sources, compareRGBA, registerParityLUTs } from "../../engine-harness/src/parity-cases.js";
import { FfmpegIpcSink } from "../../desktop/src/renderer/ffmpeg-sink.js";

const onTauri = location.protocol === "tauri:";
const only = new URLSearchParams(location.search).get("only")?.split(",");
const results: Record<string, unknown> = {};
const logEl = document.getElementById("log")!;

async function progress(line: string): Promise<void> {
  logEl.textContent = line.slice(0, 400);
  if (onTauri) await invoke("progress", { name: "p1", value: line });
  else await fetch("/progress", { method: "POST", body: line });
}

async function file(name: string): Promise<ArrayBuffer> {
  if (onTauri) return invoke<ArrayBuffer>("spike_file", { name });
  return (await fetch(`/file/${name}`)).arrayBuffer();
}

const section = async (name: string, fn: () => Promise<unknown>) => {
  if (only && !only.includes(name)) return;
  try { results[name] = await fn(); }
  catch (e) { results[name] = { failed: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }; }
  await progress(`${name}: ${JSON.stringify(results[name])}`);
};

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? +s[Math.min(s.length - 1, Math.floor(s.length * p))]!.toFixed(1) : null;
};

// Pacing with no timers: a hidden WebKit window throttles those about 10x.
const channel = new MessageChannel();
const tickers: Array<() => void> = [];
channel.port1.onmessage = () => tickers.shift()?.();
const yieldTask = () => new Promise<void>((r) => { tickers.push(r); channel.port2.postMessage(0); });
async function spinFor(ms: number, each?: () => void, everyMs = 20): Promise<void> {
  const end = performance.now() + ms;
  let next = 0;
  while (performance.now() < end) {
    if (each && performance.now() >= next) { each(); next = performance.now() + everyMs; }
    await yieldTask();
  }
}

function env() {
  const c = document.createElement("canvas");
  const gl = c.getContext("webgl2");
  const ctx2d = new OffscreenCanvas(4, 4).getContext("2d")!;
  return {
    origin: location.origin,
    ua: navigator.userAgent.slice(-60),
    visibility: document.visibilityState,
    crossOriginIsolated: self.crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
    transport: preferredAudioTransport(),
    webgpu: "gpu" in navigator,
    audioDecoder: typeof AudioDecoder !== "undefined",
    encodedAudioChunk: typeof EncodedAudioChunk !== "undefined",
    audioData: typeof AudioData !== "undefined",
    audioEncoder: typeof AudioEncoder !== "undefined",
    videoDecoder: typeof VideoDecoder !== "undefined",
    videoEncoder: typeof VideoEncoder !== "undefined",
    canvas2dFilter: typeof ctx2d.filter === "string",
    colorBufferFloat: !!gl?.getExtension("EXT_color_buffer_float"),
    offscreenWebgl2: !!new OffscreenCanvas(4, 4).getContext("webgl2"),
    glRenderer: gl?.getParameter(gl.VERSION),
  };
}

function hostCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w; c.height = h; c.style.cssText = "width:160px;height:90px";
  const host = document.getElementById("host")!;
  host.innerHTML = "";
  host.appendChild(c);
  return c;
}

async function parity() {
  const refs = JSON.parse(new TextDecoder().decode(await file("parity-ref.json"))) as Record<string, string>;
  const r = await WebGL2Renderer.create(hostCanvas(W, H));
  registerParityLUTs(r);
  const s = await Sources.create();
  const rows: Array<Record<string, unknown>> = [];
  const size = { width: W, height: H };
  let failed = 0, passed = 0, skipped = 0;
  for (const c of PARITY_CASES) {
    const ref = refs[c.name];
    if (!ref) { rows.push({ name: c.name, missingRef: true }); failed++; continue; }
    const want = Uint8Array.from(atob(ref), (ch) => ch.charCodeAt(0));
    let row: Record<string, unknown>;
    const layers = c.layers(s);
    if (!layers) { skipped++; rows.push({ name: c.name, skipped: true }); continue; }
    try {
      await r.composite(layers, size);
      const got = await r.readRGBA();
      const tol = c.tolerance ?? DEFAULT_TOLERANCE;
      const d = compareRGBA(want, got, tol);
      const ok = c.reportOnly === true || c.browserRaster === true || d.overTol === 0;
      if (ok) passed++; else failed++;
      row = { name: c.name, ok, tol, reportOnly: c.reportOnly, browserRaster: c.browserRaster, maxDiff: d.maxDiff, meanAbs: d.meanAbs, overTol: d.overTol, worst: d.worst };
    } catch (e) {
      failed++;
      row = { name: c.name, ok: false, threw: String(e) };
    }
    rows.push(row);
  }
  // Decoded bytes against Chromium's, to separate a decoder difference from a renderer one.
  let h264Planes: unknown = "no reference";
  if (s.h264 && refs["__h264planes"]) {
    const want = Uint8Array.from(atob(refs["__h264planes"]), (ch) => ch.charCodeAt(0));
    const got = new Uint8Array(s.h264.allocationSize());
    await s.h264.copyTo(got);
    let differing = 0, max = 0;
    for (let i = 0; i < Math.min(want.length, got.length); i++) { const d = Math.abs(want[i]! - got[i]!); if (d) differing++; if (d > max) max = d; }
    h264Planes = { wantBytes: want.length, gotBytes: got.length, differing, max, codedW: s.h264.codedWidth, visible: s.h264.visibleRect?.toJSON(), ts: s.h264.timestamp };
  }
  // Text can't be compared across browsers, so check WebKit's output against its own raster: colour
  // multiplied by alpha, as the reference does, composited over transparent.
  const rawText = new Uint8Array(s.text.allocationSize());
  const rawLayout = await s.text.copyTo(rawText);
  const swap = s.text.format === "BGRA";
  await r.composite([{ frame: s.text, transform: s.full, opacity: 1, crop: defaultCrop() }], size);
  const textOut = await r.readRGBA();
  let textMax = 0, partial = 0, covered = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = rawLayout[0]!.offset + y * rawLayout[0]!.stride + x * 4;
    const a = rawText[i + 3]! / 255;
    const j = (y * W + x) * 4;
    const rr = rawText[i + (swap ? 2 : 0)]! * a * a;
    const gg = rawText[i + 1]! * a * a;
    const bb = rawText[i + (swap ? 0 : 2)]! * a * a;
    textMax = Math.max(textMax, Math.abs(rr - textOut[j]!), Math.abs(gg - textOut[j + 1]!), Math.abs(bb - textOut[j + 2]!), Math.abs(a * 255 - textOut[j + 3]!));
    if (a > 0) covered++;
    if (a > 0 && a < 1) partial++;
  }
  const blurRaw = new Uint8Array(s.textBlur.allocationSize());
  await s.textBlur.copyTo(blurRaw);
  let blurPartial = 0, blurCovered = 0;
  for (let i = 3; i < blurRaw.length; i += 4) { if (blurRaw[i]!) blurCovered++; if (blurRaw[i]! > 0 && blurRaw[i]! < 255) blurPartial++; }
  const textCheck = { maxVsOwnRaster: +textMax.toFixed(2), covered, partial, blur: { covered: blurCovered, partial: blurPartial } };
  const formats = { h264Planes, textCheck, bitmap: s.bitmap.format, bitmapAlpha: s.bitmapAlpha.format, text: s.text.format, image: s.image.frame().format, h264: s.h264?.format, h264cs: s.h264?.colorSpace.toJSON() };
  const px = await r.readPixel(0, 0);
  s.dispose();
  r.dispose();
  return { passed, failed, skipped, total: PARITY_CASES.length, formats, lastPixel: px, rows };
}

// First sample at or after each expected onset whose magnitude crosses a threshold.
function onsets(mono: Float32Array, rate: number, times: number[]): number[] {
  return times.map((t) => {
    const from = Math.max(0, Math.round((t - 0.2) * rate));
    const to = Math.min(mono.length, Math.round((t + 0.2) * rate));
    for (let i = from; i < to; i++) if (Math.abs(mono[i]!) > 0.1) return +((i / rate) * 1000).toFixed(2);
    return -1;
  });
}

function toMono(pcm: Float32Array, channels: number): Float32Array {
  const out = new Float32Array(pcm.length / channels);
  for (let i = 0; i < out.length; i++) out[i] = pcm[i * channels]!;
  return out;
}

function rms(a: Float32Array, b: Float32Array, shift: number): number {
  let sum = 0, n = 0;
  for (let i = Math.max(0, -shift); i < a.length && i + shift < b.length; i++) {
    const d = a[i]! - b[i + shift]!;
    sum += d * d; n++;
  }
  return n ? Math.sqrt(sum / n) : -1;
}

// The offset (in frames) at which decoded audio best lines up with ffmpeg's decode.
function bestShift(a: Float32Array, b: Float32Array, range: number): { shift: number; rms: number } {
  let best = { shift: 0, rms: Infinity };
  for (let s = -range; s <= range; s += 1) {
    const sliceA = a.subarray(0, Math.min(a.length, 80000));
    const e = rms(sliceA, b, s);
    if (e >= 0 && e < best.rms) best = { shift: s, rms: e };
  }
  return { shift: best.shift, rms: +best.rms.toFixed(5) };
}

async function decodeOne(name: string, rate: number, channels: number) {
  const bytes = await file(`${name}.mp4`);
  const demux = await demuxMp4(new Blob([bytes]));
  const ref = new Float32Array(await file(`${name}.pcm`));
  const times = [1, 2, 3];
  const t0 = performance.now();
  const dec = await decodeAudioBytesFallback(bytes, demux.audio!.sampleRate, demux.audio!.channels);
  const ms = performance.now() - t0;
  if (!dec) return { name, decodeAudioData: "FAILED" };
  const mono = toMono(dec.pcm, dec.channels);
  const row: Record<string, unknown> = {
    name, trackRate: demux.audio!.sampleRate, trackChannels: demux.audio!.channels, expectRate: rate, expectChannels: channels,
    decodedRate: dec.sampleRate, decodedChannels: dec.channels,
    decodedSecs: +(mono.length / dec.sampleRate).toFixed(4),
    ffmpegSecs: +(ref.length / rate).toFixed(4),
    decodeMs: Math.round(ms),
    onsetsMs: onsets(mono, dec.sampleRate, times),
    ffmpegOnsetsMs: onsets(ref, rate, times),
    vsFfmpeg: bestShift(mono, ref, 3000),
  };
  if (hasWebCodecsAudio()) {
    const parts: Float32Array[] = [];
    const m = await AudioDecodeManager.create(demux.audio!, buildAudioChunks(demux.audio!, bytes));
    await m.decodeAll((p) => { parts.push(p.data); });
    const total = parts.reduce((n, p) => n + p.length, 0);
    const all = new Float32Array(total);
    let off = 0;
    for (const p of parts) { all.set(p, off); off += p.length; }
    const acMono = toMono(all, demux.audio!.channels);
    row.audioDecoderSecs = +(acMono.length / rate).toFixed(4);
    row.audioDecoderOnsetsMs = onsets(acMono, rate, times);
    row.audioDecoderVsFfmpeg = bestShift(acMono, ref, 3000);
    row.decodeAudioDataVsAudioDecoder = bestShift(mono, acMono, 3000);
  }
  return row;
}

async function audioDecode() {
  const out = [await decodeOne("timing44", 44100, 1), await decodeOne("timing48", 48000, 2)];
  // A whole 1080p file through decodeAudioData, to see the cost with a video track in the bytes.
  const big = await file("clip1080.mp4");
  const t0 = performance.now();
  const dec = await decodeAudioBytesFallback(big, 48000, 2);
  const refBig = new Float32Array(await file("clip1080.pcm"));
  const left = (d: Float32Array, ch: number) => toMono(d, ch);
  return {
    timing: out,
    full1080: dec ? {
      fileMB: +(big.byteLength / 1e6).toFixed(1),
      ms: Math.round(performance.now() - t0),
      secs: +(dec.pcm.length / dec.channels / dec.sampleRate).toFixed(3),
      vsFfmpeg: bestShift(left(dec.pcm, 2), left(refBig, 2), 3000),
    } : "FAILED",
  };
}

// Dominant frequency from zero crossings on the signal actually leaving the worklet.
function probeTone(analyser: AnalyserNode, rate: number): { rms: number; hz: number } {
  const buf = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buf);
  let cross = 0, sum = 0;
  for (let i = 0; i < buf.length; i++) {
    sum += buf[i]! * buf[i]!;
    if (i > 0 && buf[i - 1]! < 0 && buf[i]! >= 0) cross++;
  }
  return { rms: +Math.sqrt(sum / buf.length).toFixed(4), hz: Math.round((cross * rate) / buf.length) };
}

async function audioGraphRun(transport: AudioTransport) {
  const rate = 48000;
  const pcm = new Float32Array(await file("clip1080.pcm"));
  const graph = await AudioGraph.create(2, rate, transport);
  const internals = graph as unknown as { ctx: AudioContext; node: AudioWorkletNode; ring: { underrunFrames?: number } };
  const analyser = internals.ctx.createAnalyser();
  analyser.fftSize = 8192;
  internals.node.connect(analyser);

  // Preload, start, drain: the clock must advance and buffered frames must fall in step.
  const secs = 0.9;
  graph.pushPcm({ timestampUs: 0, sampleRate: rate, channels: 2, data: pcm.subarray(0, rate * 2 * secs) });
  const before = graph.availableRead;
  const free0 = graph.freeSpaceFrames;
  await graph.start();
  const c0 = graph.currentTime;
  const w0 = performance.now();
  await spinFor(400);
  const mid = graph.availableRead;
  const tone = probeTone(analyser, rate);
  const c1 = graph.currentTime;
  const w1 = performance.now();

  // Continuous feed at the speed the mixer would: top up whenever a chunk fits.
  let cursor = rate * 2 * secs;
  const chunk = 2048 * 2;
  let pushed = 0;
  const feed = () => {
    while (graph.freeSpaceFrames >= 2048 && cursor + chunk <= pcm.length) {
      graph.pushPcm({ timestampUs: 0, sampleRate: rate, channels: 2, data: pcm.subarray(cursor, cursor + chunk) });
      cursor += chunk;
      pushed += 2048;
    }
  };
  const c2 = graph.currentTime;
  const w2 = performance.now();
  await spinFor(5000, feed);
  const tone2 = probeTone(analyser, rate);
  const c3 = graph.currentTime;
  const w3 = performance.now();
  const under = internals.ring.underrunFrames;

  // Pause, reset and restart, as a seek does.
  graph.stop();
  await spinFor(100);
  graph.reset();
  const afterReset = graph.availableRead;
  graph.pushPcm({ timestampUs: 0, sampleRate: rate, channels: 2, data: pcm.subarray(0, 4096 * 2) });
  const refill = graph.availableRead;
  await graph.start();
  await spinFor(300);
  const drained = graph.availableRead;
  const free1 = graph.freeSpaceFrames;
  graph.dispose();
  return {
    transport: graph.transport,
    preload: { before, freeBefore: free0, afterMsDrain: mid, clockSecs: +(c1 - c0).toFixed(3), wallSecs: +((w1 - w0) / 1000).toFixed(3), tone },
    feed: { pushedFrames: pushed, clockSecs: +(c3 - c2).toFixed(3), wallSecs: +((w3 - w2) / 1000).toFixed(3), tone: tone2, underrunFrames: under },
    reset: { afterReset, refill, drainedAfter300ms: drained, freeSpace: free1 },
  };
}

const clipBase = (over: Partial<Clip>): Clip => ({
  id: "c", mediaRef: "clip", mediaType: "video", sourceClipType: "video", startFrame: 0, durationFrames: 60,
  trimStartFrame: 0, trimEndFrame: 0, speed: 1, volume: 1, fadeInFrames: 0, fadeOutFrames: 0,
  fadeInInterpolation: "linear", fadeOutInterpolation: "linear", opacity: 1,
  transform: fitTransform({ width: 1920, height: 1080 }, { width: 640, height: 360 }), crop: defaultCrop(), ...over,
} as Clip);

function timelineFor(frames: number, withAudio: boolean): Timeline {
  const video = clipBase({ durationFrames: frames, linkGroupId: withAudio ? "l" : undefined });
  const tracks: Timeline["tracks"] = [{ id: "v", type: "video", muted: false, hidden: false, syncLocked: false, clips: [video] }];
  if (withAudio) tracks.push({ id: "a", type: "audio", muted: false, hidden: false, syncLocked: false, clips: [{ ...video, id: "ca", mediaType: "audio" }] });
  return { fps: 30, width: 640, height: 360, settingsConfigured: true, tracks };
}

async function exportPaths() {
  const bytes = await file("clip1080.mp4");
  const media: MediaByteSource = { open: async () => new Blob([bytes], { type: "video/mp4" }) };
  // The desktop sink over a fake bridge: same code path as the real ffmpeg export.
  let videoFrames = 0, videoBytes = 0, audioBytes = 0, nonBlack = 0, started: unknown = null;
  const sink = new FfmpegIpcSink({
    start: async (o) => { started = o; return "x"; },
    videoFrame: (b) => {
      videoFrames++; videoBytes = b.length;
      let lit = 0;
      for (let i = 0; i < b.length; i += 4000) if (b[i]! > 8) lit++;
      if (lit > 10) nonBlack++;
    },
    audioData: (b) => { audioBytes += b.length; },
    finish: async () => "x",
  }, { codec: "libx264_youtube", outPath: "/dev/null" });
  const t0 = performance.now();
  await runExport(timelineFor(30, true), media, sink);
  const ffmpegPath = {
    started, videoFrames, nonBlack, bytesPerFrame: videoBytes, expectedBytesPerFrame: 640 * 360 * 4,
    audioBytes, expectedAudioBytes: 48000 * 2 * 4, ms: Math.round(performance.now() - t0),
  };

  let span: unknown;
  try {
    const out = await renderSpanToMp4(timelineFor(15, false), media, { startFrame: 0, frameCount: 15 });
    const demux = await demuxMp4(new Blob([out as Uint8Array<ArrayBuffer>]));
    span = { bytes: out.length, videoSamples: demux.video?.samples.length, codec: demux.video?.codec };
  } catch (e) { span = { failed: String(e) }; }

  let hevc: unknown;
  try {
    hevc = await VideoDecoder.isConfigSupported({ codec: "hvc1.1.6.L93.B0", codedWidth: 1920, codedHeight: 1080 }).then((r) => r.supported);
  } catch (e) { hevc = `threw ${String(e)}`; }
  return { ffmpegPath, renderSpanToMp4: span, hevcConfigCheck: hevc };
}

// rAF never fires in the hidden window, so the engine's tick is driven from a message loop at 60 Hz.
// This exercises the real play path (pump, mix, composite, clock); it says nothing about display.
function shimRaf(): { stop: () => void; ticks: () => number } {
  const original = window.requestAnimationFrame;
  const originalCancel = window.cancelAnimationFrame;
  const queue = new Map<number, FrameRequestCallback>();
  let id = 0, running = true, ticks = 0;
  window.requestAnimationFrame = (cb) => { queue.set(++id, cb); return id; };
  window.cancelAnimationFrame = (h) => { queue.delete(h); };
  void (async () => {
    let next = performance.now();
    while (running) {
      await yieldTask();
      const now = performance.now();
      if (now < next) continue;
      next = now + 1000 / 60;
      const due = [...queue.values()];
      queue.clear();
      ticks++;
      for (const cb of due) cb(now);
    }
  })();
  return {
    ticks: () => ticks,
    stop: () => { running = false; window.requestAnimationFrame = original; window.cancelAnimationFrame = originalCancel; },
  };
}

async function playback() {
  const bytes = await file("clip1080.mp4");
  const media: MediaByteSource = { open: async () => new Blob([bytes], { type: "video/mp4" }) };
  const canvas = hostCanvas(640, 360);
  const engine = await PlaybackEngine.create(canvas);
  const tl = timelineFor(240, true);
  await engine.load(tl, media);
  await engine.seek(20, "exact");
  const rgba = await engine.readRGBA();
  let lit = 0;
  for (let i = 0; i < rgba.length; i += 400) if (rgba[i]! > 8) lit++;
  const seek = { pixelsLit: lit, pixelsSampled: Math.floor(rgba.length / 400) };

  const audio = (engine as unknown as { audio?: { transport: string; availableRead: number; ring: { underrunFrames?: number } } }).audio;
  const clockFn = engine.__audioCurrentTime;
  const mixer = engine.__audioMixer;
  const raf = shimRaf();
  let frames = 0, last = -1;
  const drift: number[] = [];
  const hashes = new Set<number>();
  const unsub = engine.onStateChange((s) => {
    if (s.currentFrame !== last) { frames++; last = s.currentFrame; }
  });
  const c0 = clockFn?.() ?? -1;
  await engine.seek(0, "exact");
  engine.play();
  while (engine.currentFrame === 0) await yieldTask();
  const w0 = performance.now();
  const c1 = clockFn?.() ?? -1;
  const f0 = engine.currentFrame;
  frames = 0;
  await spinFor(5000, () => {
    drift.push(Math.abs(((clockFn?.() ?? 0) - c1) - (engine.currentFrame - f0) / 30));
  }, 100);
  for (let i = 0; i < 4; i++) {
    const shot = await engine.readRGBA();
    let h = 0;
    for (let p = 0; p < shot.length; p += 1024) h = (h * 31 + shot[p]!) | 0;
    hashes.add(h);
    await spinFor(200);
  }
  const out = {
    visibility: document.visibilityState,
    seek,
    transport: audio?.transport,
    mix: { channels: mixer?.channels, rate: mixer?.sampleRate, peak: mixer?.__lastPeak, fedFrames: mixer?.__mixFed },
    distinctFramesShown: frames,
    distinctImagesIn4Samples: hashes.size,
    wallSecs: +((performance.now() - w0) / 1000).toFixed(3),
    shownFps: +(frames / ((performance.now() - w0) / 1000)).toFixed(1),
    currentFrame: engine.currentFrame,
    frameSpan: engine.currentFrame - f0,
    audioClockSecs: +((clockFn?.() ?? -1) - c1).toFixed(3),
    videoVsAudioSecs: { p50: pct(drift, 0.5), max: pct(drift, 1) },
    bufferedFrames: audio?.availableRead,
    underrunFrames: audio?.ring.underrunFrames,
    rafTicks: raf.ticks(),
    openFrames: engine.openFrameCount(),
    clockAtSeek: c0,
  };
  engine.pause();
  await engine.seek(50, "exact");
  const resumedFrame = engine.currentFrame;
  const r0 = performance.now();
  engine.play();
  while (engine.currentFrame === resumedFrame && performance.now() - r0 < 8000) await yieldTask();
  const firstAdvanceMs = Math.round(performance.now() - r0);
  const atFirst = engine.currentFrame;
  await spinFor(1000);
  const resumed = { from: resumedFrame, firstAdvanceMs, framesInNextSecond: engine.currentFrame - atFirst, underrunFrames: audio?.ring.underrunFrames };
  engine.pause();
  unsub();
  raf.stop();
  engine.dispose();
  return { ...out, resumed };
}

// One decoder per layer, as the engine runs one per source. Output order is presentation order for
// this clip's GOP once flushed through the reorder window.
class ClipStream {
  private decoder: VideoDecoder;
  private frames: VideoFrame[] = [];
  private i = 0;
  private wake: (() => void) | null = null;
  constructor(private samples: { isSync: boolean; cts: number; byteOffset: number; size: number }[], private view: Uint8Array<ArrayBuffer>, config: VideoDecoderConfig) {
    this.decoder = new VideoDecoder({
      output: (f) => { this.frames.push(f); this.wake?.(); },
      error: (e) => { throw e; },
    });
    this.decoder.configure(config);
  }
  async next(): Promise<VideoFrame> {
    while (this.frames.length === 0) {
      if (this.i < this.samples.length && this.decoder.decodeQueueSize < 6) {
        const s = this.samples[this.i++]!;
        this.decoder.decode(new EncodedVideoChunk({ type: s.isSync ? "key" : "delta", timestamp: s.cts, data: this.view.subarray(s.byteOffset, s.byteOffset + s.size) }));
        await yieldTask();
      } else {
        await new Promise<void>((r) => { this.wake = r; });
        this.wake = null;
      }
    }
    return this.frames.shift()!;
  }
  dispose(): void {
    for (const f of this.frames) f.close();
    this.decoder.close();
  }
}

const v = (value: number) => ({ value });
const fx = (type: string, params: Effect["params"]): Effect => ({ id: type, type, enabled: true, params });
const FPS_FX: Effect[] = [
  fx("color.exposure", { ev: v(0.2) }), fx("color.contrast", { amount: v(1.1) }), fx("color.saturation", { amount: v(1.2) }),
  fx("blur.gaussian", { radius: v(8) }),
];

async function fpsRun(clip: ArrayBuffer, rw: number, rh: number, layers: number, effects: boolean, frames: number) {
  const demux = await demuxMp4(new Blob([clip]));
  const video = demux.video!;
  const config: VideoDecoderConfig = { codec: video.codec, codedWidth: video.codedWidth, codedHeight: video.codedHeight, ...(video.description ? { description: video.description } : {}) };
  const view = new Uint8Array(clip) as Uint8Array<ArrayBuffer>;
  const canvas = hostCanvas(rw, rh);
  const renderer = await WebGL2Renderer.create(canvas);
  const gl = canvas.getContext("webgl2")!;
  const streams = Array.from({ length: layers }, () => new ClipStream(video.samples, view, config));
  const px = new Uint8Array(4);
  const natW = video.codedWidth, natH = video.codedHeight;
  const dt = { a: rw / natW, d: rh / natH };
  const composite: number[] = [];
  let format = "";
  // Warm up so shader compile and allocation aren't counted.
  const warmup = 5;
  let t0 = 0;
  for (let n = 0; n < frames + warmup; n++) {
    if (n === warmup) t0 = performance.now();
    const fs = await Promise.all(streams.map((s) => s.next()));
    format = String(fs[0]!.format);
    const ls: CompositeLayer[] = fs.map((frame, i) => ({
      frame,
      transform: { a: dt.a, b: 0, c: 0, d: dt.d, e: 0, f: 0 },
      opacity: i === 0 ? 1 : 0.6,
      crop: defaultCrop(),
      effects: effects ? FPS_FX : undefined,
    }));
    const c = performance.now();
    await renderer.composite(ls, { width: rw, height: rh });
    // Forces the GPU to finish; a one-pixel read off the drawing buffer adds no full-frame copy.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    if (n >= warmup) composite.push(performance.now() - c);
    for (const f of fs) f.close();
  }
  const secs = (performance.now() - t0) / 1000;
  for (const s of streams) s.dispose();
  renderer.dispose();
  return { fps: +(frames / secs).toFixed(1), compositeP50ms: pct(composite, 0.5), compositeP95ms: pct(composite, 0.95), frames, format };
}

async function fps() {
  const clip1080 = await file("clip1080.mp4");
  const clip540 = await file("clip540.mp4");
  // Says whether the numbers below can be read as on-screen ones: a hidden or occluded window throttles.
  const page = { start: document.visibilityState, focus: document.hasFocus(), rafCalls: 0, rafPerSec: 0, end: "" };
  const rafStart = performance.now();
  let rafOn = true;
  const rafTick = () => { if (!rafOn) return; page.rafCalls++; requestAnimationFrame(rafTick); };
  requestAnimationFrame(rafTick);
  const out: Record<string, unknown> = { page };
  const FRAMES = 90;
  await fpsRun(clip540, 960, 540, 1, false, 30); // warm-up, discarded: the first run after page load is slow
  const matrix: Array<[string, ArrayBuffer, number, number]> = [
    ["render540_src540", clip540, 960, 540],
    ["render540_src1080", clip1080, 960, 540],
    ["render1080_src1080", clip1080, 1920, 1080],
  ];
  for (const [name, clip, rw, rh] of matrix) {
    for (const [label, layers, effects] of [["1 layer", 1, false], ["2 layers", 2, false], ["3 layers", 3, false], ["1 layer + 3 colour + gaussian", 1, true]] as const) {
      const key = `${name} ${label}`;
      try { out[key] = await fpsRun(clip, rw, rh, layers, effects, FRAMES); }
      catch (e) { out[key] = { failed: String(e) }; }
      await progress(`fps ${key}: ${JSON.stringify(out[key])}`);
    }
  }
  rafOn = false;
  page.end = document.visibilityState;
  page.rafPerSec = +(page.rafCalls / ((performance.now() - rafStart) / 1000)).toFixed(1);
  return out;
}

// A full 1080p YouTube export through the real desktop sink and ffmpeg, for comparing the apps. The same
// page runs in both: the Tauri bridge here, the real preload over the driver's HTTP origin in Electron.
// Asked for by name (?only=export_speed&out=<path>), since it writes a file and takes minutes.
async function exportSpeed() {
  const outPath = new URLSearchParams(location.search).get("out");
  if (!outPath) throw new Error("no out= path");
  if (onTauri) await import("./tauri-bridge.js");
  const host = window as unknown as {
    desktopExport: ConstructorParameters<typeof FfmpegIpcSink>[0];
    desktopProject: { __setNextExportPick(p: string): Promise<void>; pickExportSave(name: string): Promise<string | null> };
  };
  // The app only accepts an output path that came through its picker.
  await host.desktopProject.__setNextExportPick(outPath);
  const picked = await host.desktopProject.pickExportSave("out.mp4");
  const bytes = await file("clip1080.mp4");
  const media: MediaByteSource = { open: async () => new Blob([bytes], { type: "video/mp4" }) };
  const FRAMES = 300;
  const video = clipBase({ durationFrames: FRAMES, linkGroupId: "l", transform: fitTransform({ width: 1920, height: 1080 }, { width: 1920, height: 1080 }) });
  const tl: Timeline = {
    fps: 30, width: 1920, height: 1080, settingsConfigured: true,
    tracks: [
      { id: "v", type: "video", muted: false, hidden: false, syncLocked: false, clips: [video] },
      { id: "a", type: "audio", muted: false, hidden: false, syncLocked: false, clips: [{ ...video, id: "ca", mediaType: "audio" }] },
    ],
  };
  const t0 = performance.now();
  await runExport(tl, media, new FfmpegIpcSink(host.desktopExport, { codec: "libx264_youtube", outPath }));
  const secs = (performance.now() - t0) / 1000;
  return { picked, frames: FRAMES, secs: +secs.toFixed(1), fps: +(FRAMES / secs).toFixed(2), visibility: document.visibilityState };
}

// A real 1080p decode against ffmpeg's conversion of the same frame: geometry, range and matrix end
// to end, including the bottom rows that H.264's 1088 coded height would expose if the crop were lost.
async function real1080() {
  const clip = await file("clip1080.mp4");
  const demux = await demuxMp4(new Blob([clip]));
  const video = demux.video!;
  const stream = new ClipStream(video.samples, new Uint8Array(clip) as Uint8Array<ArrayBuffer>, {
    codec: video.codec, codedWidth: video.codedWidth, codedHeight: video.codedHeight, ...(video.description ? { description: video.description } : {}),
  });
  let frame = await stream.next();
  for (let i = 0; i < 30; i++) { frame.close(); frame = await stream.next(); }
  const info = { ts: frame.timestamp, coded: [frame.codedWidth, frame.codedHeight], visible: frame.visibleRect?.toJSON(), format: frame.format, colorSpace: frame.colorSpace.toJSON(), demuxCoded: [video.codedWidth, video.codedHeight] };
  const r = await WebGL2Renderer.create(hostCanvas(1920, 1080));
  await r.composite([{ frame, transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, opacity: 1, crop: defaultCrop() }], { width: 1920, height: 1080 });
  const got = await r.readRGBA();
  const px = await r.readPixel(100, 1079);
  frame.close();
  stream.dispose();
  r.dispose();
  const want = new Uint8Array(await file("frame30.rgb"));
  let sum = 0, bottom = 0, bottomN = 0, n = 0, over8 = 0;
  for (let y = 0; y < 1080; y++) for (let x = 0; x < 1920; x++) {
    const i = (y * 1920 + x) * 4, j = (y * 1920 + x) * 3;
    let m = 0;
    for (let c = 0; c < 3; c++) { const d = Math.abs(got[i + c]! - want[j + c]!); sum += d; n++; if (d > m) m = d; if (y >= 1064) { bottom += d; bottomN++; } }
    if (m > 8) over8++;
  }
  return { ...info, meanAbs: +(sum / n).toFixed(3), bottom16RowsMeanAbs: +(bottom / bottomN).toFixed(3), pixelsOver8: over8, of: 1920 * 1080, bottomRowPixel: px, readPixelMatchesRGBA: got[(1079 * 1920 + 100) * 4] === px[0] };
}

interface RealClip {
  name: string; group: string; W: number; H: number; pix: string;
  marker: [number, number, number, number];
  patches: Record<string, [number, number]>;
  file?: string; ref?: string; tonemapRef?: string; encodeError?: string;
}

function whiteBox(rgba: Uint8Array, stride: number, W: number, H: number): number[] | null {
  // White marker only appears in the top half; the ramp below tops out at grey.
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H >> 1; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * stride;
    if (rgba[i]! > 200 && rgba[i + 1]! > 200 && rgba[i + 2]! > 200) {
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
}

function compareToRgb(got: Uint8Array, want: Uint8Array, W: number, H: number) {
  let sum = 0, over8 = 0, max = 0;
  for (let p = 0; p < W * H; p++) {
    let m = 0;
    for (let c = 0; c < 3; c++) { const d = Math.abs(got[p * 4 + c]! - want[p * 3 + c]!); sum += d; if (d > m) m = d; }
    if (m > 8) over8++;
    if (m > max) max = m;
  }
  return { meanAbs: +(sum / (W * H * 3)).toFixed(2), maxDiff: max, pctOver8: +((100 * over8) / (W * H)).toFixed(2) };
}

async function realClip(c: RealClip) {
  const row: Record<string, unknown> = { name: c.name, group: c.group, pix: c.pix, size: `${c.W}x${c.H}` };
  if (!c.file) return { ...row, encodeError: c.encodeError };
  const bytes = await file(c.file);
  const demux = await demuxMp4(new Blob([bytes]));
  const video = demux.video!;
  row.codec = video.codec;
  row.demuxSize = [video.codedWidth, video.codedHeight];
  const config: VideoDecoderConfig = { codec: video.codec, codedWidth: video.codedWidth, codedHeight: video.codedHeight, ...(video.description ? { description: video.description } : {}) };
  try { row.configSupported = (await VideoDecoder.isConfigSupported(config)).supported; }
  catch (e) { row.configSupported = `threw ${String(e)}`; }

  // The demuxer gives no description for HEVC/AV1, so give WebKit a fair try with the real box and
  // the usual codec strings before concluding it can't decode them.
  if (!video.codec.startsWith("avc") && !video.codec.startsWith("vp")) {
    const box = video.codec.startsWith("hvc") ? "hvcC" : "av1C";
    const u8 = new Uint8Array(bytes);
    let at = -1;
    for (let i = 4; i < u8.length - 4 && at < 0; i++) if (String.fromCharCode(u8[i]!, u8[i + 1]!, u8[i + 2]!, u8[i + 3]!) === box) at = i;
    const description = at < 0 ? undefined : u8.slice(at + 4, at - 4 + ((u8[at - 4]! << 24) | (u8[at - 3]! << 16) | (u8[at - 2]! << 8) | u8[at - 1]!));
    const tries: Record<string, unknown> = { boxBytes: description?.length };
    const strings = box === "hvcC" ? [video.codec, "hvc1.1.6.L93.B0", "hev1.1.6.L93.B0", "hvc1.2.4.L153.B0"] : [video.codec, "av01.0.04M.08"];
    for (const codec of strings) {
      try { tries[codec] = (await VideoDecoder.isConfigSupported({ codec, codedWidth: video.codedWidth, codedHeight: video.codedHeight, description })).supported; }
      catch (e) { tries[codec] = `threw ${String(e)}`; }
    }
    row.withDescription = tries;
  }

  // Raw decoder output, separately from the engine, to see what the browser hands over.
  if (row.configSupported === true) {
    try {
      const stream = new ClipStream(video.samples, new Uint8Array(bytes) as Uint8Array<ArrayBuffer>, config);
      const f = await Promise.race([stream.next(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("no output in 20s")), 20000))]);
      row.frame = { format: f.format, coded: [f.codedWidth, f.codedHeight], visible: f.visibleRect?.toJSON(), display: [f.displayWidth, f.displayHeight], colorSpace: f.colorSpace.toJSON() };
      f.close();
      stream.dispose();
    } catch (e) { row.frame = { failed: String(e) }; }
  }

  // The engine's real path: demux, VideoDecodeManager, compositor, renderer.
  const media: MediaByteSource = { open: async () => new Blob([bytes], { type: "video/mp4" }) };
  const nat = { width: video.codedWidth, height: video.codedHeight };
  const canvasSize = { width: c.W, height: c.H };
  const clip = clipBase({ durationFrames: 30, transform: fitTransform(nat, canvasSize) });
  const tl: Timeline = { fps: 30, width: c.W, height: c.H, settingsConfigured: true, tracks: [{ id: "v", type: "video", muted: false, hidden: false, syncLocked: false, clips: [clip] }] };
  const canvas = hostCanvas(c.W, c.H);
  let engine: PlaybackEngine | undefined;
  try {
    engine = await PlaybackEngine.create(canvas);
    row.backend = (engine as unknown as { renderer: { backend: string } }).renderer.backend;
    await engine.load(tl, media);
    await engine.seek(15, "exact");
    row.layers = engine.__lastLayerCount;
    if (engine.__lastLayerCount === 0) { row.rejected = true; return row; }
    const got = await engine.readRGBA();
    row.gotBytes = got.length;
    const want = new Uint8Array(await file(c.ref!));
    row.expectedMarker = c.marker;
    row.markerGot = whiteBox(got, 4, c.W, c.H);
    row.markerRef = whiteBox(want, 3, c.W, c.H);
    let magenta = 0;
    for (let i = 0; i < got.length; i += 4) if (got[i]! > 180 && got[i + 1]! < 90 && got[i + 2]! > 180) magenta++;
    row.padPixels = magenta;
    row.vsFfmpegMatrixOnly = compareToRgb(got, want, c.W, c.H);
    const patches: Record<string, unknown> = {};
    for (const [name, [x, y]] of Object.entries(c.patches)) {
      if (!["red", "green", "blue", "grey", "ramp50", "ramp140", "ramp230"].includes(name)) continue;
      const i = (y * c.W + x) * 4, j = (y * c.W + x) * 3;
      patches[name] = { got: [got[i], got[i + 1], got[i + 2]], ref: [want[j], want[j + 1], want[j + 2]] };
    }
    row.patches = patches;
    if (c.tonemapRef) {
      const tm = new Uint8Array(await file(c.tonemapRef));
      row.vsFfmpegToneMapped = compareToRgb(got, tm, c.W, c.H);
      const [x, y] = c.patches.ramp140!;
      row.ramp140ToneMapped = [tm[(y * c.W + x) * 3], tm[(y * c.W + x) * 3 + 1], tm[(y * c.W + x) * 3 + 2]];
    }
  } catch (e) {
    row.engineError = String(e);
  } finally {
    engine?.dispose();
  }
  return row;
}

async function realClips() {
  const clips = JSON.parse(new TextDecoder().decode(await file("clips.json"))) as RealClip[];
  const out: unknown[] = [];
  for (const c of clips) {
    let row: unknown;
    try { row = await realClip(c); } catch (e) { row = { name: c.name, failed: String(e) }; }
    out.push(row);
    await progress(`clip ${JSON.stringify(row)}`);
  }
  return out;
}

function probe() {
  const out: Record<string, string> = {};
  const t = (name: string, fn: () => unknown) => {
    try { out[name] = String(fn()); } catch (e) { out[name] = `THROWS ${String(e)}`; }
  };
  const w = 16, h = 16;
  for (const format of ["RGBA", "BGRA", "RGBX", "BGRX", "I420", "NV12"] as const) {
    const size = format.startsWith("I") || format === "NV" + "12" ? w * h * 1.5 : w * h * 4;
    t(`raw ${format}`, () => { const f = new VideoFrame(new Uint8Array(size), { format, codedWidth: w, codedHeight: h, timestamp: 0 }); const r = `${f.format} ${JSON.stringify(f.colorSpace)}`; f.close(); return r; });
  }
  for (const matrix of ["bt709", "smpte170m", "bt470bg", "bt2020-ncl", "rgb"]) {
    t(`cs matrix ${matrix}`, () => { const f = new VideoFrame(new Uint8Array(w * h * 1.5), { format: "I420", codedWidth: w, codedHeight: h, timestamp: 0, colorSpace: { matrix: matrix as VideoMatrixCoefficients } }); const r = JSON.stringify(f.colorSpace); f.close(); return r; });
  }
  for (const primaries of ["bt709", "smpte170m", "bt470bg", "bt2020", "smpte432"]) {
    t(`cs primaries ${primaries}`, () => { const f = new VideoFrame(new Uint8Array(w * h * 1.5), { format: "I420", codedWidth: w, codedHeight: h, timestamp: 0, colorSpace: { primaries: primaries as VideoColorPrimaries } }); const r = JSON.stringify(f.colorSpace); f.close(); return r; });
  }
  for (const transfer of ["bt709", "smpte170m", "iec61966-2-1", "pq", "hlg"]) {
    t(`cs transfer ${transfer}`, () => { const f = new VideoFrame(new Uint8Array(w * h * 1.5), { format: "I420", codedWidth: w, codedHeight: h, timestamp: 0, colorSpace: { transfer: transfer as VideoTransferCharacteristics } }); const r = JSON.stringify(f.colorSpace); f.close(); return r; });
  }
  t("imageData", () => { const c = new OffscreenCanvas(w, h); c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(w * h * 4), w, h), 0, 0); const bm = c.transferToImageBitmap(); const f = new VideoFrame(bm, { timestamp: 0 }); const r = `${f.format} ${f.displayWidth} ${JSON.stringify(f.colorSpace)}`; f.close(); return r; });
  return out;
}

async function factory() {
  const c = createExportCanvas(32, 32);
  const r = await createRenderer(c);
  const backend = r.backend;
  r.dispose();
  return { backend, canvas: c.constructor.name };
}

await section("env", async () => env());
await section("probe", async () => probe());
await section("real_1080", real1080);
await section("real_clips", realClips);
await section("factory", factory);
await section("parity", parity);
await section("audio_decode", audioDecode);
await section("audio_port", () => audioGraphRun("port"));
await section("audio_preferred", () => audioGraphRun(preferredAudioTransport()));
await section("export_paths", exportPaths);
await section("playback", playback);
await section("fps", fps);
if (only?.includes("export_speed")) await section("export_speed", exportSpeed);
if (onTauri) await invoke("report", { json: JSON.stringify(results, null, 1) });
else await fetch("/report", { method: "POST", body: JSON.stringify(results, null, 1) });
