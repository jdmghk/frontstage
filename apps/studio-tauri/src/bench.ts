// Same-page benchmark for Electron vs system webview. Talks only HTTP to the driver (GET /clip, POST /report).
import { AudioGraph, demuxMp4 } from "@frontstage/engine";

const results: Record<string, unknown> = {};
const logEl = document.getElementById("log")!;
const section = async (name: string, fn: () => Promise<unknown>) => {
  try { results[name] = await fn(); }
  catch (e) { results[name] = { failed: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }; }
  logEl.textContent += `${name}: ${JSON.stringify(results[name])}\n`;
  await fetch("/progress", { method: "POST", body: `${name}: ${JSON.stringify(results[name])}` });
};
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? +s[Math.min(s.length - 1, Math.floor(s.length * p))]!.toFixed(1) : null;
};

const res = await fetch("/clip");
const bytes = await res.arrayBuffer();
const demux = await demuxMp4(new Blob([bytes]));
const video = demux.video!;
const view = new Uint8Array(bytes);
const LIMIT = 150;

async function decode(onFrame: (f: VideoFrame) => void | Promise<void>) {
  const queue: VideoFrame[] = [];
  let error: unknown = null;
  let closedByUs = 0;
  const decoder = new VideoDecoder({ output: (f) => queue.push(f), error: (e) => { error = e; } });
  decoder.configure({ codec: video.codec, codedWidth: video.codedWidth, codedHeight: video.codedHeight, ...(video.description ? { description: video.description } : {}) });
  const drain = async () => { while (queue.length) { const f = queue.shift()!; await onFrame(f); f.close(); closedByUs++; } };
  for (const s of video.samples.slice(0, LIMIT)) {
    decoder.decode(new EncodedVideoChunk({ type: s.isSync ? "key" : "delta", timestamp: s.cts, data: view.subarray(s.byteOffset, s.byteOffset + s.size) }));
    await drain();
    while (decoder.decodeQueueSize > 4 && !error) { await new Promise((r) => setTimeout(r, 1)); await drain(); }
    if (error) throw error;
  }
  await decoder.flush();
  await drain();
  decoder.close();
  return closedByUs;
}

async function timed(onFrame: (f: VideoFrame) => void | Promise<void>) {
  const start = performance.now();
  const per: number[] = [];
  const n = await decode(async (f) => { const t = performance.now(); await onFrame(f); per.push(performance.now() - t); });
  const secs = (performance.now() - start) / 1000;
  return { frames: n, fps: +(n / secs).toFixed(1), workP50ms: pct(per, 0.5), workP95ms: pct(per, 0.95) };
}

function newCanvas(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h; c.style.cssText = "width:160px;height:90px";
  const host = document.getElementById("host")!;
  host.innerHTML = "";
  host.appendChild(c);
  return c;
}

function program(gl: WebGL2RenderingContext, frag: string) {
  const sh = (t: number, s: string) => { const o = gl.createShader(t)!; gl.shaderSource(o, s); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o) ?? ""); return o; };
  const p = gl.createProgram()!;
  gl.attachShader(p, sh(gl.VERTEX_SHADER, `#version 300 es
  out vec2 uv; void main(){ vec2 q=vec2(float(gl_VertexID&1),float((gl_VertexID>>1)&1)); uv=vec2(q.x,1.0-q.y); gl_Position=vec4(q*2.0-1.0,0.0,1.0);}`));
  gl.attachShader(p, sh(gl.FRAGMENT_SHADER, frag));
  gl.linkProgram(p);
  gl.useProgram(p);
  gl.bindVertexArray(gl.createVertexArray());
  return p;
}
const tex = (gl: WebGL2RenderingContext, unit: number) => {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
};

function rgbaUpload(w: number, h: number) {
  const c = newCanvas(w, h);
  const gl = c.getContext("webgl2", { alpha: false })!;
  program(gl, `#version 300 es
  precision highp float; in vec2 uv; out vec4 o; uniform sampler2D t; void main(){ o=texture(t,uv); }`);
  tex(gl, 0);
  gl.viewport(0, 0, w, h);
  return timed((f) => {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, f as unknown as TexImageSource);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.flush();
  });
}

function planesUpload(w: number, h: number) {
  const c = newCanvas(w, h);
  const gl = c.getContext("webgl2", { alpha: false })!;
  const p = program(gl, `#version 300 es
  precision highp float; in vec2 uv; out vec4 o; uniform sampler2D ty; uniform sampler2D tu; uniform sampler2D tv;
  void main(){ float y=(texture(ty,uv).r-0.0627)*1.164; float u=texture(tu,uv).r-0.5; float v=texture(tv,uv).r-0.5;
  o=vec4(y+1.793*v,y-0.213*u-0.533*v,y+2.112*u,1.0); }`);
  ["ty", "tu", "tv"].forEach((n, i) => { tex(gl, i); gl.uniform1i(gl.getUniformLocation(p, n), i); });
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.viewport(0, 0, w, h);
  let buf: Uint8Array | null = null;
  let format = "";
  return timed(async (f) => {
    format = String(f.format);
    const size = f.allocationSize();
    if (!buf || buf.length !== size) buf = new Uint8Array(size);
    const layout = await f.copyTo(buf);
    const W = f.codedWidth, H = f.codedHeight;
    if (f.format === "NV12") {
      gl.activeTexture(gl.TEXTURE0);
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, layout[0]!.stride);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, W, H, 0, gl.RED, gl.UNSIGNED_BYTE, buf, layout[0]!.offset);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.flush();
      return;
    }
    const up = (i: number, pw: number, ph: number) => {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, layout[i]!.stride);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, pw, ph, 0, gl.RED, gl.UNSIGNED_BYTE, buf!, layout[i]!.offset);
    };
    up(0, W, H); up(1, W >> 1, H >> 1); up(2, W >> 1, H >> 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.flush();
  }).then((r) => ({ ...r, format }));
}

function nv12Upload(w: number, h: number) {
  const c = newCanvas(w, h);
  const gl = c.getContext("webgl2", { alpha: false })!;
  const p = program(gl, `#version 300 es
  precision highp float; in vec2 uv; out vec4 o; uniform sampler2D ty; uniform sampler2D tc;
  void main(){ float y=(texture(ty,uv).r-0.0627)*1.164; vec2 c=texture(tc,uv).rg-0.5;
  o=vec4(y+1.793*c.y,y-0.213*c.x-0.533*c.y,y+2.112*c.x,1.0); }`);
  ["ty", "tc"].forEach((n, i) => { tex(gl, i); gl.uniform1i(gl.getUniformLocation(p, n), i); });
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.viewport(0, 0, w, h);
  let buf: Uint8Array | null = null;
  let format = "";
  return timed(async (f) => {
    format = String(f.format);
    if (f.format !== "NV12") throw new Error(`frame format is ${f.format}`);
    const size = f.allocationSize();
    if (!buf || buf.length !== size) buf = new Uint8Array(size);
    const layout = await f.copyTo(buf);
    const W = f.codedWidth, H = f.codedHeight;
    gl.activeTexture(gl.TEXTURE0);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, layout[0]!.stride);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, W, H, 0, gl.RED, gl.UNSIGNED_BYTE, buf, layout[0]!.offset);
    gl.activeTexture(gl.TEXTURE1);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, layout[1]!.stride / 2);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG8, W >> 1, H >> 1, 0, gl.RG, gl.UNSIGNED_BYTE, buf, layout[1]!.offset);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.flush();
  }).then((r) => ({ ...r, format }));
}

async function webgpuPath(w: number, h: number) {
  const nav = navigator as Navigator & { gpu?: GPU };
  if (!nav.gpu) return { skipped: "no webgpu" };
  const adapter = await nav.gpu.requestAdapter({ powerPreference: "low-power" });
  if (!adapter) return { skipped: "no adapter" };
  const device = await adapter.requestDevice();
  const c = newCanvas(w, h);
  const ctx = c.getContext("webgpu")!;
  const format = nav.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format });
  const mod = device.createShaderModule({ code: `
    @group(0) @binding(0) var s: sampler; @group(0) @binding(1) var t: texture_external;
    struct V { @builtin(position) p: vec4f, @location(0) uv: vec2f };
    @vertex fn vs(@builtin(vertex_index) i: u32) -> V { let q = vec2f(f32(i & 1), f32((i >> 1) & 1)); return V(vec4f(q * 2 - 1, 0, 1), vec2f(q.x, 1 - q.y)); }
    @fragment fn fs(v: V) -> @location(0) vec4f { return textureSampleBaseClampToEdge(t, s, v.uv); }` });
  const pipe = device.createRenderPipeline({ layout: "auto", vertex: { module: mod, entryPoint: "vs" }, fragment: { module: mod, entryPoint: "fs", targets: [{ format }] }, primitive: { topology: "triangle-strip" } });
  const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
  return timed(async (f) => {
    const bind = device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: sampler }, { binding: 1, resource: device.importExternalTexture({ source: f }) }] });
    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] }] });
    pass.setPipeline(pipe); pass.setBindGroup(0, bind); pass.draw(4); pass.end();
    device.queue.submit([enc.finish()]);
    await device.queue.onSubmittedWorkDone();
  });
}

async function audio() {
  const ctx = new AudioContext({ sampleRate: 48000 });
  const src = `class R extends AudioWorkletProcessor{constructor(){super();this.q=[];this.o=0;this.under=0;this.played=0;this.port.onmessage=e=>this.q.push(e.data);}
  process(_,out){const[l,r]=out[0];for(let i=0;i<l.length;i++){if(!this.q.length){l[i]=0;r[i]=0;this.under++;continue;}const b=this.q[0];l[i]=b[this.o];r[i]=b[this.o+1];this.o+=2;this.played++;if(this.o>=b.length){this.q.shift();this.o=0;}}
  if(this.played%48000<128)this.port.postMessage({played:this.played,under:this.under});return true;}}registerProcessor('r',R);`;
  await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
  const node = new AudioWorkletNode(ctx, "r", { outputChannelCount: [2] });
  let stats = { played: 0, under: 0 };
  node.port.onmessage = (e) => { stats = e.data; };
  node.connect(ctx.destination);
  await ctx.resume().catch(() => undefined);
  const raw = await (await fetch("/pcm")).arrayBuffer();
  const pcm = new Float32Array(raw);
  const chunk = 9600;
  const end = Math.min(pcm.length, 48000 * 2 * 5);
  const t0 = ctx.currentTime;
  const wall = performance.now();
  for (let at = 0; at < end; at += chunk) {
    const part = pcm.slice(at, at + chunk);
    node.port.postMessage(part, [part.buffer]);
    await new Promise((r) => setTimeout(r, 90));
  }
  await new Promise((r) => setTimeout(r, 300));
  const out = { state: ctx.state, clockSecs: +(ctx.currentTime - t0).toFixed(2), wallSecs: +((performance.now() - wall) / 1000).toFixed(2), ...stats };
  await ctx.close();
  return out;
}


async function audioPreloaded() {
  const ctx = new AudioContext({ sampleRate: 48000 });
  const src = `class R extends AudioWorkletProcessor{constructor(){super();this.q=[];this.o=0;this.under=0;this.played=0;this.port.onmessage=e=>this.q.push(e.data);}
  process(_,out){const[l,r]=out[0];for(let i=0;i<l.length;i++){if(!this.q.length){l[i]=0;r[i]=0;this.under++;continue;}const b=this.q[0];l[i]=b[this.o];r[i]=b[this.o+1];this.o+=2;this.played++;if(this.o>=b.length){this.q.shift();this.o=0;}}
  if(this.played%24000<128)this.port.postMessage({played:this.played,under:this.under});return true;}}registerProcessor('r',R);`;
  await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
  const node = new AudioWorkletNode(ctx, "r", { outputChannelCount: [2] });
  let stats = { played: 0, under: 0 };
  node.port.onmessage = (e) => { stats = e.data; };
  const pcm = new Float32Array(await (await fetch("/pcm")).arrayBuffer());
  const part = pcm.slice(0, 48000 * 2 * 4);
  node.port.postMessage(part, [part.buffer]);
  await new Promise((r) => setTimeout(r, 50));
  node.connect(ctx.destination);
  await ctx.resume().catch(() => undefined);
  const t0 = ctx.currentTime, wall = performance.now();
  await new Promise((r) => setTimeout(r, 3500));
  const out = { state: ctx.state, clockSecs: +(ctx.currentTime - t0).toFixed(2), wallSecs: +((performance.now() - wall) / 1000).toFixed(2), ...stats };
  await ctx.close();
  return out;
}

async function engineAudioGraph() {
  const graph = await AudioGraph.create(2, 48000);
  const pcm = new Float32Array(await (await fetch("/pcm")).arrayBuffer());
  graph.pushPcm({ timestampUs: 0, sampleRate: 48000, channels: 2, data: pcm.subarray(0, 48000 * 2 * 0.9) });
  const before = graph.availableRead;
  await graph.start();
  const t0 = graph.currentTime;
  await new Promise((r) => setTimeout(r, 500));
  const out = { before, after: graph.availableRead, clockSecs: +(graph.currentTime - t0).toFixed(2) };
  graph.dispose();
  return out;
}

async function timers() {
  const t = performance.now();
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 50));
  return { expectedMs: 1000, actualMs: Math.round(performance.now() - t), visibility: document.visibilityState, hasFocus: document.hasFocus() };
}

async function ipc() {
  const internals = (window as unknown as { __TAURI_INTERNALS__?: { invoke: (c: string, a?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
  if (!internals) return { skipped: "not tauri" };
  await internals.invoke("sink_start");
  const frame = new Uint8Array(1920 * 1080 * 4);
  const t = performance.now();
  for (let i = 0; i < 30; i++) await internals.invoke("sink_frame", frame);
  const secs = (performance.now() - t) / 1000;
  return { framesPerSec: +(30 / secs).toFixed(1), received: await internals.invoke("sink_finish"), expected: 30 * frame.length };
}

const memory = async (label: string) => { await fetch("/progress", { method: "POST", body: `MEM ${label}` }); };
await section("env", async () => ({ origin: location.origin, coi: self.crossOriginIsolated, sab: typeof SharedArrayBuffer !== "undefined" }));
await section("timers", timers);
await section("ipc_loopback", ipc);
await section("engine_audio_graph", engineAudioGraph);
await section("audio_preloaded", audioPreloaded);
await memory("playback");
await section("webgl_planes_1080", () => planesUpload(1920, 1080));
await section("webgl_planes_540", () => planesUpload(960, 540));
await section("webgl_rgba_540", () => rgbaUpload(960, 540));
await memory("end");
await fetch("/report", { method: "POST", body: JSON.stringify(results, null, 1) });
