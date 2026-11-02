import type { Mat2d, Size, CubeLUT } from "@frontstage/core";
import type { CompositeLayer } from "./composite-layer.js";

export type ReadPixelFn = (x: number, y: number) => Promise<[number, number, number, number]>;

export type RendererBackend = "webgpu" | "webgl2";

// What the engine needs from a GPU backend. readRGBA/readPixel are top-down (row 0 is the top of
// the picture) on every backend.
export interface Renderer {
  readonly backend: RendererBackend;
  composite(layers: CompositeLayer[], renderSize: Size): Promise<void>;
  present(frame: VideoFrame, mat: Mat2d, renderSize: Size): Promise<void>;
  readRGBA(): Promise<Uint8Array>;
  readPixel(x: number, y: number): Promise<[number, number, number, number]>;
  resize(w: number, h: number): void;
  registerLUT(path: string, cube: CubeLUT): void;
  dispose(): void;
}

export function readPixelFactory(renderer: Renderer): ReadPixelFn {
  return (x, y) => renderer.readPixel(x, y);
}
