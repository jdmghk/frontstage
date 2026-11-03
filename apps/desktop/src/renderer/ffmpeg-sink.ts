import type { ExportSink, PushAudioPcm, PushFrameSource } from "@frontstage/engine";

export interface DesktopExportBridge {
  start(opts: { width: number; height: number; fps: number; audio?: { sampleRate: number; channels: number }; codec: string; outPath: string; subtitlesSrt?: string }): Promise<string>;
  // Electron's IPC send returns nothing. Tauri's returns a promise, which the sink awaits so frames
  // stay in order and a fast renderer can't queue gigabytes ahead of ffmpeg.
  videoFrame(buf: Uint8Array): void | Promise<void>;
  audioData(buf: Uint8Array): void | Promise<void>;
  finish(): Promise<string>;
}

export interface FfmpegIpcSinkOptions {
  codec: string;
  outPath: string;
  /** SRT text muxed in as a soft subtitle track. */
  subtitlesSrt?: string;
}

export class FfmpegIpcSink implements ExportSink {
  private bridge: DesktopExportBridge;
  private codec: string;
  private outPath: string;
  private subtitlesSrt?: string;
  private width = 0;
  private height = 0;

  constructor(bridge: DesktopExportBridge, opts: FfmpegIpcSinkOptions) {
    this.bridge = bridge;
    this.codec = opts.codec;
    this.outPath = opts.outPath;
    this.subtitlesSrt = opts.subtitlesSrt;
  }

  async configure(opts: { width: number; height: number; fps: number; audio?: { sampleRate: number; channels: number } }): Promise<void> {
    this.width = opts.width;
    this.height = opts.height;
    await this.bridge.start({ ...opts, codec: this.codec, outPath: this.outPath, ...(this.subtitlesSrt ? { subtitlesSrt: this.subtitlesSrt } : {}) });
  }

  async ready(): Promise<void> {
    // IPC is async by nature; no encoder queue to drain here
  }

  // Extract RGBA via VideoFrame.copyTo — NOT FrameRenderer.readRGBA() (packages/engine/src/render/webgpu-renderer.ts), which loses the GPU device in a sustained Electron loop.
  async pushFrame(source: PushFrameSource): Promise<void> {
    // WebGL2 has no device to lose, and its canvas isn't reliably readable through a VideoFrame on WebKit.
    if (source.renderer.backend === "webgl2") {
      await this.bridge.videoFrame(await source.renderer.readRGBA());
      return;
    }
    const rgba = new Uint8Array(this.width * this.height * 4);
    const vf = new VideoFrame(source.offscreen, { timestamp: source.timestampUs });
    try {
      await vf.copyTo(rgba, { format: "RGBA" });
    } finally {
      vf.close();
    }
    await this.bridge.videoFrame(rgba);
  }

  async pushAudioData(data: AudioData): Promise<void> {
    const f32 = new Float32Array(data.numberOfFrames * data.numberOfChannels);
    // f32 (interleaved) — all channels in plane 0, no left-channel-only reduction
    await data.copyTo(f32, { planeIndex: 0, format: "f32" });
    await this.bridge.audioData(new Uint8Array(f32.buffer));
  }

  async pushAudioPcm(pcm: PushAudioPcm): Promise<void> {
    await this.bridge.audioData(new Uint8Array(pcm.data.buffer, pcm.data.byteOffset, pcm.data.byteLength));
  }

  async finalize(): Promise<undefined> {
    await this.bridge.finish();
    return undefined;
  }
}
