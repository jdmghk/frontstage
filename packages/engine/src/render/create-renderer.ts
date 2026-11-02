import { FrameRenderer } from "./webgpu-renderer.js";
import { WebGL2Renderer } from "./webgl2-renderer.js";
import type { Renderer } from "./renderer.js";

// WebGPU when an adapter is available, otherwise WebGL2. FrameRenderer.create only touches the
// canvas after it has a device, so a failed attempt leaves the canvas free for a WebGL2 context.
export async function createRenderer(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<Renderer> {
  if (typeof navigator !== "undefined" && navigator.gpu) {
    try {
      return await FrameRenderer.create(canvas);
    } catch (e) {
      console.warn("WebGPU unavailable, using WebGL2:", e);
    }
  }
  return WebGL2Renderer.create(canvas);
}

// Canvas for headless rendering (export). WKWebView's OffscreenCanvas has no WebGL2 context, so
// without WebGPU it may have to be a detached element.
export function createExportCanvas(width: number, height: number): OffscreenCanvas | HTMLCanvasElement {
  const offscreen = typeof navigator !== "undefined" && navigator.gpu
    ? true
    : typeof OffscreenCanvas !== "undefined" && new OffscreenCanvas(1, 1).getContext("webgl2") !== null;
  if (offscreen) return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}
