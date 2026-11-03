import { describe, expect, it } from "vitest";
import { parseAvcDecoderConfig, parseSps, videoProxyReason, webKitStreamColor, type AvcStreamInfo } from "../src/decode/h264-sps.js";

class BitWriter {
  bits: number[] = [];
  u(n: number, v: number) { for (let i = n - 1; i >= 0; i--) this.bits.push(Math.floor(v / 2 ** i) & 1); return this; }
  ue(v: number) { const x = v + 1; const len = Math.floor(Math.log2(x)); this.u(len, 0); this.u(len + 1, x); return this; }
  bytes(): Uint8Array {
    const b = [...this.bits, 1];
    while (b.length % 8) b.push(0);
    const out = new Uint8Array(b.length / 8);
    b.forEach((bit, i) => { out[i >> 3]! |= bit << (7 - (i & 7)); });
    return out;
  }
}

interface SpsOpts {
  profile?: number; chroma?: number; depth?: number;
  crop?: [number, number, number, number]; // units, as coded: left, right, top, bottom
  colour?: [number, number, number];
  interlaced?: boolean;
  aspect?: boolean;
}

function sps(o: SpsOpts = {}): Uint8Array {
  const w = new BitWriter();
  const profile = o.profile ?? 100;
  w.u(8, 0x67).u(8, profile).u(16, 0x001e).ue(0);
  if (profile >= 100) {
    w.ue(o.chroma ?? 1);
    if (o.chroma === 3) w.u(1, 0);
    w.ue((o.depth ?? 8) - 8).ue((o.depth ?? 8) - 8).u(1, 0).u(1, 0);
  }
  w.ue(0).ue(0).ue(4).ue(4).u(1, 0).ue(39).ue(22);
  w.u(1, o.interlaced ? 0 : 1);
  if (o.interlaced) w.u(1, 0);
  w.u(1, 1);
  if (o.crop) { w.u(1, 1); for (const c of o.crop) w.ue(c); } else w.u(1, 0);
  const vui = o.colour || o.aspect;
  w.u(1, vui ? 1 : 0);
  if (vui) {
    if (o.aspect) w.u(1, 1).u(8, 255).u(32, 0x00010001); else w.u(1, 0);
    w.u(1, 0);
    if (o.colour) {
      w.u(1, 1).u(3, 5).u(1, 0).u(1, 1);
      for (const c of o.colour) w.u(8, c);
    } else w.u(1, 0);
  }
  return w.bytes();
}

function avcC(nal: Uint8Array): Uint8Array {
  return new Uint8Array([1, nal[1]!, 0, 30, 0xff, 0xe1, nal.length >> 8, nal.length & 255, ...nal, 1]);
}

describe("parseSps", () => {
  it("reads a plain 8-bit 4:2:0 High stream", () => {
    expect(parseSps(sps())).toEqual({ profileIdc: 100, chromaFormatIdc: 1, bitDepth: 8, crop: { left: 0, top: 0, right: 0, bottom: 0 } });
  });

  it("scales crop by the 4:2:0 crop units", () => {
    expect(parseSps(sps({ crop: [4, 4, 3, 5] })).crop).toEqual({ left: 8, right: 8, top: 6, bottom: 10 });
  });

  it("doubles vertical crop units for interlaced streams", () => {
    expect(parseSps(sps({ crop: [0, 0, 2, 0], interlaced: true })).crop.top).toBe(8);
  });

  it("uses single-sample crop units for 4:4:4", () => {
    expect(parseSps(sps({ profile: 244, chroma: 3, crop: [1, 0, 1, 0] })).crop).toEqual({ left: 1, right: 0, top: 1, bottom: 0 });
  });

  it("reads bit depth and chroma format", () => {
    const i = parseSps(sps({ profile: 110, depth: 10 }));
    expect(i.bitDepth).toBe(10);
    expect(parseSps(sps({ profile: 122, chroma: 2 })).chromaFormatIdc).toBe(2);
  });

  it("assumes 8-bit 4:2:0 for profiles with no chroma fields", () => {
    const i = parseSps(sps({ profile: 77 }));
    expect([i.chromaFormatIdc, i.bitDepth]).toEqual([1, 8]);
  });

  it("maps VUI colour codes to WebCodecs names, past an extended SAR", () => {
    const i = parseSps(sps({ colour: [9, 16, 9], aspect: true }));
    expect([i.primaries, i.transfer, i.matrix]).toEqual(["bt2020", "pq", "bt2020-ncl"]);
    const sd = parseSps(sps({ colour: [6, 6, 6] }));
    expect([sd.primaries, sd.transfer, sd.matrix]).toEqual(["smpte170m", "smpte170m", "smpte170m"]);
  });

  it("removes emulation-prevention bytes before reading", () => {
    // Zero constraint and level bytes, then an SPS id whose code starts with seven zero bits, make
    // the sequence 00 00 01 that an encoder must escape.
    const w = new BitWriter().u(8, 0x67).u(8, 66).u(16, 0).ue(127);
    w.ue(0).ue(0).ue(4).ue(4).u(1, 0).ue(39).ue(22).u(1, 1).u(1, 1).u(1, 1).ue(2).ue(0).ue(0).ue(0).u(1, 0);
    const plain = w.bytes();
    const escaped: number[] = [];
    let zeros = 0;
    for (const b of plain) {
      if (zeros >= 2 && b <= 3) { escaped.push(3); zeros = 0; }
      escaped.push(b);
      zeros = b === 0 ? zeros + 1 : 0;
    }
    expect(escaped.length).toBeGreaterThan(plain.length);
    expect(parseSps(new Uint8Array(escaped)).crop.left).toBe(4);
  });
});

describe("parseAvcDecoderConfig", () => {
  it("reads the first SPS of a record", () => {
    expect(parseAvcDecoderConfig(avcC(sps({ profile: 110, depth: 10 })))!.bitDepth).toBe(10);
  });

  it("returns null for anything else", () => {
    expect(parseAvcDecoderConfig(new Uint8Array([0, 1, 2]))).toBeNull();
    expect(parseAvcDecoderConfig(new Uint8Array([1, 100, 0, 30, 0xff, 0xe0]))).toBeNull();
    expect(parseAvcDecoderConfig(new Uint8Array([1, 100, 0, 30, 0xff, 0xe1, 0, 2, 0x67, 100]))).toBeNull();
  });
});

const base: AvcStreamInfo = { profileIdc: 100, chromaFormatIdc: 1, bitDepth: 8, crop: { left: 0, top: 0, right: 0, bottom: 0 } };

describe("videoProxyReason", () => {
  it("passes an ordinary stream, including bottom/right crop like 1088 coded rows", () => {
    expect(videoProxyReason("avc1.64001e", base)).toBeNull();
    expect(videoProxyReason("avc1.640028", { ...base, crop: { left: 0, top: 0, right: 0, bottom: 8 } })).toBeNull();
  });

  it("flags what WebKit gets wrong", () => {
    expect(videoProxyReason("avc1.6e001e", { ...base, bitDepth: 10 })).toMatch(/10-bit/);
    expect(videoProxyReason("avc1.f4001f", { ...base, chromaFormatIdc: 3 })).toMatch(/4:2:0/);
    expect(videoProxyReason("avc1.64001e", { ...base, crop: { left: 8, top: 0, right: 0, bottom: 0 } })).toMatch(/crop/);
    expect(videoProxyReason("avc1.64001e", { ...base, crop: { left: 0, top: 6, right: 0, bottom: 0 } })).toMatch(/crop/);
    expect(videoProxyReason("avc1.64001e", { ...base, transfer: "pq" })).toMatch(/HDR/);
    expect(videoProxyReason("avc1.64001e", { ...base, transfer: "hlg" })).toMatch(/HDR/);
  });

  it("leaves other codecs to isConfigSupported", () => {
    expect(videoProxyReason("vp09.00.21.08", null)).toBeNull();
    expect(videoProxyReason("avc1.64001e", null)).toBeNull();
  });
});

describe("webKitStreamColor", () => {
  it("is null when BT.709 is right: tagged so, or untagged at 720 rows or more", () => {
    expect(webKitStreamColor({ ...base, matrix: "bt709", primaries: "bt709" }, 360)).toBeNull();
    expect(webKitStreamColor(base, 720)).toBeNull();
    expect(webKitStreamColor(base, 1080)).toBeNull();
  });

  it("carries a differing matrix or primaries", () => {
    expect(webKitStreamColor({ ...base, matrix: "smpte170m", primaries: "smpte170m" }, 480)).toEqual({ matrix: "smpte170m", primaries: "smpte170m" });
    expect(webKitStreamColor({ ...base, matrix: "bt2020-ncl", primaries: "bt709" }, 1080)).toEqual({ matrix: "bt2020-ncl", primaries: undefined });
  });

  it("guesses BT.601 for untagged SD, as Chromium does", () => {
    expect(webKitStreamColor(base, 480)).toEqual({ matrix: "smpte170m", primaries: "smpte170m" });
  });
});
