import { describe, expect, it } from "vitest";
import type { Effect } from "@frontstage/core";
import { curvesLutData, effectUniformData, hueCurvesLutData, multiPassStep } from "../src/render/effect-params.js";
import { parseGradeCurve, parseHueCurves } from "@frontstage/core";

const fx = (type: string, params: Effect["params"] = {}): Effect => ({ id: "e", type, enabled: true, params });
const v = (value: number) => ({ value });

describe("effectUniformData", () => {
  it("lays out floats in the order the shaders read them", () => {
    expect([...effectUniformData(fx("color.temperature", { temperature: v(9000), tint: v(30) }), 10, 10)!]).toEqual([9000, 30]);
    expect([...effectUniformData(fx("stylize.grain", { amount: v(0.5), size: v(2) }), 640, 360)!]).toEqual([0.5, 2, 640, 360]);
    expect([...effectUniformData(fx("blur.motion", { angle: v(30), radius: v(12) }), 640, 360)!]).toEqual([30, 12, 640, 360]);
  });

  it("packs colour wheels as three vec4s", () => {
    const d = effectUniformData(fx("color.wheels", { lift_m: v(0.1), gamma_m: v(1.2), gain_m: v(0.9) }), 1, 1)!;
    expect(d.length).toBe(12);
    expect(d[2]).toBeCloseTo(0.1);
    expect(d[6]).toBeCloseTo(1.2);
    expect(d[10]).toBeCloseTo(0.9);
  });

  it("applies defaults for missing params", () => {
    expect([...effectUniformData(fx("color.saturation"), 1, 1)!]).toEqual([1]);
    expect(effectUniformData(fx("key.chroma"), 1, 1)![0]).toBeCloseTo(0.333);
  });

  it("returns null for multi-pass and unknown effects", () => {
    expect(effectUniformData(fx("blur.gaussian"), 1, 1)).toBeNull();
    expect(effectUniformData(fx("nope.nope"), 1, 1)).toBeNull();
  });
});

describe("multiPassStep", () => {
  it("resolves defaults for each multi-pass effect", () => {
    expect(multiPassStep(fx("blur.gaussian"))).toEqual({ type: "blur.gaussian", gaussRadius: 8 });
    expect(multiPassStep(fx("blur.sharpen"))).toEqual({ type: "blur.sharpen", sharpenAmount: 0.4 });
    expect(multiPassStep(fx("blur.noiseReduction"))).toEqual({ type: "blur.noiseReduction", noiseRedAmount: 0 });
    expect(multiPassStep(fx("detail.clarity"))).toEqual({ type: "detail.clarity", clarityClarity: 0, clarityDehaze: 0 });
    expect(multiPassStep(fx("stylize.glow"))).toEqual({ type: "stylize.glow", glowThreshold: 0.6, glowRadius: 20, glowIntensity: 0, glowWarmth: 0 });
  });

  it("is null for single-pass effects", () => {
    expect(multiPassStep(fx("color.saturation"))).toBeNull();
  });
});

describe("curve LUT bakes", () => {
  it("bakes an identity grade curve as a ramp in all four channels", () => {
    const d = curvesLutData(parseGradeCurve(undefined));
    expect(d.length).toBe(1024);
    for (const i of [0, 64, 128, 255]) {
      expect([d[i * 4], d[i * 4 + 1], d[i * 4 + 2], d[i * 4 + 3]]).toEqual([i, i, i, i]);
    }
  });

  it("bakes neutral hue curves with opaque alpha", () => {
    const d = hueCurvesLutData(parseHueCurves(undefined));
    for (const i of [0, 100, 255]) {
      expect(Math.abs(d[i * 4]! - 128)).toBeLessThanOrEqual(1);
      expect(d[i * 4 + 3]).toBe(255);
    }
  });
});
