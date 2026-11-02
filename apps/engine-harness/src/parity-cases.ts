// Fixtures rendered through both backends. Shared with apps/studio-tauri so the WebKit run uses the
// same sources; every source except text comes from fixed bytes, so it doesn't vary by browser.
import {
  ImageSource, TextRasterizer, demuxMp4, type CompositeLayer, type Renderer,
} from "@frontstage/engine";
import {
  affineTransform, defaultTransform, defaultCrop, defaultTextStyle, BLEND_MODES,
  type Effect, type BlendMode, type TextLayer, type CubeLUT, type Size,
} from "@frontstage/core";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- Vite ?url suffix not typed here
import clipUrl from "../../../packages/engine/test/fixtures/clip.mp4?url";

export const W = 160;
export const H = 90;
const SIZE: Size = { width: W, height: H };

// Default tolerance in 8-bit levels, per channel. A case may only widen it with a stated reason.
export const DEFAULT_TOLERANCE = 2;

export interface ParityCase {
  name: string;
  /** null: this browser can't construct the source (WebKit rejects BT.2020 tags and odd-sized I420, and drops visibleRect offsets). */
  layers: (s: Sources) => CompositeLayer[] | null;
  tolerance?: number;
  /** Why this case needs more than DEFAULT_TOLERANCE, or why it's report-only. */
  note?: string;
  /** Compared and reported, but a difference doesn't fail the run. */
  reportOnly?: boolean;
  /** Source pixels depend on the browser (text raster, H.264 decoder output), so a difference against Chromium is reported, not failed. */
  browserRaster?: boolean;
}

function patternPixel(x: number, y: number): [number, number, number, number] {
  const u = x / (W - 1);
  const v = y / (H - 1);
  // Colour bars across the top third, smooth ramps below, a bright block for glow and clarity.
  if (y < H / 3) {
    const bars: Array<[number, number, number]> = [
      [235, 235, 235], [230, 220, 30], [30, 220, 220], [30, 210, 40], [220, 30, 210], [220, 40, 30], [30, 40, 220], [20, 20, 20],
    ];
    const b = bars[Math.min(7, Math.floor(u * 8))]!;
    return [b[0], b[1], b[2], 255];
  }
  if (x > W * 0.7 && y > H * 0.6) return [250, 245, 235, 255];
  return [Math.round(u * 255), Math.round(v * 255), Math.round((1 - u) * 200 + 20), 255];
}

function rgbaPattern(alpha?: (x: number, y: number) => number, swapRB = false): Uint8Array<ArrayBuffer> {
  const d = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [r, g, b, a] = patternPixel(x, y);
      const i = (y * W + x) * 4;
      d[i] = swapRB ? b : r;
      d[i + 1] = g;
      d[i + 2] = swapRB ? r : b;
      d[i + 3] = alpha ? alpha(x, y) : a;
    }
  }
  return d;
}

function rawFrame(format: VideoPixelFormat, data: Uint8Array<ArrayBuffer>): VideoFrame {
  return new VideoFrame(data, { format, codedWidth: W, codedHeight: H, timestamp: 0 });
}

function bitmapFrame(data: Uint8Array<ArrayBuffer>): VideoFrame {
  const c = new OffscreenCanvas(W, H);
  c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(data.buffer), W, H), 0, 0);
  return new VideoFrame(c.transferToImageBitmap(), { timestamp: 0 });
}

function solid(r: number, g: number, b: number): VideoFrame {
  const d = new Uint8Array(W * H * 4);
  for (let i = 0; i < d.length; i += 4) { d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255; }
  return bitmapFrame(d);
}

// Y' ramp across x, chroma ramps across y, so every code value and matrix term gets exercised.
function yuvFrame(format: "I420" | "NV12", colorSpace: VideoColorSpaceInit): VideoFrame {
  const cw = W >> 1;
  const ch = H >> 1;
  const size = W * H + cw * ch * 2;
  const d = new Uint8Array(size);
  const limited = colorSpace.fullRange !== true;
  const lo = limited ? 16 : 0;
  const hi = limited ? 235 : 255;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) d[y * W + x] = Math.round(lo + (hi - lo) * (x / (W - 1)));
  const uAt = (x: number, y: number) => Math.round(128 + 80 * Math.sin(x / 6) * (y / (ch - 1)));
  const vAt = (x: number, y: number) => Math.round(128 + 80 * Math.cos(y / 4) * (x / (cw - 1)));
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      if (format === "I420") {
        d[W * H + y * cw + x] = uAt(x, y);
        d[W * H + cw * ch + y * cw + x] = vAt(x, y);
      } else {
        d[W * H + y * W + x * 2] = uAt(x, y);
        d[W * H + y * W + x * 2 + 1] = vAt(x, y);
      }
    }
  }
  return new VideoFrame(d, { format, codedWidth: W, codedHeight: H, timestamp: 0, colorSpace });
}

// Odd dimensions: chroma planes round up.
function oddI420(): VideoFrame {
  const w = 161, h = 91, cw = 81, ch = 46;
  const d = new Uint8Array(w * h + cw * ch * 2);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d[y * w + x] = 16 + Math.round((219 * x) / (w - 1));
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    d[w * h + y * cw + x] = 128 + Math.round((60 * y) / (ch - 1));
    d[w * h + cw * ch + y * cw + x] = 128 - Math.round((60 * x) / (cw - 1));
  }
  return new VideoFrame(d, { format: "I420", codedWidth: w, codedHeight: h, timestamp: 0, colorSpace: { matrix: "bt709", primaries: "bt709", transfer: "bt709", fullRange: false } });
}

// Coded larger than visible, like 1920x1088 H.264 showing 1080 rows. The pad is red so reading it shows.
function croppedI420(): VideoFrame | undefined {
  const cw = W + 8, chh = H + 6, ccw = cw >> 1, cch = chh >> 1;
  const d = new Uint8Array(cw * chh + ccw * cch * 2);
  d.fill(81, 0, cw * chh);
  d.fill(90, cw * chh, cw * chh + ccw * cch);
  d.fill(240, cw * chh + ccw * cch);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) d[(y + 2) * cw + x + 4] = 16 + Math.round((219 * x) / (W - 1));
  for (let y = 0; y < H >> 1; y++) for (let x = 0; x < W >> 1; x++) {
    d[cw * chh + (y + 1) * ccw + x + 2] = 128;
    d[cw * chh + ccw * cch + (y + 1) * ccw + x + 2] = 128;
  }
  const f = new VideoFrame(d, {
    format: "I420", codedWidth: cw, codedHeight: chh, timestamp: 0,
    visibleRect: { x: 4, y: 2, width: W, height: H },
    colorSpace: { matrix: "bt709", primaries: "bt709", transfer: "bt709", fullRange: false },
  });
  // WebKit's constructor drops the offset and the coded size, so the frame isn't what was asked for.
  if (f.codedWidth === cw) return f;
  f.close();
  return undefined;
}

function warmCube(): CubeLUT {
  const n = 17;
  const data = new Float32Array(n * n * n * 4);
  for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) {
    const i = (b * n * n + g * n + r) * 4;
    const R = r / (n - 1), G = g / (n - 1), B = b / (n - 1);
    data[i] = Math.pow(R, 0.8);
    data[i + 1] = G * G * 0.3 + G * 0.7;
    data[i + 2] = 0.1 + 0.8 * B * (1 - 0.3 * R);
    data[i + 3] = 1;
  }
  return { dimension: n, data };
}

function textLayer(text: string, over: Partial<TextLayer["style"]> = {}): TextLayer {
  return {
    clipId: "t",
    text,
    style: {
      ...defaultTextStyle(),
      fontName: "Helvetica",
      color: { r: 1, g: 1, b: 1, a: 1 },
      fontSize: 30,
      fontScale: 1,
      shadow: { enabled: false, color: { r: 0, g: 0, b: 0, a: 0.6 }, offsetX: 0, offsetY: -2, blur: 6 },
      background: { enabled: false, color: { r: 0, g: 0, b: 0, a: 0.6 } },
      border: { enabled: false, color: { r: 0, g: 0, b: 0, a: 1 } },
      ...over,
    },
    transform: defaultTransform(),
    opacity: 1,
    zIndex: 1,
  };
}

export class Sources {
  readonly frames: VideoFrame[] = [];
  private raster = new TextRasterizer();
  rgba!: VideoFrame;
  bgra!: VideoFrame;
  rgbx!: VideoFrame;
  rgbxOpaque!: VideoFrame;
  bitmap!: VideoFrame;
  bitmapMirror!: VideoFrame;
  bitmapAlpha!: VideoFrame;
  rawAlpha!: VideoFrame;
  image!: ImageSource;
  second!: VideoFrame;
  mask!: VideoFrame;
  grey!: VideoFrame;
  i420b709!: VideoFrame;
  i420b601!: VideoFrame;
  i420full!: VideoFrame;
  i4202020?: VideoFrame;
  nv12!: VideoFrame;
  odd?: VideoFrame;
  cropped?: VideoFrame;
  h264?: VideoFrame;
  text!: VideoFrame;
  textFx!: VideoFrame;
  textStencil!: VideoFrame;
  textBlur!: VideoFrame;
  full = affineTransform(defaultTransform(), SIZE, SIZE);

  private keep(f: VideoFrame): VideoFrame { this.frames.push(f); return f; }

  static async create(): Promise<Sources> {
    const s = new Sources();
    const alpha = (x: number, y: number) => Math.round(255 * (x / (W - 1)) * (0.25 + 0.75 * (y / (H - 1))));
    s.rgba = s.keep(rawFrame("RGBA", rgbaPattern()));
    s.bgra = s.keep(rawFrame("BGRA", rgbaPattern(undefined, true)));
    s.rgbx = s.keep(rawFrame("RGBX", rgbaPattern(() => 77)));
    s.rgbxOpaque = s.keep(rawFrame("RGBX", rgbaPattern()));
    s.bitmap = s.keep(bitmapFrame(rgbaPattern()));
    const mirrored = new Uint8Array(W * H * 4);
    const fwd = rgbaPattern();
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const from = ((H - 1 - y) * W + (W - 1 - x)) * 4;
      mirrored.set(fwd.subarray(from, from + 4), (y * W + x) * 4);
    }
    s.bitmapMirror = s.keep(bitmapFrame(mirrored));
    s.bitmapAlpha = s.keep(bitmapFrame(rgbaPattern(alpha)));
    s.rawAlpha = s.keep(rawFrame("RGBA", rgbaPattern(alpha)));
    s.second = s.keep(solid(60, 120, 200));
    s.grey = s.keep(solid(128, 128, 128));
    const maskData = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      maskData[i] = maskData[i + 1] = maskData[i + 2] = 255;
      maskData[i + 3] = x > W / 4 && x < (3 * W) / 4 ? 255 : Math.round((255 * y) / (H - 1));
    }
    s.mask = s.keep(bitmapFrame(maskData));
    const pngCanvas = new OffscreenCanvas(W, H);
    pngCanvas.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(rgbaPattern().buffer), W, H), 0, 0);
    s.image = await ImageSource.create(await (await pngCanvas.convertToBlob({ type: "image/png" })).arrayBuffer());
    s.i420b709 = s.keep(yuvFrame("I420", { matrix: "bt709", primaries: "bt709", transfer: "bt709", fullRange: false }));
    s.i420b601 = s.keep(yuvFrame("I420", { matrix: "smpte170m", primaries: "smpte170m", transfer: "smpte170m", fullRange: false }));
    s.i420full = s.keep(yuvFrame("I420", { matrix: "bt709", primaries: "bt709", transfer: "bt709", fullRange: true }));
    try {
      s.i4202020 = s.keep(yuvFrame("I420", { matrix: "bt2020-ncl" as VideoMatrixCoefficients, primaries: "bt709", transfer: "bt709", fullRange: false }));
    } catch { /* WebKit's VideoFrame constructor has no bt2020-ncl */ }
    s.nv12 = s.keep(yuvFrame("NV12", { matrix: "bt709", primaries: "bt709", transfer: "bt709", fullRange: false }));
    try {
      s.odd = s.keep(oddI420());
    } catch { /* WebKit's VideoFrame constructor rejects odd-sized I420 */ }
    s.cropped = croppedI420();
    if (s.cropped) s.keep(s.cropped);
    s.h264 = await decodeClipFrame();
    if (s.h264) s.frames.push(s.h264);
    s.text = s.raster.rasterize(textLayer("Text gG"), SIZE);
    s.textFx = s.raster.rasterize(textLayer("Styled", {
      color: { r: 1, g: 0.8, b: 0.2, a: 1 },
      shadow: { enabled: true, color: { r: 0, g: 0, b: 0, a: 0.8 }, offsetX: 2, offsetY: 2, blur: 4 },
      background: { enabled: true, color: { r: 0.1, g: 0.1, b: 0.5, a: 0.6 } },
      border: { enabled: true, color: { r: 0, g: 0, b: 0, a: 1 } },
    }), SIZE);
    s.textStencil = s.raster.rasterize(textLayer("FILL", { fontSize: 50 }), SIZE);
    s.textBlur = s.raster.rasterize(textLayer("Blur", { blur: 4 } as Partial<TextLayer["style"]>), SIZE);
    return s;
  }

  dispose(): void {
    for (const f of this.frames) f.close();
    this.image.dispose();
    this.raster.dispose();
  }
}

async function decodeClipFrame(): Promise<VideoFrame | undefined> {
  const bytes = await (await fetch(clipUrl as string)).arrayBuffer();
  const video = (await demuxMp4(new Blob([bytes]))).video;
  if (!video) return undefined;
  const view = new Uint8Array(bytes);
  const out: VideoFrame[] = [];
  const dec = new VideoDecoder({ output: (f) => out.push(f), error: () => undefined });
  dec.configure({ codec: video.codec, codedWidth: video.codedWidth, codedHeight: video.codedHeight, ...(video.description ? { description: video.description } : {}) });
  for (const s of video.samples.slice(0, 8)) {
    dec.decode(new EncodedVideoChunk({ type: s.isSync ? "key" : "delta", timestamp: s.cts, data: view.subarray(s.byteOffset, s.byteOffset + s.size) }));
  }
  await dec.flush();
  dec.close();
  out.sort((a, b) => a.timestamp - b.timestamp);
  const pick = out[Math.min(5, out.length - 1)];
  for (const f of out) if (f !== pick) f.close();
  return pick;
}

const fx = (type: string, params: Effect["params"] = {}): Effect => ({ id: type, type, enabled: true, params });
const v = (value: number) => ({ value });

const EFFECTS: Array<[string, Effect[]]> = [
  ["saturation", [fx("color.saturation", { amount: v(0.4) })]],
  ["saturation-boost", [fx("color.saturation", { amount: v(1.7) })]],
  ["exposure-up", [fx("color.exposure", { ev: v(1.2) })]],
  ["exposure-down", [fx("color.exposure", { ev: v(-1.5) })]],
  ["contrast", [fx("color.contrast", { amount: v(1.4) })]],
  ["highlights-shadows", [fx("color.highlightsShadows", { highlights: v(-0.6), shadows: v(0.7) })]],
  ["blacks-whites", [fx("color.blacksWhites", { blacks: v(0.5), whites: v(-0.5) })]],
  ["temperature", [fx("color.temperature", { temperature: v(9000), tint: v(30) })]],
  ["vibrance", [fx("color.vibrance", { amount: v(0.7) })]],
  ["wheels", [fx("color.wheels", {
    lift_x: v(0.3), lift_y: v(-0.2), lift_m: v(0.05),
    gamma_x: v(-0.4), gamma_y: v(0.3), gamma_m: v(1.2),
    gain_x: v(0.2), gain_y: v(0.5), gain_m: v(0.9),
  })]],
  ["curves", [fx("color.curves", { curve: { string: JSON.stringify({
    master: [{ x: 0, y: 0 }, { x: 0.5, y: 0.7 }, { x: 1, y: 1 }],
    red: [{ x: 0, y: 0.05 }, { x: 0.6, y: 0.5 }, { x: 1, y: 1 }],
    blue: [{ x: 0, y: 0 }, { x: 0.4, y: 0.55 }, { x: 1, y: 0.9 }],
  }) } })]],
  ["hue-curves", [fx("color.hueCurves", { curves: { string: JSON.stringify({
    hueVsHue: [{ x: 0, y: 0.7 }, { x: 0.5, y: 0.4 }, { x: 1, y: 0.7 }],
    hueVsSat: [{ x: 0, y: 0.8 }, { x: 0.33, y: 0.3 }, { x: 1, y: 0.8 }],
    hueVsLum: [{ x: 0, y: 0.4 }, { x: 0.66, y: 0.7 }, { x: 1, y: 0.4 }],
  }) } })]],
  ["lut-3d", [fx("color.lut", { path: { string: "warm" }, intensity: v(1) })]],
  ["lut-3d-half", [fx("color.lut", { path: { string: "warm" }, intensity: v(0.5) })]],
  ["lut-missing-is-skipped", [fx("color.lut", { path: { string: "not-registered" }, intensity: v(1) })]],
  ["chroma-key", [fx("key.chroma", { keyHue: v(0.333), tolerance: v(0.4), softness: v(0.5), spill: v(0.7) })]],
  ["chroma-key-red", [fx("key.chroma", { keyHue: v(0.0), tolerance: v(0.3), softness: v(0.2), spill: v(0.3) })]],
  ["vignette", [fx("stylize.vignette", { amount: v(-0.8), midpoint: v(0.3), roundness: v(0.4), feather: v(0.6) })]],
  ["invert", [fx("stylize.invert")]],
  ["gaussian-small", [fx("blur.gaussian", { radius: v(3) })]],
  ["gaussian-large", [fx("blur.gaussian", { radius: v(30) })]],
  ["motion-blur", [fx("blur.motion", { radius: v(12), angle: v(30) })]],
  ["sharpen", [fx("blur.sharpen", { amount: v(1.2) })]],
  ["noise-reduction", [fx("blur.noiseReduction", { amount: v(0.7) })]],
  ["clarity", [fx("detail.clarity", { clarity: v(0.6), dehaze: v(0.4) })]],
  ["glow", [fx("stylize.glow", { intensity: v(0.8), radius: v(12), threshold: v(0.5), warmth: v(0.6) })]],
  ["chain-all-colour", [
    fx("color.exposure", { ev: v(0.3) }), fx("color.contrast", { amount: v(1.1) }), fx("color.saturation", { amount: v(1.2) }),
    fx("blur.gaussian", { radius: v(4) }), fx("stylize.vignette", { amount: v(-0.4), midpoint: v(0.5), roundness: v(0), feather: v(0.5) }),
    fx("stylize.glow", { intensity: v(0.3), radius: v(8), threshold: v(0.7), warmth: v(0.2) }),
  ]],
  ["disabled-effect-ignored", [{ ...fx("stylize.invert"), enabled: false }, fx("color.contrast", { amount: v(1.2) })]],
];

const crop = defaultCrop;

const YUV_REF_NOTE = "Chromium's reference converts CPU-backed YUV frames through an RGBA8 intermediate; WebGL2 keeps float precision, which shows at near-neutral values in colorBurn/colorDodge/hue blends and when resampling chroma";

function build(): ParityCase[] {
  const out: ParityCase[] = [];
  const add = (name: string, layers: ParityCase["layers"], extra: Partial<ParityCase> = {}) => out.push({ name, layers, ...extra });
  const base = (s: Sources, frame: VideoFrame, over: Partial<CompositeLayer> = {}): CompositeLayer =>
    ({ frame, transform: s.full, opacity: 1, crop: crop(), ...over });

  add("empty", () => []);
  add("source-raw-rgba", (s) => [base(s, s.rgba)]);
  add("source-raw-bgra", (s) => [base(s, s.bgra)]);
  add("source-raw-rgbx", (s) => [base(s, s.rgbxOpaque)]);
  add("source-raw-rgbx-stray-x-byte", (s) => [base(s, s.rgbx)], {
    reportOnly: true,
    note: "X byte isn't 255: Chromium's WebGPU path uses it as alpha, WebGL2 follows the spec and ignores it",
  });
  add("source-bitmap", (s) => [base(s, s.bitmap)]);
  add("source-bitmap-alpha", (s) => [base(s, s.second), base(s, s.bitmapAlpha)]);
  add("source-raw-alpha", (s) => [base(s, s.second), base(s, s.rawAlpha)]);
  add("source-image", (s) => [base(s, s.image.frame())]);
  add("source-i420-bt709-limited", (s) => [base(s, s.i420b709)]);
  add("source-i420-smpte170m-limited", (s) => [base(s, s.i420b601)]);
  add("source-i420-bt709-full", (s) => [base(s, s.i420full)]);
  add("source-i420-bt2020-matrix", (s) => (s.i4202020 ? [base(s, s.i4202020)] : null));
  add("source-nv12-bt709-limited", (s) => [base(s, s.nv12)]);
  add("source-i420-odd-size", (s) => (s.odd ? [base(s, s.odd, { transform: { a: W / 161, b: 0, c: 0, d: H / 91, e: 0, f: 0 } })] : null), { tolerance: 4, note: YUV_REF_NOTE });
  add("source-i420-visible-rect", (s) => (s.cropped ? [base(s, s.cropped)] : null));
  add("source-h264-decoded", (s) => (s.h264 ? [base(s, s.h264)] : []), { browserRaster: true });

  for (const [name, effects] of EFFECTS) add(`effect-${name}`, (s) => [base(s, s.bitmap, { effects })]);
  add("effect-grain", (s) => [base(s, s.bitmap, { effects: [fx("stylize.grain", { amount: v(0.5), size: v(1.5) })] })], {
    reportOnly: true,
    note: "sin-hash noise; the hash may legitimately differ between GPU APIs",
  });
  add("effect-on-alpha-source", (s) => [base(s, s.second), base(s, s.bitmapAlpha, { effects: [fx("color.saturation", { amount: v(0.2) }), fx("blur.gaussian", { radius: v(6) })] })]);
  add("effect-on-yuv-source", (s) => [base(s, s.i420b709, { effects: [fx("color.exposure", { ev: v(0.5) }), fx("color.vibrance", { amount: v(0.4) })] })]);

  for (const mode of BLEND_MODES as readonly BlendMode[]) {
    add(`blend-${mode}`, (s) => [base(s, s.bitmap), base(s, s.bitmapMirror, { blendMode: mode, opacity: 0.8 })]);
    const singular = mode === "colorBurn" || mode === "colorDodge" || mode === "hue";
    add(`blend-${mode}-yuv-top`, (s) => [base(s, s.bitmap), base(s, s.i420b709, { blendMode: mode, opacity: 0.8 })], singular ? { reportOnly: true, note: YUV_REF_NOTE } : {});
    add(`blend-${mode}-alpha-over-transparent`, (s) => [base(s, s.bitmapAlpha, { transform: s.full }), base(s, s.rawAlpha, { blendMode: mode, opacity: 0.6 })]);
  }

  add("stencil-footage-fill", (s) => [base(s, s.bitmap), base(s, s.textStencil, { stencil: true, matteColor: { r: 0, g: 0, b: 0, a: 1 } })], { browserRaster: true });
  add("stencil-mask-soft-matte", (s) => [base(s, s.bitmap), base(s, s.mask, { stencil: true, matteColor: { r: 0.8, g: 0.1, b: 0.2, a: 0.7 }, opacity: 0.8 })]);
  add("stencil-default-matte", (s) => [base(s, s.i420b709), base(s, s.mask, { stencil: true })]);

  add("crop", (s) => [base(s, s.second), base(s, s.bitmap, { crop: { left: 0.1, top: 0.2, right: 0.25, bottom: 0.05 } })]);
  add("transform-scale-offset", (s) => [base(s, s.second), base(s, s.bitmap, { transform: { a: 0.5, b: 0, c: 0, d: 0.5, e: 30, f: 20 } })]);
  add("transform-subpixel", (s) => [base(s, s.second), base(s, s.bitmap, { transform: { a: 0.61, b: 0, c: 0, d: 0.47, e: 17.3, f: 11.7 } })]);
  add("transform-upscale", (s) => [base(s, s.bitmap, { transform: { a: 2.3, b: 0, c: 0, d: 2.3, e: -40, f: -30 } })]);
  add("transform-rotate", (s) => [base(s, s.second), base(s, s.bitmap, { transform: { a: 0.6, b: 0.3, c: -0.3, d: 0.6, e: 50, f: 5 } })]);
  add("transform-flip", (s) => [base(s, s.bitmap, { transform: { a: -1, b: 0, c: 0, d: -1, e: W, f: H } })]);
  add("opacity", (s) => [base(s, s.second), base(s, s.bitmap, { opacity: 0.35 })]);
  add("opacity-over-transparent", (s) => [base(s, s.bitmap, { opacity: 0.4 })]);
  add("crop-transform-opacity-effect", (s) => [base(s, s.i420b709), base(s, s.bitmap, {
    crop: { left: 0.2, top: 0.1, right: 0.1, bottom: 0.2 }, transform: { a: 0.7, b: 0, c: 0, d: 0.7, e: 25, f: 10 }, opacity: 0.7,
    effects: [fx("color.contrast", { amount: v(1.3) })],
  })]);
  add("multi-layer-3", (s) => [base(s, s.bitmap), base(s, s.nv12, { transform: { a: 0.5, b: 0, c: 0, d: 0.5, e: 0, f: 0 } }), base(s, s.bitmapAlpha, { opacity: 0.8 })], { tolerance: 4, note: YUV_REF_NOTE });
  add("multi-layer-mixed-pipeline", (s) => [
    base(s, s.bitmap),
    base(s, s.i420b709, { blendMode: "screen", opacity: 0.5 }),
    base(s, s.rgba, { transform: { a: 0.4, b: 0, c: 0, d: 0.4, e: 80, f: 40 }, effects: [fx("stylize.invert")] }),
    base(s, s.mask, { stencil: true, matteColor: { r: 0, g: 0, b: 0, a: 1 } }),
    base(s, s.second, { opacity: 0.2 }),
  ]);
  add("same-frame-twice", (s) => [base(s, s.i420b709), base(s, s.i420b709, { transform: { a: 0.5, b: 0, c: 0, d: 0.5, e: 40, f: 20 }, opacity: 0.5 })], { tolerance: 4, note: YUV_REF_NOTE });
  add("dissolve-a-b", (s) => [base(s, s.bitmap, { opacity: 0.65 }), base(s, s.i420b709, { opacity: 0.35 })]);
  add("dissolve-with-effect", (s) => [base(s, s.grey), base(s, s.bitmap, { opacity: 0.5, effects: [fx("color.saturation", { amount: v(0) })] }), base(s, s.nv12, { opacity: 0.5 })]);

  add("text-plain", (s) => [base(s, s.bitmap), base(s, s.text)], { browserRaster: true });
  add("text-styled", (s) => [base(s, s.bitmap), base(s, s.textFx, { opacity: 0.9 })], { browserRaster: true });
  add("text-on-transparent", (s) => [base(s, s.text)], { browserRaster: true });
  add("text-with-effect", (s) => [base(s, s.bitmap), base(s, s.textFx, { effects: [fx("blur.gaussian", { radius: v(2) })] })], { browserRaster: true });
  add("text-blur-style", (s) => [base(s, s.bitmap), base(s, s.textBlur)], { browserRaster: true });
  return out;
}

export const PARITY_CASES = build();

export function registerParityLUTs(r: Renderer): void {
  r.registerLUT("warm", warmCube());
}

export interface Diff {
  maxDiff: number;
  meanAbs: number;
  overTol: number;
  worst: { x: number; y: number; a: number[]; b: number[] } | null;
}

export function compareRGBA(a: Uint8Array, b: Uint8Array, tol: number): Diff {
  let maxDiff = 0;
  let sum = 0;
  let overTol = 0;
  let worstAt = -1;
  for (let i = 0; i < a.length; i += 4) {
    let px = 0;
    for (let c = 0; c < 4; c++) {
      const d = Math.abs(a[i + c]! - b[i + c]!);
      sum += d;
      if (d > px) px = d;
    }
    if (px > tol) overTol++;
    if (px > maxDiff) { maxDiff = px; worstAt = i; }
  }
  const worst = worstAt < 0 ? null : {
    x: (worstAt / 4) % W,
    y: Math.floor(worstAt / 4 / W),
    a: [...a.subarray(worstAt, worstAt + 4)],
    b: [...b.subarray(worstAt, worstAt + 4)],
  };
  return { maxDiff, meanAbs: +(sum / a.length).toFixed(3), overTol, worst };
}
