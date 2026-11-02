import { FrameRenderer, WebGL2Renderer, blurRGBA, createRenderer } from "@frontstage/engine";
import { PARITY_CASES, DEFAULT_TOLERANCE, W, H, Sources, compareRGBA, registerParityLUTs, type Diff } from "./parity-cases.js";

export interface ParityRow extends Diff {
  name: string;
  tolerance: number;
  note?: string;
  reportOnly: boolean;
  passed: boolean;
}

declare global {
  interface Window {
    __status: string;
    __parity: ParityRow[];
    __parityInfo: Record<string, unknown>;
    __parityRefs: () => Record<string, string>;
    __parityImages: (name: string) => { gpu: string; gl: string };
  }
}

const b64 = (d: Uint8Array) => {
  let s = "";
  for (let i = 0; i < d.length; i += 0x8000) s += String.fromCharCode(...d.subarray(i, i + 0x8000));
  return btoa(s);
};

// WebKit has no canvas filter, so its text blur is blurRGBA. Compare it to the real thing here.
function blurFallbackDiff() {
  const draw = (filter: boolean) => {
    const c = new OffscreenCanvas(W, H).getContext("2d")!;
    if (filter) c.filter = "blur(4px)";
    c.font = "40px Helvetica";
    c.textBaseline = "middle";
    c.fillStyle = "white";
    c.fillText("Blur", 20, 45);
    return c.getImageData(0, 0, W, H).data;
  };
  const real = draw(true);
  const plain = draw(false);
  blurRGBA(plain, W, H, 4);
  let max = 0, sum = 0;
  for (let i = 3; i < real.length; i += 4) { const d = Math.abs(real[i]! - plain[i]!); sum += d; if (d > max) max = d; }
  return { alphaMax: max, alphaMean: +(sum / (W * H)).toFixed(3) };
}

async function main() {
  const status = document.getElementById("status")!;
  try {
    const gpuCanvas = document.getElementById("gpu") as HTMLCanvasElement;
    const glCanvas = document.getElementById("gl") as HTMLCanvasElement;
    gpuCanvas.width = glCanvas.width = W;
    gpuCanvas.height = glCanvas.height = H;
    const gpu = await FrameRenderer.create(gpuCanvas);
    const gl = await WebGL2Renderer.create(glCanvas);
    registerParityLUTs(gpu);
    registerParityLUTs(gl);
    const sources = await Sources.create();
    window.__parityInfo = {
      formats: { bitmap: sources.bitmap.format, text: sources.text.format, image: sources.image.frame().format, h264: sources.h264?.format, h264cs: sources.h264?.colorSpace.toJSON() },
    };
    window.__parityInfo.blurFallbackVsCanvasFilter = blurFallbackDiff();
    const refs: Record<string, string> = {};
    const shots = new Map<string, { gpu: Uint8Array; gl: Uint8Array }>();
    const rows: ParityRow[] = [];
    for (const c of PARITY_CASES) {
      const layers = c.layers(sources);
      if (!layers) throw new Error(`Chromium must be able to build every source: ${c.name}`);
      const size = { width: W, height: H };
      await gpu.composite(layers, size);
      const a = await gpu.readRGBA();
      await gl.composite(layers, size);
      const b = await gl.readRGBA();
      const tolerance = c.tolerance ?? DEFAULT_TOLERANCE;
      const d = compareRGBA(a, b, tolerance);
      rows.push({
        name: c.name, ...d, tolerance, note: c.note, reportOnly: c.reportOnly === true,
        passed: c.reportOnly === true || d.overTol === 0,
      });
      refs[c.name] = b64(a);
      shots.set(c.name, { gpu: a, gl: b });
    }
    if (sources.h264) {
      const planes = new Uint8Array(sources.h264.allocationSize());
      await sources.h264.copyTo(planes);
      refs["__h264planes"] = b64(planes);
    }
    // A lost and restored context must render again, including the LUT it has to re-upload.
    const lose = glCanvas.getContext("webgl2")!.getExtension("WEBGL_lose_context");
    if (lose) {
      const restored = new Promise((res) => glCanvas.addEventListener("webglcontextrestored", res, { once: true }));
      lose.loseContext();
      await new Promise((res) => setTimeout(res, 50));
      lose.restoreContext();
      await restored;
      const lutCase = PARITY_CASES.find((c) => c.name === "effect-lut-3d")!;
      const layers = lutCase.layers(sources)!;
      await gpu.composite(layers, { width: W, height: H });
      await gl.composite(layers, { width: W, height: H });
      window.__parityInfo.contextRestore = compareRGBA(await gpu.readRGBA(), await gl.readRGBA(), DEFAULT_TOLERANCE);
    }
    const probe = await createRenderer(new OffscreenCanvas(8, 8));
    window.__parityInfo.factoryBackend = probe.backend;
    probe.dispose();
    window.__parity = rows;
    window.__parityRefs = () => refs;
    window.__parityImages = (name) => {
      const s = shots.get(name)!;
      return { gpu: b64(s.gpu), gl: b64(s.gl) };
    };
    status.textContent = "ok";
  } catch (e) {
    status.textContent = `error: ${e instanceof Error ? `${e.message}\n${e.stack}` : String(e)}`;
  }
}

void main();
