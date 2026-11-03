// Reads what WKWebView's VideoDecoder gets wrong out of an H.264 avcC record. On that decoder:
//   - 10-bit and 4:2:2/4:4:4 streams report as supported, then produce garbage or never configure
//   - left/top SPS crop is dropped, shifting the picture and showing the cropped-away pad (Chromium's
//     hardware decode on macOS does this too; there it stays as it was)
//   - frames are always tagged BT.709, though their planes keep the stream's own matrix

export interface AvcStreamInfo {
  profileIdc: number;
  chromaFormatIdc: number;
  bitDepth: number;
  /** In luma samples. */
  crop: { left: number; top: number; right: number; bottom: number };
  /** Names as WebCodecs spells them; absent when the stream has no VUI colour description. */
  primaries?: string;
  transfer?: string;
  matrix?: string;
}

class BitReader {
  private bit = 0;
  constructor(private d: Uint8Array) {}
  u1(): number {
    const byte = this.d[this.bit >> 3];
    if (byte === undefined) throw new Error("SPS ended early");
    const v = (byte >> (7 - (this.bit & 7))) & 1;
    this.bit++;
    return v;
  }
  u(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 2 + this.u1();
    return v;
  }
  ue(): number {
    let zeros = 0;
    while (this.u1() === 0) {
      if (++zeros > 32) throw new Error("bad exp-golomb code");
    }
    return 2 ** zeros - 1 + this.u(zeros);
  }
  se(): number {
    const k = this.ue();
    return k % 2 ? (k + 1) / 2 : -k / 2;
  }
}

function unescapeRbsp(nal: Uint8Array): Uint8Array {
  const out = new Uint8Array(nal.length);
  let n = 0;
  let zeros = 0;
  for (const b of nal) {
    if (zeros >= 2 && b === 3) { zeros = 0; continue; }
    out[n++] = b;
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return out.subarray(0, n);
}

const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);
const PRIMARIES: Record<number, string> = { 1: "bt709", 5: "bt470bg", 6: "smpte170m", 9: "bt2020", 12: "smpte432" };
const TRANSFER: Record<number, string> = { 1: "bt709", 6: "smpte170m", 13: "iec61966-2-1", 16: "pq", 18: "hlg" };
const MATRIX: Record<number, string> = { 1: "bt709", 5: "bt470bg", 6: "smpte170m", 9: "bt2020-ncl" };

function skipScalingList(r: BitReader, size: number): void {
  let last = 8;
  let next = 8;
  for (let i = 0; i < size; i++) {
    if (next !== 0) next = (last + r.se() + 256) % 256;
    last = next === 0 ? last : next;
  }
}

export function parseSps(nal: Uint8Array): AvcStreamInfo {
  const r = new BitReader(unescapeRbsp(nal.subarray(1))); // skip the NAL header byte
  const profileIdc = r.u(8);
  r.u(16); // constraint flags, level
  r.ue(); // sps id
  let chromaFormatIdc = 1;
  let separatePlanes = 0;
  let bitDepth = 8;
  if (HIGH_PROFILES.has(profileIdc)) {
    chromaFormatIdc = r.ue();
    if (chromaFormatIdc === 3) separatePlanes = r.u1();
    bitDepth = r.ue() + 8;
    r.ue(); // chroma bit depth
    r.u1(); // qpprime bypass
    if (r.u1()) {
      const lists = chromaFormatIdc === 3 ? 12 : 8;
      for (let i = 0; i < lists; i++) {
        if (r.u1()) skipScalingList(r, i < 6 ? 16 : 64);
      }
    }
  }
  r.ue(); // log2 max frame num
  const pocType = r.ue();
  if (pocType === 0) r.ue();
  else if (pocType === 1) {
    r.u1();
    r.se();
    r.se();
    const n = r.ue();
    for (let i = 0; i < n; i++) r.se();
  }
  r.ue(); // max ref frames
  r.u1(); // gaps allowed
  r.ue(); // width in mbs
  r.ue(); // height in map units
  const frameMbsOnly = r.u1();
  if (!frameMbsOnly) r.u1();
  r.u1(); // direct 8x8
  const crop = { left: 0, top: 0, right: 0, bottom: 0 };
  if (r.u1()) {
    const arrayType = separatePlanes ? 0 : chromaFormatIdc;
    const unitX = arrayType === 1 || arrayType === 2 ? 2 : 1;
    const unitY = (arrayType === 1 ? 2 : 1) * (2 - frameMbsOnly);
    crop.left = r.ue() * unitX;
    crop.right = r.ue() * unitX;
    crop.top = r.ue() * unitY;
    crop.bottom = r.ue() * unitY;
  }
  const info: AvcStreamInfo = { profileIdc, chromaFormatIdc, bitDepth, crop };
  if (r.u1()) { // VUI
    if (r.u1() && r.u(8) === 255) r.u(32); // aspect ratio, with extended SAR
    if (r.u1()) r.u1(); // overscan
    if (r.u1()) { // video signal type
      r.u(3);
      r.u1(); // full range flag; WebKit's frames report the range they actually hold
      if (r.u1()) {
        info.primaries = PRIMARIES[r.u(8)];
        info.transfer = TRANSFER[r.u(8)];
        info.matrix = MATRIX[r.u(8)];
      }
    }
  }
  return info;
}

/** First SPS of an avcC record, or null if this isn't one we can read. */
export function parseAvcDecoderConfig(avcC: Uint8Array): AvcStreamInfo | null {
  try {
    if (avcC[0] !== 1) return null;
    const count = avcC[5]! & 0x1f;
    if (count === 0) return null;
    const len = (avcC[6]! << 8) | avcC[7]!;
    return parseSps(avcC.subarray(8, 8 + len));
  } catch {
    return null;
  }
}

/** Why WKWebView can't show this H.264 stream correctly; it needs an import proxy. Null if it can. */
export function videoProxyReason(codec: string, info: AvcStreamInfo | null): string | null {
  if (!codec.startsWith("avc") || !info) return null;
  if (info.bitDepth > 8) return `${info.bitDepth}-bit H.264 decodes to garbage in this webview`;
  if (info.chromaFormatIdc !== 1) return "H.264 that isn't 4:2:0 doesn't decode in this webview";
  if (info.crop.left || info.crop.top) return "H.264 with a left or top crop renders shifted in this webview";
  if (info.transfer === "pq" || info.transfer === "hlg") return "HDR H.264 isn't tone-mapped in this webview";
  return null;
}

// Stream tags to apply over WebKit's constant BT.709 frame tag, or null if they'd change nothing.
// An untagged stream below 720 rows is treated as BT.601, as Chromium's decoder does.
export function webKitStreamColor(info: AvcStreamInfo, codedHeight: number): { matrix?: string; primaries?: string } | null {
  const guess = codedHeight < 720 ? "smpte170m" : "bt709";
  const m = info.matrix ?? guess;
  const p = info.primaries ?? guess;
  const matrix = m !== "bt709" ? m : undefined;
  const primaries = p !== "bt709" ? p : undefined;
  return matrix || primaries ? { matrix, primaries } : null;
}
