// Gaussian approximation (three box passes) over straight-alpha RGBA, in place. Blurs premultiplied
// so transparent pixels can't bleed their colour in, as CSS blur() behaves.
export function boxRadiusForSigma(sigma: number): number {
  // Three boxes of width 2r+1 have variance ((2r+1)^2 - 1) / 4; solve for r.
  return Math.max(1, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2));
}

function boxPass(src: Float32Array, dst: Float32Array, w: number, h: number, r: number, horizontal: boolean): void {
  const lines = horizontal ? h : w;
  const len = horizontal ? w : h;
  const step = horizontal ? 4 : w * 4;
  const lineStep = horizontal ? w * 4 : 4;
  const norm = 1 / (2 * r + 1);
  for (let line = 0; line < lines; line++) {
    const base = line * lineStep;
    for (let c = 0; c < 4; c++) {
      // Outside the image is transparent, so edges fade rather than smear.
      let sum = 0;
      for (let i = 0; i <= r && i < len; i++) sum += src[base + i * step + c]!;
      for (let i = 0; i < len; i++) {
        dst[base + i * step + c] = sum * norm;
        const add = i + r + 1;
        const sub = i - r;
        if (add < len) sum += src[base + add * step + c]!;
        if (sub >= 0) sum -= src[base + sub * step + c]!;
      }
    }
  }
}

export function blurRGBA(data: Uint8ClampedArray, w: number, h: number, sigma: number): void {
  if (sigma <= 0) return;
  const r = boxRadiusForSigma(sigma);
  let a = new Float32Array(w * h * 4);
  let b = new Float32Array(w * h * 4);
  for (let i = 0; i < a.length; i += 4) {
    const al = data[i + 3]! / 255;
    a[i] = data[i]! * al;
    a[i + 1] = data[i + 1]! * al;
    a[i + 2] = data[i + 2]! * al;
    a[i + 3] = data[i + 3]!;
  }
  for (let pass = 0; pass < 3; pass++) {
    boxPass(a, b, w, h, r, true);
    boxPass(b, a, w, h, r, false);
  }
  for (let i = 0; i < a.length; i += 4) {
    const al = a[i + 3]!;
    const un = al > 0 ? 255 / al : 0;
    data[i] = a[i]! * un;
    data[i + 1] = a[i + 1]! * un;
    data[i + 2] = a[i + 2]! * un;
    data[i + 3] = al;
  }
}
