import { describe, expect, it } from "vitest";
import { blurRGBA, boxRadiusForSigma } from "../src/render/blur-rgba.js";

const image = (w: number, h: number, fill: (x: number, y: number) => [number, number, number, number]) => {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set(fill(x, y), (y * w + x) * 4);
  return d;
};

describe("blurRGBA", () => {
  it("leaves the image alone at sigma 0", () => {
    const d = image(4, 4, (x) => [x * 10, 0, 0, 255]);
    const before = d.slice();
    blurRGBA(d, 4, 4, 0);
    expect(d).toEqual(before);
  });

  it("keeps the colour of a shape instead of bleeding transparent black into it", () => {
    const d = image(41, 41, (x, y) => (Math.abs(x - 20) < 6 && Math.abs(y - 20) < 6 ? [200, 100, 50, 255] : [0, 0, 0, 0]));
    blurRGBA(d, 41, 41, 3);
    const edge = (20 * 41 + 28) * 4; // soft edge, partly transparent
    expect(d[edge + 3]).toBeGreaterThan(5);
    expect(d[edge + 3]).toBeLessThan(250);
    expect(d[edge]).toBeGreaterThanOrEqual(198);
    expect(d[edge + 1]).toBeGreaterThanOrEqual(98);
    expect(d[edge + 1]).toBeLessThanOrEqual(102);
  });

  it("spreads an edge over about the width a gaussian of that sigma would", () => {
    const w = 101;
    const h = 101; // tall enough that the transparent outside doesn't reach the row we read
    const d = image(w, h, (x) => (x < 50 ? [255, 255, 255, 255] : [255, 255, 255, 0]));
    blurRGBA(d, w, h, 4);
    const a = (x: number) => d[(50 * w + x) * 4 + 3]!;
    expect(a(50)).toBeGreaterThan(100);
    expect(a(50)).toBeLessThan(155);
    // Gaussian CDF at ±1 sigma is 0.84 / 0.16.
    expect(a(45) / 255).toBeGreaterThan(0.75);
    expect(a(45) / 255).toBeLessThan(0.92);
    expect(a(54) / 255).toBeGreaterThan(0.08);
    expect(a(54) / 255).toBeLessThan(0.25);
  });

  it("derives a box radius of at least 1", () => {
    expect(boxRadiusForSigma(0.1)).toBe(1);
    expect(boxRadiusForSigma(4)).toBe(4);
  });
});
