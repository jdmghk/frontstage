import type { Effect, GradeCurve, HueCurves } from "@frontstage/core";
import { resolveParam, evalCurve, evalHueCurve } from "@frontstage/core";

// Parameter logic shared by the WebGPU and WebGL2 backends, so the two can't drift apart.

// Resolved-param uniform floats for an effect, or null if the type is unimplemented or multi-pass.
// clip-relative frame is 0 for M9B (static effect params; keyframed effect params are a later fold).
export function effectUniformData(eff: Effect, rw: number, rh: number): Float32Array<ArrayBuffer> | null {
  switch (eff.type) {
    case "color.saturation":
      return new Float32Array([resolveParam(eff.params.amount, 0, 1)]);
    case "color.exposure":
      return new Float32Array([resolveParam(eff.params.ev, 0, 0)]);
    case "color.contrast":
      return new Float32Array([resolveParam(eff.params.amount, 0, 1)]);
    case "color.highlightsShadows":
      return new Float32Array([resolveParam(eff.params.highlights, 0, 0), resolveParam(eff.params.shadows, 0, 0)]);
    case "color.blacksWhites":
      return new Float32Array([resolveParam(eff.params.blacks, 0, 0), resolveParam(eff.params.whites, 0, 0)]);
    case "color.temperature":
      return new Float32Array([resolveParam(eff.params.temperature, 0, 6500), resolveParam(eff.params.tint, 0, 0)]);
    case "color.vibrance":
      return new Float32Array([resolveParam(eff.params.amount, 0, 0)]);
    case "color.wheels":
      return new Float32Array([
        resolveParam(eff.params.lift_x, 0, 0),
        resolveParam(eff.params.lift_y, 0, 0),
        resolveParam(eff.params.lift_m, 0, 0),
        0,
        resolveParam(eff.params.gamma_x, 0, 0),
        resolveParam(eff.params.gamma_y, 0, 0),
        resolveParam(eff.params.gamma_m, 0, 1),
        0,
        resolveParam(eff.params.gain_x, 0, 0),
        resolveParam(eff.params.gain_y, 0, 0),
        resolveParam(eff.params.gain_m, 0, 1),
        0,
      ]);
    case "key.chroma":
      return new Float32Array([
        resolveParam(eff.params.keyHue, 0, 0.333),
        resolveParam(eff.params.tolerance, 0, 0),
        resolveParam(eff.params.softness, 0, 0.5),
        resolveParam(eff.params.spill, 0, 0.5),
      ]);
    case "stylize.invert":
      return new Float32Array([0, 0, 0, 0]);
    case "stylize.vignette":
      return new Float32Array([
        resolveParam(eff.params.amount, 0, 0),
        resolveParam(eff.params.midpoint, 0, 0.5),
        resolveParam(eff.params.roundness, 0, 0),
        resolveParam(eff.params.feather, 0, 0.5),
      ]);
    case "stylize.grain":
      return new Float32Array([
        resolveParam(eff.params.amount, 0, 0),
        resolveParam(eff.params.size, 0, 1.5),
        rw,
        rh,
      ]);
    case "blur.motion":
      return new Float32Array([
        resolveParam(eff.params.angle, 0, 0),
        resolveParam(eff.params.radius, 0, 0),
        rw,
        rh,
      ]);
    default:
      return null;
  }
}

export interface MultiPassStep {
  type: string;
  gaussRadius?: number;
  sharpenAmount?: number;
  noiseRedAmount?: number;
  clarityClarity?: number;
  clarityDehaze?: number;
  glowThreshold?: number;
  glowRadius?: number;
  glowIntensity?: number;
  glowWarmth?: number;
}

export function multiPassStep(eff: Effect): MultiPassStep | null {
  switch (eff.type) {
    case "blur.gaussian":
      return { type: eff.type, gaussRadius: resolveParam(eff.params.radius, 0, 8) };
    case "blur.sharpen":
      return { type: eff.type, sharpenAmount: resolveParam(eff.params.amount, 0, 0.4) };
    case "blur.noiseReduction":
      return { type: eff.type, noiseRedAmount: resolveParam(eff.params.amount, 0, 0) };
    case "detail.clarity":
      return { type: eff.type, clarityClarity: resolveParam(eff.params.clarity, 0, 0), clarityDehaze: resolveParam(eff.params.dehaze, 0, 0) };
    case "stylize.glow":
      return {
        type: eff.type,
        glowThreshold: resolveParam(eff.params.threshold, 0, 0.6),
        glowRadius: resolveParam(eff.params.radius, 0, 20),
        glowIntensity: resolveParam(eff.params.intensity, 0, 0),
        glowWarmth: resolveParam(eff.params.warmth, 0, 0),
      };
    default:
      return null;
  }
}

// 256×1 RGBA8 texels: master, red, green, blue.
export function curvesLutData(curve: GradeCurve): Uint8Array<ArrayBuffer> {
  const data = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    data[i * 4 + 0] = Math.round(evalCurve(curve.master, x) * 255);
    data[i * 4 + 1] = Math.round(evalCurve(curve.red, x) * 255);
    data[i * 4 + 2] = Math.round(evalCurve(curve.green, x) * 255);
    data[i * 4 + 3] = Math.round(evalCurve(curve.blue, x) * 255);
  }
  return data;
}

// 256×1 RGBA8 texels indexed by hue: hueVsHue, hueVsSat, hueVsLum, 255.
export function hueCurvesLutData(curves: HueCurves): Uint8Array<ArrayBuffer> {
  const data = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    data[i * 4 + 0] = Math.round(evalHueCurve(curves.hueVsHue, x) * 255);
    data[i * 4 + 1] = Math.round(evalHueCurve(curves.hueVsSat, x) * 255);
    data[i * 4 + 2] = Math.round(evalHueCurve(curves.hueVsLum, x) * 255);
    data[i * 4 + 3] = 255;
  }
  return data;
}
