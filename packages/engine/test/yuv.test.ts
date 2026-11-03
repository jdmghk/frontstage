import { describe, expect, it } from "vitest";
import { yuvConversion, gamutToSrgb, frameMatrix, framePrimaries, setStreamColor, fitPlanesToLayout, frameUploadKind, planeSizes, type YuvColorSpace } from "../src/render/yuv.js";

// yuv in 8-bit codes → rgb in [0,1], applying the matrix as the shader does.
function convert(cs: YuvColorSpace | null | undefined, y: number, u: number, v: number): number[] {
  const { m, offset } = yuvConversion(cs);
  const c = [y / 255 - offset[0], u / 255 - offset[1], v / 255 - offset[2]];
  return [0, 1, 2].map((row) => m[row]! * c[0]! + m[3 + row]! * c[1]! + m[6 + row]! * c[2]!);
}

const close = (got: number[], want: number[], digits = 2) =>
  got.forEach((g, i) => expect(g).toBeCloseTo(want[i]!, digits));

describe("yuvConversion", () => {
  it("maps limited-range black and white to 0 and 1 on every matrix", () => {
    for (const matrix of ["bt709", "smpte170m", "bt470bg", "bt2020-ncl"]) {
      close(convert({ matrix, fullRange: false }, 16, 128, 128), [0, 0, 0], 4);
      close(convert({ matrix, fullRange: false }, 235, 128, 128), [1, 1, 1], 4);
    }
  });

  it("maps full-range 0 and 255 to 0 and 1", () => {
    close(convert({ matrix: "bt709", fullRange: true }, 0, 128, 128), [0, 0, 0], 4);
    close(convert({ matrix: "bt709", fullRange: true }, 255, 128, 128), [1, 1, 1], 4);
  });

  it("decodes BT.709 75% red bars with the BT.709 matrix", () => {
    // ITU-R BT.709 limited-range 75% red: Y=51 Cb=109 Cr=212 (rounded codes).
    close(convert({ matrix: "bt709", fullRange: false }, 51, 109, 212), [0.75, 0, 0], 1);
  });

  it("decodes BT.601 75% red with the 601 matrix, and the 709 matrix gets it wrong", () => {
    // BT.601 limited-range 75% red: Y=65 Cb=100 Cr=212.
    close(convert({ matrix: "smpte170m", fullRange: false }, 65, 100, 212), [0.75, 0, 0], 1);
    const wrong = convert({ matrix: "bt709", fullRange: false }, 65, 100, 212);
    expect(wrong[0]).toBeGreaterThan(0.8);
  });

  it("uses distinct coefficients per matrix", () => {
    const m = (matrix: string) => [...yuvConversion({ matrix }).m];
    expect(m("bt709")).not.toEqual(m("smpte170m"));
    expect(m("bt2020-ncl")).not.toEqual(m("bt709"));
    expect(m("bt470bg")).toEqual(m("smpte170m"));
  });

  it("treats an untagged frame as limited-range BT.709", () => {
    for (const cs of [undefined, null, {}, { matrix: null, fullRange: null }]) {
      expect([...yuvConversion(cs).m]).toEqual([...yuvConversion({ matrix: "bt709", fullRange: false }).m]);
      expect(yuvConversion(cs).offset).toEqual(yuvConversion({ matrix: "bt709", fullRange: false }).offset);
    }
  });

  it("reads identity-matrix planes as G, B, R", () => {
    close(convert({ matrix: "rgb", fullRange: true }, 51, 102, 204), [0.8, 0.2, 0.4], 4);
  });
});

describe("gamutToSrgb", () => {
  it("is null for sRGB-primaries and untagged sources", () => {
    expect(gamutToSrgb("bt709")).toBeNull();
    expect(gamutToSrgb(null)).toBeNull();
    expect(gamutToSrgb(undefined)).toBeNull();
    expect(gamutToSrgb("unknown-primaries")).toBeNull();
  });

  it("keeps white at white for every primaries set", () => {
    for (const p of ["smpte170m", "bt470bg", "bt2020", "smpte432"]) {
      const m = gamutToSrgb(p)!;
      for (let row = 0; row < 3; row++) expect(m[row]! + m[3 + row]! + m[6 + row]!).toBeCloseTo(1, 4);
    }
  });

  it("matches the published BT.2020 to BT.709 matrix", () => {
    const m = gamutToSrgb("bt2020")!;
    expect(m[0]).toBeCloseTo(1.6605, 3);
    expect(m[3]).toBeCloseTo(-0.5876, 3);
    expect(m[6]).toBeCloseTo(-0.0728, 3);
  });
});

describe("frame formats", () => {
  it("routes each format to its upload path", () => {
    expect(frameUploadKind("I420")).toBe("planar");
    expect(frameUploadKind("I420A")).toBe("planar");
    expect(frameUploadKind("NV12")).toBe("nv12");
    expect(frameUploadKind("RGBA")).toBe("rgba");
    expect(frameUploadKind("RGBX")).toBe("rgba");
    expect(frameUploadKind("BGRA")).toBe("bgra");
    expect(frameUploadKind("BGRX")).toBe("bgra");
    expect(frameUploadKind("I420P10")).toBe("fallback");
    expect(frameUploadKind(null)).toBe("fallback");
  });

  it("rounds chroma up on odd sizes", () => {
    expect(planeSizes("I420", 321, 241)).toEqual([[321, 241], [161, 121], [161, 121]]);
    expect(planeSizes("NV12", 321, 241)).toEqual([[321, 241], [161, 121]]);
    expect(planeSizes("I422", 321, 241)).toEqual([[321, 241], [161, 241], [161, 241]]);
    expect(planeSizes("I420A", 4, 2)).toEqual([[4, 2], [2, 1], [2, 1], [4, 2]]);
  });
});

describe("fitPlanesToLayout", () => {
  it("keeps sizes when the layout has room, including padded strides", () => {
    const sizes = planeSizes("I420", 640, 360);
    const layout = [{ offset: 0, stride: 704 }, { offset: 253440, stride: 352 }, { offset: 316800, stride: 352 }];
    expect(fitPlanesToLayout(sizes, layout, 380160, false)).toEqual(sizes);
  });

  it("follows WebKit's rounded-down chroma on odd sizes", () => {
    const layout = [{ offset: 0, stride: 853 }, { offset: 410293, stride: 426 }, { offset: 512533, stride: 426 }];
    expect(fitPlanesToLayout(planeSizes("I420", 853, 481), layout, 614773, false)).toEqual([[853, 481], [426, 240], [426, 240]]);
  });

  it("counts NV12 chroma stride in sample pairs", () => {
    const layout = [{ offset: 0, stride: 640 }, { offset: 230400, stride: 640 }];
    expect(fitPlanesToLayout(planeSizes("NV12", 640, 360), layout, 345600, true)).toEqual([[640, 360], [320, 180]]);
  });
});

describe("stream colour override", () => {
  const frame = (cs: { matrix?: string; primaries?: string; fullRange?: boolean }) => ({ colorSpace: cs });

  it("falls back to the frame's own tags", () => {
    const f = frame({ matrix: "bt709", primaries: "bt709", fullRange: true });
    expect(frameMatrix(f)).toBe(f.colorSpace);
    expect(framePrimaries(f)).toBe("bt709");
  });

  it("replaces matrix and primaries but keeps the frame's actual range", () => {
    const f = frame({ matrix: "bt709", primaries: "bt709", fullRange: true });
    setStreamColor(f, { matrix: "smpte170m", primaries: "smpte170m" });
    expect(frameMatrix(f)).toEqual({ matrix: "smpte170m", fullRange: true });
    expect(framePrimaries(f)).toBe("smpte170m");
  });
});
