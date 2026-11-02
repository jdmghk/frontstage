// GLSL ES 3.00 ports of the WGSL in webgpu-renderer.ts. Keep the two in step.
//
// Orientation: every intermediate stores row 0 as the top of the picture, as WebGPU does. Internal
// passes therefore map uv.y=0 to framebuffer row 0 (ndcY = uv.y*2-1), which leaves readPixels
// top-down. Only the final blit to the canvas uses WebGPU's ndcY = 1-uv.y*2.

const HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler3D;
`;

const QUAD = `vec2 quadUv() { return vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1)); }
`;

export const VS_FULLSCREEN = HEADER + QUAD + `out vec2 uv;
void main() {
  uv = quadUv();
  gl_Position = vec4(uv.x * 2.0 - 1.0, uv.y * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const VS_CANVAS = HEADER + QUAD + `out vec2 uv;
void main() {
  uv = quadUv();
  gl_Position = vec4(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
}
`;

// L[] is the WGSL Uniforms layout: a,b,c,d / e,f,natW,natH / canvasW,canvasH,opacity,cropL / cropT,cropR,cropB,_.
export const VS_LAYER = HEADER + QUAD + `uniform vec4 L[4];
out vec2 uv;
void main() {
  vec2 q = quadUv();
  float cu = L[2].w + q.x * (1.0 - L[2].w - L[3].y);
  float cv = L[3].x + q.y * (1.0 - L[3].x - L[3].z);
  float sx = cu * L[1].z;
  float sy = cv * L[1].w;
  float cx = L[0].x * sx + L[0].z * sy + L[1].x;
  float cy = L[0].y * sx + L[0].w * sy + L[1].y;
  gl_Position = vec4((cx / L[2].x) * 2.0 - 1.0, (cy / L[2].y) * 2.0 - 1.0, 0.0, 1.0);
  uv = vec2(cu, cv);
}
`;

export type SourceVariant = "planar" | "nv12" | "rgba" | "bgra";

// RGBA frames are multiplied by alpha here because importExternalTexture returns premultiplied
// colour for them. The ALPHA_BLEND state then multiplies by alpha again; that's what WebGPU renders,
// so WebGL2 matches it.

const SOURCE_READ: Record<SourceVariant, string> = {
  planar: `uniform sampler2D t0; uniform sampler2D t1; uniform sampler2D t2; uniform sampler2D t3;
uniform mat3 yuvM; uniform vec3 yuvO; uniform float hasAlphaPlane;
vec4 readSource() {
  vec3 yuv = vec3(texture(t0, uv).r, texture(t1, uv).r, texture(t2, uv).r);
  float a = hasAlphaPlane > 0.5 ? texture(t3, uv).r : 1.0;
  return vec4(toOutput(yuvM * (yuv - yuvO)), a);
}
`,
  nv12: `uniform sampler2D t0; uniform sampler2D t1;
uniform mat3 yuvM; uniform vec3 yuvO;
vec4 readSource() {
  vec3 yuv = vec3(texture(t0, uv).r, texture(t1, uv).rg);
  return vec4(toOutput(yuvM * (yuv - yuvO)), 1.0);
}
`,
  rgba: `uniform sampler2D t0; uniform float forceOpaque;
vec4 readSource() {
  vec4 c = texture(t0, uv);
  float a = max(c.a, forceOpaque);
  return vec4(c.rgb * a, a);
}
`,
  bgra: `uniform sampler2D t0; uniform float forceOpaque;
vec4 readSource() {
  vec4 c = texture(t0, uv).bgra;
  float a = max(c.a, forceOpaque);
  return vec4(c.rgb * a, a);
}
`,
};

// importExternalTexture clamps, and treats the SDR video curves as sRGB, so BT.709-primaries video
// needs only the matrix. Other primaries go through linear light to reach sRGB's gamut.
const TO_OUTPUT = `uniform float gamutOn; uniform mat3 gamut;
vec3 toOutput(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  if (gamutOn < 0.5) return c;
  vec3 lin = mix(pow((c + 0.055) / 1.055, vec3(2.4)), c / 12.92, step(c, vec3(0.04045)));
  lin = clamp(gamut * lin, 0.0, 1.0);
  return mix(1.055 * pow(lin, vec3(1.0 / 2.4)) - 0.055, lin * 12.92, step(lin, vec3(0.0031308)));
}
`;

export function fsSource(variant: SourceVariant): string {
  return HEADER + `in vec2 uv; out vec4 o; uniform float opacity;
` + (variant === "planar" || variant === "nv12" ? TO_OUTPUT : "") + SOURCE_READ[variant] + `void main() {
  vec4 c = readSource();
  c.a *= opacity;
  o = c;
}
`;
}

const FX_HEAD = HEADER + `in vec2 uv; out vec4 o; uniform sampler2D src; uniform vec4 U[3];
`;
const FX2_HEAD = HEADER + `in vec2 uv; out vec4 o; uniform sampler2D texA; uniform sampler2D texB; uniform vec4 U[3];
`;
const LUT_HEAD = HEADER + `in vec2 uv; out vec4 o; uniform sampler2D src; uniform sampler2D lut;
`;

export const FS_BLIT = HEADER + `in vec2 uv; out vec4 o; uniform sampler2D src;
void main() { o = texture(src, uv); }
`;

// WGSL % truncates and GLSL mod floors, so rgb2hsv spells out the truncating form.
const COLOR_PRELUDE = `float srgbToLin(float x) { return x <= 0.04045 ? x / 12.92 : pow((x + 0.055) / 1.055, 2.4); }
float linToSrgb(float x) { return x <= 0.0031308 ? x * 12.92 : 1.055 * pow(x, 1.0 / 2.4) - 0.055; }
float rec709(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 rgb2hsv(vec3 c) {
  float cmax = max(c.r, max(c.g, c.b));
  float cmin = min(c.r, min(c.g, c.b));
  float d = cmax - cmin;
  float h = 0.0;
  if (d > 1e-9) {
    if (cmax == c.r) { float t = (c.g - c.b) / d; h = t - 6.0 * trunc(t / 6.0); }
    else if (cmax == c.g) { h = (c.b - c.r) / d + 2.0; }
    else { h = (c.r - c.g) / d + 4.0; }
    h = h / 6.0;
    if (h < 0.0) { h = h + 1.0; }
  }
  float s = cmax > 0.0 ? d / cmax : 0.0;
  return vec3(h, s, cmax);
}
vec3 hsv2rgb(vec3 c) {
  float h = fract(c.x);
  float i = floor(h * 6.0);
  float f = h * 6.0 - i;
  float p = c.z * (1.0 - c.y);
  float q = c.z * (1.0 - f * c.y);
  float t = c.z * (1.0 - (1.0 - f) * c.y);
  int ii = int(i) % 6;
  if (ii == 0) { return vec3(c.z, t, p); }
  if (ii == 1) { return vec3(q, c.z, p); }
  if (ii == 2) { return vec3(p, c.z, t); }
  if (ii == 3) { return vec3(p, q, c.z); }
  if (ii == 4) { return vec3(t, p, c.z); }
  return vec3(c.z, p, q);
}
`;

// Single-input effects. U[] carries effectUniformData's floats unchanged.
export const FS_EFFECTS: Record<string, string> = {
  "color.saturation": FX_HEAD + `void main() {
  vec4 c = texture(src, uv);
  float y = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
  o = vec4(vec3(y) + (c.rgb - vec3(y)) * U[0].x, c.a);
}
`,
  "color.exposure": FX_HEAD + COLOR_PRELUDE + `void main() {
  vec4 c = texture(src, uv);
  float k = pow(2.0, U[0].x);
  o = vec4(linToSrgb(srgbToLin(c.r) * k), linToSrgb(srgbToLin(c.g) * k), linToSrgb(srgbToLin(c.b) * k), c.a);
}
`,
  "color.contrast": FX_HEAD + `void main() {
  vec4 c = texture(src, uv);
  o = vec4((c.rgb - vec3(0.5)) * U[0].x + vec3(0.5), c.a);
}
`,
  "color.highlightsShadows": FX_HEAD + `float hsAdj(float x, float hi, float sh) {
  float shadowMask = 1.0 - smoothstep(0.0, 0.5, x);
  float hiMask = smoothstep(0.5, 1.0, x);
  return clamp(x + sh * 0.5 * shadowMask + hi * 0.5 * hiMask, 0.0, 1.0);
}
void main() {
  vec4 c = texture(src, uv);
  o = vec4(hsAdj(c.r, U[0].x, U[0].y), hsAdj(c.g, U[0].x, U[0].y), hsAdj(c.b, U[0].x, U[0].y), c.a);
}
`,
  "color.blacksWhites": FX_HEAD + `void main() {
  vec4 c = texture(src, uv);
  float lo = U[0].x * 0.25;
  float hi = 1.0 + U[0].y * 0.25;
  float bwd = max(1e-3, hi - lo);
  o = vec4(clamp((c.rgb - vec3(lo)) / vec3(bwd), vec3(0.0), vec3(1.0)), c.a);
}
`,
  "color.temperature": FX_HEAD + `void main() {
  vec4 c = texture(src, uv);
  float tt = (U[0].x - 6500.0) / 4500.0;
  vec3 scale = vec3(1.0 + tt * 0.2, 1.0 - (U[0].y / 100.0) * 0.2, 1.0 - tt * 0.2);
  o = vec4(clamp(c.rgb * scale, vec3(0.0), vec3(1.0)), c.a);
}
`,
  "color.vibrance": FX_HEAD + COLOR_PRELUDE + `void main() {
  vec4 c = texture(src, uv);
  vec3 hsv = rgb2hsv(c.rgb);
  float boost = U[0].x * (1.0 - hsv.y);
  float y = rec709(c.rgb);
  o = vec4(vec3(y) + (c.rgb - vec3(y)) * (1.0 + boost), c.a);
}
`,
  "color.wheels": FX_HEAD + COLOR_PRELUDE + `vec3 chromaOffset(float x, float y) {
  float r = min(1.0, sqrt(x * x + y * y));
  if (r <= 1e-6) { return vec3(0.0); }
  float hue = fract(atan(y, x) / (2.0 * 3.14159265359));
  vec3 rgb = hsv2rgb(vec3(hue, r, 1.0));
  float m = (rgb.r + rgb.g + rgb.b) / 3.0;
  return rgb - vec3(m);
}
float wheelCh(float inp, float lo, float go, float ga, float liftM, float gammaM, float gainM) {
  float liftC = liftM + lo * 0.2;
  float gainC = gainM * (1.0 + ga * 0.35);
  float invGamma = 1.0 / max(0.01, gammaM * (1.0 + go * 0.35));
  return clamp(pow(max(0.0, inp * (1.0 - liftC) + liftC) * gainC, invGamma), 0.0, 1.0);
}
void main() {
  vec4 c = texture(src, uv);
  vec3 lo = chromaOffset(U[0].x, U[0].y);
  vec3 go = chromaOffset(U[1].x, U[1].y);
  vec3 ga = chromaOffset(U[2].x, U[2].y);
  o = vec4(
    wheelCh(c.r, lo.r, go.r, ga.r, U[0].z, U[1].z, U[2].z),
    wheelCh(c.g, lo.g, go.g, ga.g, U[0].z, U[1].z, U[2].z),
    wheelCh(c.b, lo.b, go.b, ga.b, U[0].z, U[1].z, U[2].z),
    c.a);
}
`,
  "key.chroma": FX_HEAD + COLOR_PRELUDE + `void main() {
  vec4 c = texture(src, uv);
  vec3 hsv = rgb2hsv(c.rgb);
  float diff = abs(hsv.x - U[0].x);
  float hd = min(diff, 1.0 - diff);
  float inner = U[0].y * 0.25;
  float keyed = (1.0 - smoothstep(inner, inner + U[0].z * 0.3 + 0.02, hd)) * smoothstep(0.12, 0.32, hsv.y);
  float yGrey = rec709(c.rgb);
  float m = U[0].w * keyed;
  o = vec4(c.rgb * (1.0 - m) + vec3(yGrey) * m, c.a * (1.0 - keyed));
}
`,
  "stylize.vignette": FX_HEAD + `void main() {
  vec4 c = texture(src, uv);
  vec2 p = (uv - vec2(0.5)) * 2.0;
  float rr = mix(max(abs(p.x), abs(p.y)), length(p), (U[0].z + 1.0) * 0.5);
  float falloff = 1.0 - smoothstep(U[0].y, U[0].y + U[0].w + 0.001, rr);
  float vig = 1.0 + U[0].x * (1.0 - falloff);
  o = vec4(clamp(c.rgb * vig, vec3(0.0), vec3(1.0)), c.a);
}
`,
  "stylize.invert": FX_HEAD + `void main() {
  vec4 c = texture(src, uv);
  o = vec4(1.0 - c.rgb, c.a + U[0].x * 0.0);
}
`,
  "stylize.grain": FX_HEAD + `float hash21(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec4 c = texture(src, uv);
  vec2 cell = floor(uv * vec2(U[0].z, U[0].w) / max(0.5, U[0].y));
  float g = hash21(cell) - 0.5;
  o = vec4(clamp(c.rgb + vec3(g * U[0].x), vec3(0.0), vec3(1.0)), c.a);
}
`,
  "blur.motion": FX_HEAD + `void main() {
  int taps = int(min(32.0, max(1.0, U[0].y)));
  vec2 dir = vec2(cos(radians(U[0].x)), sin(radians(U[0].x))) / vec2(U[0].z, U[0].w);
  vec4 sum = vec4(0.0);
  for (int i = -taps; i <= taps; i = i + 1) {
    sum = sum + texture(src, uv + dir * float(i));
  }
  o = sum / float(2 * taps + 1);
}
`,
};

export const FS_GAUSS = FX_HEAD + `void main() {
  vec4 sum = vec4(0.0);
  float wsum = 0.0;
  float sigma = max(0.5, U[0].z * 0.5);
  int taps = int(min(24.0, ceil(sigma * 3.0)));
  for (int i = -taps; i <= taps; i = i + 1) {
    float w = exp(-float(i * i) / (2.0 * sigma * sigma));
    sum = sum + texture(src, uv + U[0].xy * float(i)) * w;
    wsum = wsum + w;
  }
  o = sum / wsum;
}
`;

export const FS_CURVES = LUT_HEAD + COLOR_PRELUDE + `void main() {
  vec4 c = texture(src, uv);
  float yv = rec709(c.rgb);
  vec4 m = textureLod(lut, vec2((yv * 255.0 + 0.5) / 256.0, 0.5), 0.0);
  vec3 rgb = c.rgb;
  if (yv > 1e-4) { rgb = rgb * min(m.r / yv, 8.0); } else { rgb = vec3(m.r); }
  rgb.r = textureLod(lut, vec2((rgb.r * 255.0 + 0.5) / 256.0, 0.5), 0.0).g;
  rgb.g = textureLod(lut, vec2((rgb.g * 255.0 + 0.5) / 256.0, 0.5), 0.0).b;
  rgb.b = textureLod(lut, vec2((rgb.b * 255.0 + 0.5) / 256.0, 0.5), 0.0).a;
  o = vec4(rgb, c.a);
}
`;

export const FS_HUE_CURVES = LUT_HEAD + COLOR_PRELUDE + `void main() {
  vec4 c = texture(src, uv);
  vec3 hsv = rgb2hsv(c.rgb);
  vec4 L = textureLod(lut, vec2((hsv.x * 255.0 + 0.5) / 256.0, 0.5), 0.0);
  float dHue = (L.r - 0.5) * 2.0 * (1.0 / 12.0);
  float satScale = (L.g - 0.5) * 2.0;
  float dLum = (L.b - 0.5) * 2.0 * 0.5;
  float gate = smoothstep(0.04, 0.18, hsv.y);
  o = vec4(hsv2rgb(vec3(fract(hsv.x + dHue * gate), clamp(hsv.y * (1.0 + satScale * gate), 0.0, 1.0), clamp(hsv.z + dLum * gate, 0.0, 1.0))), c.a);
}
`;

export const FS_LUT3D = HEADER + `in vec2 uv; out vec4 o; uniform sampler2D src; uniform sampler3D lut3d; uniform vec4 U[3];
vec3 lutCombine(vec3 c0, vec3 cA, vec3 cB, vec3 c1, float w0, float w1, float w2) {
  return c0 * (1.0 - w0) + cA * (w0 - w1) + cB * (w1 - w2) + c1 * w2;
}
vec3 lutNode(int r, int g, int b) { return texelFetch(lut3d, ivec3(r, g, b), 0).rgb; }
vec3 tetra(vec3 p, int n) {
  int r0 = int(floor(p.x));
  int g0 = int(floor(p.y));
  int b0 = int(floor(p.z));
  int r1 = min(r0 + 1, n - 1);
  int g1 = min(g0 + 1, n - 1);
  int b1 = min(b0 + 1, n - 1);
  float fr = p.x - float(r0);
  float fg = p.y - float(g0);
  float fb = p.z - float(b0);
  vec3 c000 = lutNode(r0, g0, b0);
  vec3 c111 = lutNode(r1, g1, b1);
  if (fr >= fg && fg >= fb) {
    return lutCombine(c000, lutNode(r1, g0, b0), lutNode(r1, g1, b0), c111, fr, fg, fb);
  } else if (fr >= fb && fb >= fg) {
    return lutCombine(c000, lutNode(r1, g0, b0), lutNode(r1, g0, b1), c111, fr, fb, fg);
  } else if (fb >= fr && fr >= fg) {
    return lutCombine(c000, lutNode(r0, g0, b1), lutNode(r1, g0, b1), c111, fb, fr, fg);
  } else if (fg >= fr && fr >= fb) {
    return lutCombine(c000, lutNode(r0, g1, b0), lutNode(r1, g1, b0), c111, fg, fr, fb);
  } else if (fg >= fb && fb >= fr) {
    return lutCombine(c000, lutNode(r0, g1, b0), lutNode(r0, g1, b1), c111, fg, fb, fr);
  }
  return lutCombine(c000, lutNode(r0, g0, b1), lutNode(r0, g1, b1), c111, fb, fg, fr);
}
void main() {
  vec4 c = texture(src, uv);
  int n = int(U[0].y);
  vec3 p = clamp(c.rgb, vec3(0.0), vec3(1.0)) * (float(n) - 1.0);
  vec3 sampled = tetra(p, n);
  o = vec4(mix(c.rgb, sampled, U[0].x), c.a);
}
`;

export const FS_SHARPEN_FX2 = FX2_HEAD + `void main() {
  vec4 blurred = texture(texA, uv);
  vec4 orig = texture(texB, uv);
  o = vec4(clamp(orig.rgb + (orig.rgb - blurred.rgb) * U[0].x, vec3(0.0), vec3(1.0)), orig.a);
}
`;

export const FS_NOISE_RED_FX2 = FX2_HEAD + `void main() {
  vec4 blurred = texture(texA, uv);
  vec4 orig = texture(texB, uv);
  o = vec4(mix(orig.rgb, blurred.rgb, U[0].x), orig.a);
}
`;

export const FS_CLARITY_FX2 = FX2_HEAD + `void main() {
  vec4 avg = texture(texA, uv);
  vec4 orig = texture(texB, uv);
  vec3 rgb = orig.rgb + (orig.rgb - avg.rgb) * U[0].x;
  rgb = (rgb - vec3(0.5)) * (1.0 + U[0].y * 0.5) + vec3(0.5);
  o = vec4(clamp(rgb, vec3(0.0), vec3(1.0)), orig.a);
}
`;

export const FS_GLOW_THRESH = FX_HEAD + `void main() {
  vec4 c = texture(src, uv);
  vec3 b = max(vec3(0.0), c.rgb - vec3(U[0].x)) / max(0.001, 1.0 - U[0].x);
  o = vec4(b, c.a);
}
`;

export const FS_GLOW_FX2 = FX2_HEAD + `void main() {
  vec3 glow = texture(texA, uv).rgb;
  vec4 orig = texture(texB, uv);
  vec3 warm = mix(glow, glow * vec3(1.1, 1.0, 0.85), U[0].y);
  o = vec4(clamp(orig.rgb + warm * U[0].x, vec3(0.0), vec3(1.0)), orig.a);
}
`;

export const FS_COMPOSITE = HEADER + `in vec2 uv; out vec4 o; uniform sampler2D src; uniform float opacity;
void main() {
  vec4 c = texture(src, uv);
  c.a = c.a * opacity;
  o = c;
}
`;

export const FS_STENCIL = HEADER + `in vec2 uv; out vec4 o; uniform sampler2D maskTex; uniform sampler2D dstTex;
uniform vec4 matte; uniform float opacity;
void main() {
  vec4 maskC = texture(maskTex, uv);
  vec4 dest = texture(dstTex, uv);
  float m = maskC.a;
  vec4 overC = vec4(matte.rgb * matte.a + dest.rgb * (1.0 - matte.a), matte.a + dest.a * (1.0 - matte.a));
  vec4 stenciled = mix(overC, dest, m);
  o = mix(dest, stenciled, opacity);
}
`;

export const FS_BLEND = HEADER + `in vec2 uv; out vec4 o; uniform sampler2D srcTex; uniform sampler2D dstTex;
uniform int mode; uniform float opacity;
float sep1(int md, float s, float d) {
  if (md == 1) { return min(s, d); }
  if (md == 2) { return s * d; }
  if (md == 3) { if (d <= 0.0) { return 0.0; } if (s <= 0.0) { return 0.0; } return 1.0 - min(1.0, (1.0 - d) / s); }
  if (md == 4) { return max(s, d); }
  if (md == 5) { return s + d - s * d; }
  if (md == 6) { if (d <= 0.0) { return 0.0; } if (s >= 1.0) { return 1.0; } return min(1.0, d / (1.0 - s)); }
  if (md == 7) { if (d <= 0.5) { return s * (2.0 * d); } return 1.0 - (1.0 - s) * (1.0 - 2.0 * (d - 0.5)); }
  if (md == 8) {
    if (s <= 0.5) { return d - (1.0 - 2.0 * s) * d * (1.0 - d); }
    float dd = sqrt(d);
    if (d <= 0.25) { dd = ((16.0 * d - 12.0) * d + 4.0) * d; }
    return d + (2.0 * s - 1.0) * (dd - d);
  }
  if (md == 9) { if (s <= 0.5) { return d * (2.0 * s); } return 1.0 - (1.0 - d) * (1.0 - 2.0 * (s - 0.5)); }
  if (md == 10) { return abs(s - d); }
  if (md == 11) { return s + d - 2.0 * s * d; }
  return s;
}
float bLum(vec3 c) { return 0.3 * c.r + 0.59 * c.g + 0.11 * c.b; }
vec3 clipColor(vec3 c) {
  float l = bLum(c);
  float n = min(c.r, min(c.g, c.b));
  float x = max(c.r, max(c.g, c.b));
  vec3 r = c;
  if (n < 0.0) { r = l + (c - vec3(l)) * l / (l - n); }
  if (x > 1.0) { r = l + (r - vec3(l)) * (1.0 - l) / (x - l); }
  return r;
}
vec3 setLum(vec3 c, float l) { return clipColor(c + vec3(l - bLum(c))); }
float bSat(vec3 c) { return max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b)); }
vec3 setSat(vec3 c, float s) {
  float mn = min(c.r, min(c.g, c.b));
  float mx = max(c.r, max(c.g, c.b));
  float md = c.r + c.g + c.b - mn - mx;
  float newMid = 0.0;
  float newMax = 0.0;
  if (mx > mn) { newMid = (md - mn) * s / (mx - mn); newMax = s; }
  vec3 r = vec3(0.0);
  if (c.r == mx) { r.r = newMax; } else if (c.r == mn) { r.r = 0.0; } else { r.r = newMid; }
  if (c.g == mx) { r.g = newMax; } else if (c.g == mn) { r.g = 0.0; } else { r.g = newMid; }
  if (c.b == mx) { r.b = newMax; } else if (c.b == mn) { r.b = 0.0; } else { r.b = newMid; }
  return r;
}
vec3 hslBlend(int md, vec3 s, vec3 d) {
  if (md == 12) { return setLum(setSat(s, bSat(d)), bLum(d)); }
  if (md == 13) { return setLum(setSat(d, bSat(s)), bLum(d)); }
  if (md == 14) { return setLum(s, bLum(d)); }
  return setLum(d, bLum(s));
}
vec3 blendRgb(int md, vec3 s, vec3 d) {
  if (md >= 12) { return hslBlend(md, s, d); }
  return vec3(sep1(md, s.r, d.r), sep1(md, s.g, d.g), sep1(md, s.b, d.b));
}
void main() {
  vec4 s = texture(srcTex, uv);
  vec4 d = texture(dstTex, uv);
  vec3 blended = clamp(blendRgb(mode, s.rgb, d.rgb), vec3(0.0), vec3(1.0));
  float k = s.a * opacity;
  float outA = d.a + s.a * opacity * (1.0 - d.a);
  o = vec4(mix(d.rgb, blended, k), outA);
}
`;
