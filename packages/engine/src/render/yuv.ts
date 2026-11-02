// Y'CbCr to R'G'B' conversion picked from a VideoFrame's colorSpace.

export interface YuvColorSpace {
  matrix?: string | null;
  fullRange?: boolean | null;
}

export interface YuvConversion {
  /** Column-major mat3 for uniformMatrix3fv: rgb = m * (yuv - offset). */
  m: Float32Array<ArrayBuffer>;
  offset: [number, number, number];
}

const LUMA: Record<string, [number, number]> = {
  bt709: [0.2126, 0.0722],
  bt470bg: [0.299, 0.114],
  smpte170m: [0.299, 0.114],
  "bt2020-ncl": [0.2627, 0.0593],
};

// A frame with no tagged matrix is treated as BT.709, as Chromium's importExternalTexture does.
export function yuvConversion(cs: YuvColorSpace | null | undefined): YuvConversion {
  const full = cs?.fullRange === true;
  const [yScale, cScale, yOff] = full ? [1, 1, 0] : [255 / 219, 255 / 224, 16 / 255];
  const cOff = 128 / 255;

  // Identity matrix: planes hold G, B, R.
  if (cs?.matrix === "rgb") {
    return {
      m: new Float32Array([0, yScale, 0, 0, 0, yScale, yScale, 0, 0]),
      offset: full ? [0, 0, 0] : [yOff, yOff, yOff],
    };
  }

  const [kr, kb] = LUMA[cs?.matrix ?? "bt709"] ?? LUMA.bt709!;
  const kg = 1 - kr - kb;
  const rv = 2 * (1 - kr);
  const bu = 2 * (1 - kb);
  const gu = -(kb * bu) / kg;
  const gv = -(kr * rv) / kg;
  return {
    m: new Float32Array([
      yScale, yScale, yScale,
      0, gu * cScale, bu * cScale,
      rv * cScale, gv * cScale, 0,
    ]),
    offset: [yOff, cOff, cOff],
  };
}

export type FrameUploadKind = "planar" | "nv12" | "rgba" | "bgra" | "fallback";

export function frameUploadKind(format: string | null | undefined): FrameUploadKind {
  switch (format) {
    case "I420":
    case "I420A":
    case "I422":
    case "I444":
      return "planar";
    case "NV12":
      return "nv12";
    case "RGBA":
    case "RGBX":
      return "rgba";
    case "BGRA":
    case "BGRX":
      return "bgra";
    default:
      return "fallback";
  }
}

// Plane sizes for a frame format; chroma dimensions round up, as WebCodecs lays them out.
export function planeSizes(format: string, w: number, h: number): Array<[number, number]> {
  const cw = (w + 1) >> 1;
  const ch = (h + 1) >> 1;
  switch (format) {
    case "I420": return [[w, h], [cw, ch], [cw, ch]];
    case "I420A": return [[w, h], [cw, ch], [cw, ch], [w, h]];
    case "I422": return [[w, h], [cw, h], [cw, h]];
    case "I444": return [[w, h], [w, h], [w, h]];
    case "NV12": return [[w, h], [cw, ch]];
    default: return [[w, h]];
  }
}

const PRIMARIES: Record<string, [number, number, number, number, number, number]> = {
  bt709: [0.64, 0.33, 0.3, 0.6, 0.15, 0.06],
  bt470bg: [0.64, 0.33, 0.29, 0.6, 0.15, 0.06],
  smpte170m: [0.63, 0.34, 0.31, 0.595, 0.155, 0.07],
  bt2020: [0.708, 0.292, 0.17, 0.797, 0.131, 0.046],
  smpte432: [0.68, 0.32, 0.265, 0.69, 0.15, 0.06],
};
const D65: [number, number] = [0.3127, 0.329];

type M3 = [number, number, number, number, number, number, number, number, number]; // row-major

function inv3(m: M3): M3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [A / det, (c * h - b * i) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, (c * d - a * f) / det, C / det, (b * g - a * h) / det, (a * e - b * d) / det];
}

function mul3(x: M3, y: M3): M3 {
  const o = new Array<number>(9).fill(0) as M3;
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) o[r * 3 + c]! += x[r * 3 + k]! * y[k * 3 + c]!;
  return o;
}

function rgbToXyz([xr, yr, xg, yg, xb, yb]: [number, number, number, number, number, number]): M3 {
  const p: M3 = [xr / yr, xg / yg, xb / yb, 1, 1, 1, (1 - xr - yr) / yr, (1 - xg - yg) / yg, (1 - xb - yb) / yb];
  const white = [D65[0] / D65[1], 1, (1 - D65[0] - D65[1]) / D65[1]];
  const pi = inv3(p);
  const sr = pi[0] * white[0]! + pi[1] * white[1]! + pi[2] * white[2]!;
  const sg = pi[3] * white[0]! + pi[4] * white[1]! + pi[5] * white[2]!;
  const sb = pi[6] * white[0]! + pi[7] * white[1]! + pi[8] * white[2]!;
  return [p[0] * sr, p[1] * sg, p[2] * sb, p[3] * sr, p[4] * sg, p[5] * sb, p[6] * sr, p[7] * sg, p[8] * sb];
}

// Linear-light conversion to sRGB primaries as a column-major mat3, or null when the source already
// has them (or doesn't say). Only the gamut moves; HDR transfer curves aren't tone-mapped.
export function gamutToSrgb(primaries: string | null | undefined): Float32Array<ArrayBuffer> | null {
  if (!primaries || primaries === "bt709") return null;
  const src = PRIMARIES[primaries];
  if (!src) return null;
  const m = mul3(inv3(rgbToXyz(PRIMARIES.bt709!)), rgbToXyz(src));
  return new Float32Array([m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]);
}
