import type { Mat2d, Size, CubeLUT, BlendMode } from "@frontstage/core";
import { canonicalSort, resolveParam, parseGradeCurve, parseHueCurves, BLEND_MODES } from "@frontstage/core";
import type { CompositeLayer } from "./composite-layer.js";
import type { Renderer } from "./renderer.js";
import { effectUniformData, multiPassStep, curvesLutData, hueCurvesLutData } from "./effect-params.js";
import { yuvConversion, gamutToSrgb, frameUploadKind, planeSizes, type YuvConversion } from "./yuv.js";
import {
  VS_FULLSCREEN, VS_CANVAS, VS_LAYER, FS_BLIT, FS_EFFECTS, FS_GAUSS, FS_CURVES, FS_HUE_CURVES, FS_LUT3D,
  FS_SHARPEN_FX2, FS_NOISE_RED_FX2, FS_CLARITY_FX2, FS_GLOW_THRESH, FS_GLOW_FX2, FS_COMPOSITE, FS_STENCIL,
  FS_BLEND, fsSource, type SourceVariant,
} from "./webgl2-shaders.js";

type GL = WebGL2RenderingContext;

interface Program { p: WebGLProgram; u: Map<string, WebGLUniformLocation> }
interface Target { tex: WebGLTexture; fbo: WebGLFramebuffer }

// Prepared source for one layer. Textures belong to a slot or the RGBA cache, never to the plan.
interface Source {
  variant: SourceVariant;
  textures: WebGLTexture[];
  yuv?: YuvConversion;
  gamut?: Float32Array | null;
  hasAlphaPlane?: boolean;
  forceOpaque?: boolean;
}

// Per-layer plane textures and copy buffer, kept between frames to avoid per-frame allocation.
interface PlaneSlot {
  key: string;
  textures: WebGLTexture[];
  buf: Uint8Array<ArrayBuffer>;
}

interface CachedFrame { source: Source }

type Step =
  | { type: string; kind: "plain"; data: Float32Array }
  | { type: string; kind: "curves"; lut: WebGLTexture }
  | { type: string; kind: "lut3d"; tex: WebGLTexture; data: Float32Array }
  | ({ kind: "multi" } & NonNullable<ReturnType<typeof multiPassStep>>);

// Text and image sources reuse one VideoFrame for many composites, so their texture is kept.
const RGBA_CACHE_LIMIT = 8;
const CURVE_CACHE_LIMIT = 16;

function setSampling(gl: GL, filter: number): void {
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}

export class WebGL2Renderer implements Renderer {
  readonly backend = "webgl2";
  private programs = new Map<string, Program>();
  private vao!: WebGLVertexArrayObject;
  private fxPing!: Target;
  private fxPong!: Target;
  private fxScratch!: Target;
  private accumA!: Target;
  private accumB!: Target;
  private readback!: Target;
  private w: number;
  private h: number;
  private readbackSource: Target | null = null;
  private slots: PlaneSlot[] = [];
  private rgbaCache = new Map<VideoFrame, CachedFrame>();
  private curveCache = new Map<string, WebGLTexture>();
  private cubeLUTs = new Map<string, CubeLUT>();
  private lut3dTexCache = new Map<string, WebGLTexture>();
  private queue: Promise<unknown> = Promise.resolve();
  private lost = false;
  private onLost = (e: Event) => { e.preventDefault(); this.lost = true; };
  private onRestored = () => { this.initResources(); this.lost = false; };

  private constructor(private gl: GL, private canvas: HTMLCanvasElement | OffscreenCanvas) {
    this.w = canvas.width;
    this.h = canvas.height;
    this.initResources();
    canvas.addEventListener("webglcontextlost", this.onLost);
    canvas.addEventListener("webglcontextrestored", this.onRestored);
  }

  static async create(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<WebGL2Renderer> {
    const gl = canvas.getContext("webgl2", {
      alpha: false, antialias: false, depth: false, stencil: false, powerPreference: "low-power",
    }) as GL | null;
    if (!gl) throw new Error("EngineUnsupported: WebGL2 not available");
    if (!gl.getExtension("EXT_color_buffer_float")) {
      throw new Error("EngineUnsupported: WebGL2 can't render to rgba16f (EXT_color_buffer_float missing)");
    }
    return new WebGL2Renderer(gl, canvas);
  }

  private initResources(): void {
    const gl = this.gl;
    gl.getExtension("EXT_color_buffer_float");
    this.programs.clear();
    this.slots = [];
    this.rgbaCache.clear();
    this.curveCache.clear();
    this.lut3dTexCache.clear();
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.DITHER);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.blendEquation(gl.FUNC_ADD);
    this.allocTargets(this.w, this.h);
  }

  private makeTarget(w: number, h: number, internal: number): Target {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, internal, w, h);
    setSampling(gl, gl.LINEAR);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return { tex, fbo };
  }

  private allocTargets(w: number, h: number): void {
    const gl = this.gl;
    this.w = w;
    this.h = h;
    this.fxPing = this.makeTarget(w, h, gl.RGBA16F);
    this.fxPong = this.makeTarget(w, h, gl.RGBA16F);
    this.fxScratch = this.makeTarget(w, h, gl.RGBA16F);
    this.accumA = this.makeTarget(w, h, gl.RGBA16F);
    this.accumB = this.makeTarget(w, h, gl.RGBA16F);
    this.readback = this.makeTarget(w, h, gl.RGBA8);
    this.readbackSource = null;
  }

  private freeTargets(): void {
    const gl = this.gl;
    for (const t of [this.fxPing, this.fxPong, this.fxScratch, this.accumA, this.accumB, this.readback]) {
      gl.deleteFramebuffer(t.fbo);
      gl.deleteTexture(t.tex);
    }
  }

  private program(key: string, vs: string, fs: string): Program {
    const hit = this.programs.get(key);
    if (hit) return hit;
    const gl = this.gl;
    const compile = (type: number, src: string): WebGLShader => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        throw new Error(`WebGL2 shader "${key}": ${gl.getShaderInfoLog(s) ?? "compile failed"}`);
      }
      return s;
    };
    const p = gl.createProgram()!;
    const v = compile(gl.VERTEX_SHADER, vs);
    const f = compile(gl.FRAGMENT_SHADER, fs);
    gl.attachShader(p, v);
    gl.attachShader(p, f);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error(`WebGL2 program "${key}": ${gl.getProgramInfoLog(p) ?? "link failed"}`);
    }
    gl.deleteShader(v);
    gl.deleteShader(f);
    const u = new Map<string, WebGLUniformLocation>();
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < n; i++) {
      const name = gl.getActiveUniform(p, i)!.name.replace(/\[0\]$/, "");
      const loc = gl.getUniformLocation(p, name);
      if (loc) u.set(name, loc);
    }
    const prog = { p, u };
    this.programs.set(key, prog);
    return prog;
  }

  private bindTextures(prog: Program, textures: Array<[string, WebGLTexture, number?]>): void {
    const gl = this.gl;
    textures.forEach(([name, tex, target], unit) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(target ?? gl.TEXTURE_2D, tex);
      const loc = prog.u.get(name);
      if (loc) gl.uniform1i(loc, unit);
    });
  }

  // Ends with a clean sampler state so a later pass can't sample its own render target.
  private unbindTextures(count: number): void {
    const gl = this.gl;
    for (let unit = 0; unit < count; unit++) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.bindTexture(gl.TEXTURE_3D, null);
    }
  }

  private begin(target: Target | null, clear: boolean, blend: boolean, vw: number, vh: number): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    gl.viewport(0, 0, vw, vh);
    if (clear) {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    if (blend) gl.enable(gl.BLEND);
    else gl.disable(gl.BLEND);
  }

  private fullscreen(
    key: string,
    fs: string,
    target: Target,
    textures: Array<[string, WebGLTexture, number?]>,
    set?: (prog: Program) => void,
    blend = false,
  ): void {
    const gl = this.gl;
    const prog = this.program(key, VS_FULLSCREEN, fs);
    this.begin(target, !blend, blend, this.w, this.h);
    gl.useProgram(prog.p);
    this.bindTextures(prog, textures);
    set?.(prog);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this.unbindTextures(textures.length);
  }

  private setU(prog: Program, data: ArrayLike<number>): void {
    const padded = new Float32Array(12);
    padded.set(data as Float32Array);
    this.gl.uniform4fv(prog.u.get("U") ?? null, padded);
  }

  private gauss(from: Target, to: Target, dirX: number, dirY: number, radius: number): void {
    this.fullscreen("gauss", FS_GAUSS, to, [["src", from.tex]], (p) => this.setU(p, [dirX, dirY, radius, 0]));
  }

  private copyFx(from: Target, to: Target): void {
    this.fullscreen("blit", FS_BLIT, to, [["src", from.tex]]);
  }

  private async uploadSource(frame: VideoFrame, slotIndex: number): Promise<Source> {
    const kind = frameUploadKind(frame.format);
    if (kind === "planar" || kind === "nv12") return this.uploadYuv(frame, slotIndex, kind);
    return this.uploadRgba(frame, kind);
  }

  private async uploadYuv(frame: VideoFrame, slotIndex: number, kind: "planar" | "nv12"): Promise<Source> {
    const gl = this.gl;
    const format = frame.format as string;
    const rect = frame.visibleRect!;
    const w = rect.width;
    const h = rect.height;
    const sizes = planeSizes(format, w, h);
    const key = `${format}:${w}x${h}`;
    let slot = this.slots[slotIndex];
    if (!slot || slot.key !== key) {
      if (slot) for (const t of slot.textures) gl.deleteTexture(t);
      const textures = sizes.map(([pw, ph], i) => {
        const tex = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texStorage2D(gl.TEXTURE_2D, 1, kind === "nv12" && i === 1 ? gl.RG8 : gl.R8, pw, ph);
        setSampling(gl, gl.LINEAR);
        return tex;
      });
      slot = { key, textures, buf: slot?.buf ?? new Uint8Array(0) };
      this.slots[slotIndex] = slot;
    }
    const size = frame.allocationSize();
    if (slot.buf.length < size) slot.buf = new Uint8Array(size);
    const layout = await frame.copyTo(slot.buf);
    gl.activeTexture(gl.TEXTURE0);
    sizes.forEach(([pw, ph], i) => {
      const interleaved = kind === "nv12" && i === 1;
      gl.bindTexture(gl.TEXTURE_2D, slot!.textures[i]!);
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, interleaved ? layout[i]!.stride / 2 : layout[i]!.stride);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, pw, ph, interleaved ? gl.RG : gl.RED, gl.UNSIGNED_BYTE, slot!.buf, layout[i]!.offset);
    });
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return {
      variant: kind,
      textures: slot.textures,
      yuv: yuvConversion(frame.colorSpace),
      gamut: gamutToSrgb(frame.colorSpace.primaries),
      hasAlphaPlane: format === "I420A",
    };
  }

  private async uploadRgba(frame: VideoFrame, kind: "rgba" | "bgra" | "fallback"): Promise<Source> {
    const hit = this.rgbaCache.get(frame);
    if (hit) {
      this.rgbaCache.delete(frame);
      this.rgbaCache.set(frame, hit);
      return hit.source;
    }
    const gl = this.gl;
    const rect = frame.visibleRect!;
    const w = rect.width;
    const h = rect.height;
    let pixels: Uint8Array<ArrayBuffer> | null = null;
    let stride = 0;
    let offset = 0;
    if (kind !== "fallback") {
      try {
        const copy = new Uint8Array(frame.allocationSize());
        const layout = await frame.copyTo(copy);
        pixels = copy;
        stride = layout[0]!.stride / 4;
        offset = layout[0]!.offset;
      } catch {
        // WebKit's copyTo rejects RGBX frames; the browser's own upload still works.
      }
    }
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    setSampling(gl, gl.LINEAR);
    if (pixels) {
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, stride);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels, offset);
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    } else {
      // Opaque-format or high-bit-depth frame: slow, but the browser does the conversion.
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, frame as unknown as TexImageSource);
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    const source: Source = {
      variant: kind === "bgra" ? "bgra" : "rgba",
      textures: [tex],
      forceOpaque: frame.format === "RGBX" || frame.format === "BGRX",
    };
    this.rgbaCache.set(frame, { source });
    if (this.rgbaCache.size > RGBA_CACHE_LIMIT) {
      const [oldest, entry] = this.rgbaCache.entries().next().value as [VideoFrame, CachedFrame];
      this.rgbaCache.delete(oldest);
      for (const t of entry.source.textures) gl.deleteTexture(t);
    }
    return source;
  }

  private layerUniform(layer: CompositeLayer, rw: number, rh: number): Float32Array {
    const mat = layer.transform;
    const c = layer.crop;
    return new Float32Array([
      mat.a, mat.b, mat.c, mat.d,
      mat.e, mat.f, layer.frame.displayWidth, layer.frame.displayHeight,
      rw, rh, 0, c.left,
      c.top, c.right, c.bottom, 0,
    ]);
  }

  private drawSource(source: Source, layer: CompositeLayer, opacity: number, target: Target, rw: number, rh: number, blend: boolean, clear: boolean): void {
    const gl = this.gl;
    const prog = this.program(`source-${source.variant}`, VS_LAYER, fsSource(source.variant));
    this.begin(target, clear, blend, this.w, this.h);
    gl.useProgram(prog.p);
    const names = ["t0", "t1", "t2", "t3"];
    // t3 needs a texture bound even when unused, so I420 reuses its luma plane there.
    const bound: Array<[string, WebGLTexture]> = source.variant === "planar"
      ? names.map((n, i) => [n, source.textures[i] ?? source.textures[0]!])
      : source.textures.map((t, i) => [names[i]!, t]);
    this.bindTextures(prog, bound);
    gl.uniform4fv(prog.u.get("L") ?? null, this.layerUniform(layer, rw, rh));
    gl.uniform1f(prog.u.get("opacity") ?? null, opacity);
    if (source.yuv) {
      gl.uniformMatrix3fv(prog.u.get("yuvM") ?? null, false, source.yuv.m);
      gl.uniform3fv(prog.u.get("yuvO") ?? null, source.yuv.offset);
      gl.uniform1f(prog.u.get("gamutOn") ?? null, source.gamut ? 1 : 0);
      if (source.gamut) gl.uniformMatrix3fv(prog.u.get("gamut") ?? null, false, source.gamut);
      gl.uniform1f(prog.u.get("hasAlphaPlane") ?? null, source.hasAlphaPlane ? 1 : 0);
    } else {
      gl.uniform1f(prog.u.get("forceOpaque") ?? null, source.forceOpaque ? 1 : 0);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this.unbindTextures(bound.length);
  }

  private curveTexture(key: string, make: () => Uint8Array<ArrayBuffer>): WebGLTexture {
    const hit = this.curveCache.get(key);
    if (hit) return hit;
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, make());
    setSampling(gl, gl.LINEAR);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.curveCache.set(key, tex);
    if (this.curveCache.size > CURVE_CACHE_LIMIT) {
      const [oldest, t] = this.curveCache.entries().next().value as [string, WebGLTexture];
      this.curveCache.delete(oldest);
      gl.deleteTexture(t);
    }
    return tex;
  }

  private cubeTexture(path: string, lut: CubeLUT): WebGLTexture {
    const hit = this.lut3dTexCache.get(path);
    if (hit) return hit;
    const gl = this.gl;
    const n = lut.dimension;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_3D, tex);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA32F, n, n, n, 0, gl.RGBA, gl.FLOAT, lut.data);
    gl.bindTexture(gl.TEXTURE_3D, null);
    this.lut3dTexCache.set(path, tex);
    return tex;
  }

  private planSteps(layer: CompositeLayer, enabled: NonNullable<CompositeLayer["effects"]>, rw: number, rh: number): Step[] {
    const steps: Step[] = [];
    for (const eff of canonicalSort(enabled)) {
      const multi = multiPassStep(eff);
      if (multi) { steps.push({ kind: "multi", ...multi }); continue; }
      if (eff.type === "color.curves") {
        const str = eff.params.curve?.string;
        steps.push({ type: eff.type, kind: "curves", lut: this.curveTexture(`c:${str ?? ""}`, () => curvesLutData(parseGradeCurve(str))) });
        continue;
      }
      if (eff.type === "color.hueCurves") {
        const str = eff.params.curves?.string;
        steps.push({ type: eff.type, kind: "curves", lut: this.curveTexture(`h:${str ?? ""}`, () => hueCurvesLutData(parseHueCurves(str))) });
        continue;
      }
      if (eff.type === "color.lut") {
        const path = eff.params.path?.string ?? "";
        const cube = this.cubeLUTs.get(path);
        if (!cube) continue;
        const data = new Float32Array([resolveParam(eff.params.intensity, 0, 1), cube.dimension, 0, 0]);
        steps.push({ type: eff.type, kind: "lut3d", tex: this.cubeTexture(path, cube), data });
        continue;
      }
      const data = effectUniformData(eff, rw, rh);
      if (data) steps.push({ type: eff.type, kind: "plain", data });
    }
    return steps;
  }

  // Runs one effect and returns the [ping, pong] pair for the next, mirroring FrameRenderer's swaps.
  private runStep(step: Step, ping: Target, pong: Target, rw: number, rh: number): [Target, Target] {
    if (step.kind === "plain") {
      this.fullscreen(`fx:${step.type}`, FS_EFFECTS[step.type]!, pong, [["src", ping.tex]], (p) => this.setU(p, step.data));
      return [pong, ping];
    }
    if (step.kind === "curves") {
      const fs = step.type === "color.curves" ? FS_CURVES : FS_HUE_CURVES;
      this.fullscreen(`fx:${step.type}`, fs, pong, [["src", ping.tex], ["lut", step.lut]]);
      return [pong, ping];
    }
    if (step.kind === "lut3d") {
      this.fullscreen("fx:color.lut", FS_LUT3D, pong, [["src", ping.tex], ["lut3d", step.tex, this.gl.TEXTURE_3D]], (p) => this.setU(p, step.data));
      return [pong, ping];
    }
    const scratch = this.fxScratch;
    const fx2 = (key: string, fs: string, target: Target, blurred: Target, u: number[]) =>
      this.fullscreen(key, fs, target, [["texA", blurred.tex], ["texB", scratch.tex]], (p) => this.setU(p, u));
    switch (step.type) {
      case "blur.gaussian": {
        const radius = step.gaussRadius ?? 8;
        this.gauss(ping, scratch, 1 / rw, 0, radius);
        this.gauss(scratch, pong, 0, 1 / rh, radius);
        return [pong, ping];
      }
      case "blur.sharpen":
        this.copyFx(ping, scratch);
        this.gauss(ping, pong, 1 / rw, 0, 2);
        this.gauss(pong, ping, 0, 1 / rh, 2);
        fx2("fx2:sharpen", FS_SHARPEN_FX2, pong, ping, [step.sharpenAmount ?? 0.4]);
        return [pong, ping];
      case "blur.noiseReduction":
        this.copyFx(ping, scratch);
        this.gauss(ping, pong, 1 / rw, 0, 2);
        this.gauss(pong, ping, 0, 1 / rh, 2);
        fx2("fx2:noiseReduction", FS_NOISE_RED_FX2, pong, ping, [step.noiseRedAmount ?? 0]);
        return [pong, ping];
      case "detail.clarity":
        this.copyFx(ping, scratch);
        this.gauss(ping, pong, 1 / rw, 0, 20);
        this.gauss(pong, ping, 0, 1 / rh, 20);
        fx2("fx2:clarity", FS_CLARITY_FX2, pong, ping, [step.clarityClarity ?? 0, step.clarityDehaze ?? 0]);
        return [pong, ping];
      case "stylize.glow": {
        this.copyFx(ping, scratch);
        this.fullscreen("glow-thresh", FS_GLOW_THRESH, pong, [["src", ping.tex]], (p) => this.setU(p, [step.glowThreshold ?? 0.6]));
        const radius = step.glowRadius ?? 20;
        this.gauss(pong, ping, 1 / rw, 0, radius);
        this.gauss(ping, pong, 0, 1 / rh, radius);
        // The result lands in ping with no swap, as in FrameRenderer.
        fx2("fx2:glow", FS_GLOW_FX2, ping, pong, [step.glowIntensity ?? 0, step.glowWarmth ?? 0]);
        return [ping, pong];
      }
      default:
        return [ping, pong];
    }
  }

  composite(layers: CompositeLayer[], renderSize: Size): Promise<void> {
    const run = this.queue.then(() => this.compositeNow(layers, renderSize));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async compositeNow(layers: CompositeLayer[], renderSize: Size): Promise<void> {
    if (this.lost) return;
    const gl = this.gl;
    const rw = renderSize.width;
    const rh = renderSize.height;
    if (this.w !== rw || this.h !== rh) {
      this.freeTargets();
      this.allocTargets(rw, rh);
    }

    // Copy and upload first: copyTo is the only async step, and a frame shared by two layers is
    // uploaded once.
    const byFrame = new Map<VideoFrame, Source>();
    const pending: Array<Promise<void>> = [];
    let slotIndex = 0;
    for (const layer of layers) {
      if (byFrame.has(layer.frame)) continue;
      byFrame.set(layer.frame, undefined as unknown as Source);
      const slot = slotIndex++;
      pending.push(this.uploadSource(layer.frame, slot).then((s) => { byFrame.set(layer.frame, s); }));
    }
    await Promise.all(pending);
    if (this.lost) return;

    let curAccum = this.accumA;
    let otherAccum = this.accumB;
    this.begin(curAccum, true, false, rw, rh);

    for (const layer of layers) {
      const source = byFrame.get(layer.frame)!;
      const enabled = (layer.effects ?? []).filter((e) => e.enabled);
      const bm: BlendMode | undefined = layer.blendMode;
      const normalBlend = bm === undefined || bm === "normal";

      if (enabled.length === 0 && normalBlend && layer.stencil !== true) {
        this.drawSource(source, layer, layer.opacity, curAccum, rw, rh, true, false);
        continue;
      }

      if (layer.stencil === true) {
        const matte = layer.matteColor ?? { r: 0, g: 0, b: 0, a: 1 };
        this.drawSource(source, layer, 1, this.fxPing, rw, rh, false, true);
        this.fullscreen("stencil", FS_STENCIL, otherAccum, [["maskTex", this.fxPing.tex], ["dstTex", curAccum.tex]], (p) => {
          gl.uniform4f(p.u.get("matte") ?? null, matte.r, matte.g, matte.b, matte.a);
          gl.uniform1f(p.u.get("opacity") ?? null, layer.opacity);
        });
        [curAccum, otherAccum] = [otherAccum, curAccum];
        continue;
      }

      let ping = this.fxPing;
      let pong = this.fxPong;
      this.drawSource(source, layer, 1, ping, rw, rh, false, true);
      for (const step of this.planSteps(layer, enabled, rw, rh)) {
        [ping, pong] = this.runStep(step, ping, pong, rw, rh);
      }

      if (!normalBlend) {
        const mode = BLEND_MODES.indexOf(bm!);
        this.fullscreen("blend", FS_BLEND, otherAccum, [["srcTex", ping.tex], ["dstTex", curAccum.tex]], (p) => {
          gl.uniform1i(p.u.get("mode") ?? null, mode);
          gl.uniform1f(p.u.get("opacity") ?? null, layer.opacity);
        });
        [curAccum, otherAccum] = [otherAccum, curAccum];
      } else {
        this.fullscreen("composite", FS_COMPOSITE, curAccum, [["src", ping.tex]], (p) => {
          gl.uniform1f(p.u.get("opacity") ?? null, layer.opacity);
        }, true);
      }
    }

    // Canvas blit. The rgba8 readback copy is deferred until someone reads.
    const blit = this.program("blit-canvas", VS_CANVAS, FS_BLIT);
    this.begin(null, false, false, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.useProgram(blit.p);
    this.bindTextures(blit, [["src", curAccum.tex]]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this.unbindTextures(1);
    gl.flush();
    this.readbackSource = curAccum;
  }

  async present(frame: VideoFrame, mat: Mat2d, renderSize: Size): Promise<void> {
    return this.composite(
      [{ frame, transform: mat, opacity: 1, crop: { left: 0, top: 0, right: 0, bottom: 0 } }],
      renderSize,
    );
  }

  private prepareReadback(): void {
    if (this.readbackSource) {
      this.fullscreen("blit", FS_BLIT, this.readback, [["src", this.readbackSource.tex]]);
      this.readbackSource = null;
    }
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.readback.fbo);
  }

  async readRGBA(): Promise<Uint8Array> {
    await this.queue;
    const gl = this.gl;
    this.prepareReadback();
    const out = new Uint8Array(this.w * this.h * 4);
    gl.readPixels(0, 0, this.w, this.h, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return out;
  }

  async readPixel(x: number, y: number): Promise<[number, number, number, number]> {
    await this.queue;
    const gl = this.gl;
    this.prepareReadback();
    const out = new Uint8Array(4);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return [out[0]!, out[1]!, out[2]!, out[3]!];
  }

  resize(w: number, h: number): void {
    if (typeof HTMLCanvasElement === "undefined" || !(this.canvas instanceof HTMLCanvasElement)) {
      // resize() is for the live preview canvas only; offscreen export renderers are fixed-size
      return;
    }
    this.canvas.width = w;
    this.canvas.height = h;
    this.freeTargets();
    this.allocTargets(w, h);
  }

  registerLUT(path: string, cube: CubeLUT): void {
    this.cubeLUTs.set(path, cube);
    const old = this.lut3dTexCache.get(path);
    if (old) { this.gl.deleteTexture(old); this.lut3dTexCache.delete(path); }
  }

  dispose(): void {
    const gl = this.gl;
    this.canvas.removeEventListener("webglcontextlost", this.onLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onRestored);
    for (const slot of this.slots) for (const t of slot.textures) gl.deleteTexture(t);
    for (const entry of this.rgbaCache.values()) for (const t of entry.source.textures) gl.deleteTexture(t);
    for (const t of this.curveCache.values()) gl.deleteTexture(t);
    for (const t of this.lut3dTexCache.values()) gl.deleteTexture(t);
    for (const prog of this.programs.values()) gl.deleteProgram(prog.p);
    this.freeTargets();
    gl.deleteVertexArray(this.vao);
    this.slots = [];
    this.rgbaCache.clear();
    this.curveCache.clear();
    this.lut3dTexCache.clear();
    this.programs.clear();
  }
}
