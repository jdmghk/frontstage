import type { Renderer } from "../render/renderer.js";

export interface PushAudioPcm {
  /** Interleaved f32. */
  data: Float32Array;
  timestampUs: number;
  sampleRate: number;
  channels: number;
}

export interface PushFrameSource {
  offscreen: OffscreenCanvas | HTMLCanvasElement;
  renderer: Renderer;
  timestampUs: number;
  durationUs: number;
  keyFrame: boolean;
}

export interface ExportSink {
  configure(opts: { width: number; height: number; fps: number; audio?: { sampleRate: number; channels: number } }): Promise<void>;
  ready(): Promise<void>;
  pushFrame(source: PushFrameSource): void | Promise<void>;
  pushAudioData(data: AudioData): void | Promise<void>;
  /** Used where AudioData doesn't exist (WKWebView). */
  pushAudioPcm?(pcm: PushAudioPcm): void | Promise<void>;
  finalize(): Promise<Blob | undefined>;
}
