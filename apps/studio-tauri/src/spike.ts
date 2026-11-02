// Phase 0 go/no-go spike: runs the real engine pieces inside the system webview and reports numbers.
import { invoke } from "@tauri-apps/api/core";
import { AudioGraph, demuxMp4 } from "@frontstage/engine";

const results: Record<string, unknown> = {};
const logEl = document.getElementById("log")!;
const log = (s: string) => { logEl.textContent += s + "\n"; };
const section = async (name: string, fn: () => Promise<unknown>) => {
  log(`> ${name}`);
  try { results[name] = await fn(); }
  catch (e) { results[name] = { failed: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }; }
  log(JSON.stringify(results[name]));
  await invoke("progress", { name, value: JSON.stringify(results[name]) });
};
const percentile = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? +(s[Math.min(s.length - 1, Math.floor(s.length * p))]!).toFixed(2) : null;
};

function makeGl() {
  const canvas = document.getElementById("c") as HTMLCanvasElement;
  const gl = canvas.getContext("webgl2", { preserveDrawingBuffer: true, premultipliedAlpha: false, alpha: false })!;
  if (!gl) throw new Error("no webgl2");
  const compile = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl.VERTEX_SHADER, `#version 300 es
    out vec2 uv; void main(){ vec2 q=vec2(float(gl_VertexID&1),float((gl_VertexID>>1)&1));
    uv=vec2(q.x,1.0-q.y); gl_Position=vec4(q*2.0-1.0,0.0,1.0);} `));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, `#version 300 es
    precision highp float; in vec2 uv; out vec4 o; uniform sampler2D t; void main(){ o=texture(t,uv); }`));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link");
  gl.useProgram(p);
  gl.bindVertexArray(gl.createVertexArray());
  gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.viewport(0, 0, canvas.width, canvas.height);
  return gl;
}

async function loadClip() {
  const bytes = await invoke<ArrayBuffer>("clip_bytes");
  const demux = await demuxMp4(new Blob([bytes]));
  if (!demux.video) throw new Error("no video track");
  return { bytes, video: demux.video };
}

/** Decodes the clip in order, calling onFrame (which may await) for each frame with backpressure. */
async function decodeFrames(
  clip: Awaited<ReturnType<typeof loadClip>>,
  limit: number,
  onFrame: (f: VideoFrame) => void | Promise<void>,
) {
  const queue: VideoFrame[] = [];
  let wake: (() => void) | null = null;
  let error: unknown = null;
  const notify = () => { wake?.(); wake = null; };
  const decoder = new VideoDecoder({
    output: (f) => { queue.push(f); notify(); },
    error: (e) => { error = e; notify(); },
  });
  const { video } = clip;
  decoder.configure({
    codec: video.codec, codedWidth: video.codedWidth, codedHeight: video.codedHeight,
    ...(video.description ? { description: video.description } : {}),
  });
  const view = new Uint8Array(clip.bytes);
  const samples = video.samples.slice(0, limit);
  let handled = 0;
  const drain = async () => {
    while (queue.length) {
      const f = queue.shift()!;
      await onFrame(f);
      f.close();
      handled++;
    }
  };
  for (const s of samples) {
    decoder.decode(new EncodedVideoChunk({
      type: s.isSync ? "key" : "delta", timestamp: s.cts, data: view.subarray(s.byteOffset, s.byteOffset + s.size),
    }));
    await drain();
    while (decoder.decodeQueueSize > 4 && !error) {
      await new Promise<void>((r) => { wake = r; setTimeout(r, 5); });
      await drain();
    }
    if (error) throw error;
  }
  await decoder.flush();
  await drain();
  decoder.close();
  if (error) throw error;
  return handled;
}

async function run() {
  await section("environment", async () => ({
    ua: navigator.userAgent,
    origin: location.origin,
    secureContext: isSecureContext,
    crossOriginIsolated: self.crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
    webgpu: !!(navigator as Navigator & { gpu?: unknown }).gpu,
    audioDecoder: typeof AudioDecoder !== "undefined",
    videoDecoder: typeof VideoDecoder !== "undefined",
  }));

  await section("codecs", async () => {
    const out: Record<string, unknown> = {};
    const list = {
      h264_high_1080: "avc1.640028", h264_main_1080: "avc1.4d0028", h264_high_4k: "avc1.640033",
      hevc_main: "hvc1.1.6.L120.90", hevc_main10: "hvc1.2.4.L120.90", vp9: "vp09.00.40.08", av1: "av01.0.08M.08",
    };
    for (const [name, codec] of Object.entries(list)) {
      try { out[name] = (await VideoDecoder.isConfigSupported({ codec, codedWidth: 1920, codedHeight: 1080 })).supported; }
      catch (e) { out[name] = `threw: ${String(e)}`; }
    }
    return out;
  });

  const clip = await loadClip();
  const gl = makeGl();

  await section("video_decode_webgl", async () => {
    const times: number[] = [];
    let last = performance.now();
    const start = last;
    const n = await decodeFrames(clip, 300, (f) => {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, f as unknown as TexImageSource);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.finish();
      const now = performance.now();
      times.push(now - last);
      last = now;
    });
    const px = new Uint8Array(4);
    gl.readPixels(960, 540, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const secs = (performance.now() - start) / 1000;
    return {
      codec: clip.video.codec, size: `${clip.video.codedWidth}x${clip.video.codedHeight}`, frames: n,
      fps: +(n / secs).toFixed(1), p50ms: percentile(times, 0.5), p95ms: percentile(times, 0.95),
      centerPixel: [...px], glError: gl.getError(),
    };
  });

  await section("audio_ffmpeg_worklet", async () => {
    const t0 = performance.now();
    const raw = await invoke<ArrayBuffer>("decode_pcm");
    const decodeMs = performance.now() - t0;
    const pcm = new Float32Array(raw);
    const graph = await AudioGraph.create(2, 48000);
    await graph.start();
    const chunk = 4800 * 2;
    const end = Math.min(pcm.length, 48000 * 2 * 6);
    let at = 0;
    let underruns = 0;
    const startTime = graph.currentTime;
    const wall = performance.now();
    while (at < end) {
      while (at < end && graph.freeSpaceFrames >= chunk / 2) {
        graph.pushPcm({ timestampUs: 0, sampleRate: 48000, channels: 2, data: pcm.subarray(at, at + chunk) });
        at += chunk;
      }
      await new Promise((r) => setTimeout(r, 20));
      if (graph.availableRead === 0 && at < end) underruns++;
    }
    const wallSecs = (performance.now() - wall) / 1000;
    const clockSecs = graph.currentTime - startTime;
    graph.dispose();
    return {
      decodeMs: Math.round(decodeMs), pcmSeconds: +(pcm.length / 2 / 48000).toFixed(2),
      wallSecs: +wallSecs.toFixed(2), clockSecs: +clockSecs.toFixed(2), underruns,
    };
  });

  const w = 1920, h = 1080;
  const pixels = new Uint8Array(w * h * 4);

  await section("ipc_throughput", async () => {
    await invoke("sink_start");
    const start = performance.now();
    const times: number[] = [];
    for (let i = 0; i < 60; i++) {
      const t = performance.now();
      await invoke("sink_frame", pixels);
      times.push(performance.now() - t);
    }
    const secs = (performance.now() - start) / 1000;
    const received = await invoke<number>("sink_finish");
    return { frames: 60, framesPerSec: +(60 / secs).toFixed(1), p50ms: percentile(times, 0.5), p95ms: percentile(times, 0.95), bytesReceived: received, bytesExpected: 60 * pixels.length };
  });

  await section("export_youtube_1080", async () => {
    const out = await invoke<string>("export_start", { width: w, height: h, fps: 30 });
    const start = performance.now();
    let readMs = 0, sendMs = 0;
    const n = await decodeFrames(clip, 300, async (f) => {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, f as unknown as TexImageSource);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      let t = performance.now();
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      readMs += performance.now() - t;
      t = performance.now();
      await invoke("export_frame", pixels);
      sendMs += performance.now() - t;
    });
    await invoke("export_finish");
    const secs = (performance.now() - start) / 1000;
    return { out, frames: n, secs: +secs.toFixed(1), fps: +(n / secs).toFixed(2), readPixelsAvgMs: +(readMs / n).toFixed(1), sendAvgMs: +(sendMs / n).toFixed(1) };
  });

  await invoke("report", { json: JSON.stringify(results, null, 2) });
}

run().catch(async (e) => {
  results["fatal"] = String(e);
  await invoke("report", { json: JSON.stringify(results, null, 2) });
});
