import { Muxer, ArrayBufferTarget } from "mp4-muxer";
import type { ExportSink, PushFrameSource } from "./export-sink.js";
import type { ExportOptions } from "./export-mp4.js";

async function drain(encoder: VideoEncoder | AudioEncoder, limit: number): Promise<void> {
  while (encoder.encodeQueueSize > limit) {
    await new Promise<void>((resolve) => {
      const onDequeue = () => resolve();
      try {
        encoder.addEventListener("dequeue", onDequeue, { once: true });
      } catch {
        // dequeue event unavailable — fall back to polling
        const poll = setInterval(() => {
          if (encoder.encodeQueueSize <= limit) { clearInterval(poll); resolve(); }
        }, 1);
        return;
      }
    });
  }
}

/**
 * Codec candidates (best first) and bitrate for YouTube-quality H.264: High profile at a level that
 * fits the frame (4.0 up to 1080p30, 4.2 for 1080p60, 5.1/5.2 for 4K), then Main as a fallback.
 * Bitrates follow YouTube's upload recommendations (1080p ≈ 8–12 Mbps, 4K ≈ 35–68 Mbps).
 */
export function youtubeVideoPlan(width: number, height: number, fps: number): { codecs: string[]; bitrate: number } {
  const pixels = width * height;
  const high = fps > 30;
  if (pixels > 1920 * 1088) {
    return { codecs: ["avc1.640033", "avc1.640034", "avc1.4d0033"], bitrate: high ? 68_000_000 : 45_000_000 };
  }
  if (pixels > 1280 * 720) {
    return { codecs: high ? ["avc1.64002a", "avc1.4d002a"] : ["avc1.640028", "avc1.64002a", "avc1.4d0028"], bitrate: high ? 15_000_000 : 12_000_000 };
  }
  return { codecs: ["avc1.64001f", "avc1.4d001f", "avc1.42001f"], bitrate: high ? 7_500_000 : 5_000_000 };
}

async function firstSupported(codecs: string[], width: number, height: number, bitrate: number, framerate: number): Promise<string | null> {
  for (const codec of codecs) {
    const r = await VideoEncoder.isConfigSupported({ codec, width, height, bitrate, framerate }).catch(() => ({ supported: false }));
    if (r.supported) return codec;
  }
  return null;
}

export class WebCodecsMp4Sink implements ExportSink {
  private opts: ExportOptions | undefined;
  private muxer!: Muxer<ArrayBufferTarget>;
  private target!: ArrayBufferTarget;
  private encoder!: VideoEncoder;
  private audioEncoder: AudioEncoder | undefined;
  private encoderError: Error | null = null;
  private audioError: Error | null = null;
  private _width = 0;
  private _height = 0;
  private _fps = 0;

  constructor(opts?: ExportOptions) {
    this.opts = opts;
  }

  async configure(configOpts: { width: number; height: number; fps: number; audio?: { sampleRate: number; channels: number } }): Promise<void> {
    const { width, height, fps, audio } = configOpts;
    this._width = width;
    this._height = height;
    this._fps = fps;

    this.target = new ArrayBufferTarget();
    this.muxer = new Muxer({
      target: this.target,
      video: { codec: "avc", width, height },
      fastStart: "in-memory",
      ...(audio ? { audio: { codec: "aac" as const, sampleRate: audio.sampleRate, numberOfChannels: audio.channels } } : {}),
    });

    this.encoderError = null;
    this.encoder = new VideoEncoder({
      output: (chunk, meta) => this.muxer.addVideoChunk(chunk, meta!),
      error: (e) => { this.encoderError = e; },
    });

    let codec: string;
    let bitrate = this.opts?.bitrate ?? 5_000_000;
    if (this.opts?.quality === "youtube") {
      const plan = youtubeVideoPlan(width, height, fps);
      bitrate = this.opts?.bitrate ?? plan.bitrate;
      const found = await firstSupported(plan.codecs, width, height, bitrate, fps);
      if (!found) throw new Error(`This browser can't encode ${width}×${height} H.264. Use the desktop app, or a smaller size.`);
      codec = found;
    } else {
      const supported = await VideoEncoder.isConfigSupported({ codec: "avc1.42001f", width, height, bitrate, framerate: fps });
      codec = supported.supported ? "avc1.42001f" : "avc1.42E01F";
    }

    this.encoder.configure({
      codec,
      width,
      height,
      bitrate,
      framerate: fps,
    });

    if (audio) {
      this.audioError = null;
      this.audioEncoder = new AudioEncoder({
        output: (chunk, meta) => this.muxer.addAudioChunk(chunk, meta!),
        error: (e) => { this.audioError = e; },
      });
      this.audioEncoder.configure({
        codec: "mp4a.40.2",
        sampleRate: audio.sampleRate,
        numberOfChannels: audio.channels,
        bitrate: this.opts?.quality === "youtube" ? 320_000 : 128_000,
      });
    }
  }

  async ready(): Promise<void> {
    if (this.encoderError) throw this.encoderError;
    await drain(this.encoder, 8);
    if (this.encoderError) throw this.encoderError;
    if (this.audioEncoder) {
      if (this.audioError) throw this.audioError;
      await drain(this.audioEncoder, 8);
      if (this.audioError) throw this.audioError;
    }
  }

  pushFrame(source: PushFrameSource): void {
    const vf = new VideoFrame(source.offscreen, { timestamp: source.timestampUs, duration: source.durationUs });
    try {
      this.encoder.encode(vf, { keyFrame: source.keyFrame });
    } finally {
      vf.close();
    }
  }

  pushAudioData(data: AudioData): void {
    if (this.audioEncoder) {
      this.audioEncoder.encode(data);
    }
  }

  async finalize(): Promise<Blob | undefined> {
    try {
      await this.encoder.flush();
      if (this.encoderError) throw this.encoderError;
      if (this.audioEncoder) {
        await this.audioEncoder.flush();
        if (this.audioError) throw this.audioError;
      }
      this.muxer.finalize();
      return new Blob([this.target.buffer], { type: "video/mp4" });
    } finally {
      try { if (this.encoder.state !== "closed") this.encoder.close(); } catch { /* already closed */ }
      try { if (this.audioEncoder && this.audioEncoder.state !== "closed") this.audioEncoder.close(); } catch { /* already closed */ }
    }
  }
}
