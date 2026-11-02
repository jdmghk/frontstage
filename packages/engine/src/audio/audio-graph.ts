import type { PcmChunk } from "../decode/audio-decoder.js";
import { SabRingBuffer } from "./ring-buffer.js";

// Vite gives us the worklet's text. A `?url` import of a small file is inlined into production
// bundles as a data: URL, which addModule rejects, so we load the text from a same-origin blob.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- Vite ?raw suffix not typed; resolved to string at build time
import workletSource from "./ring-worklet.js?raw";

async function addWorklet(ctx: AudioContext): Promise<void> {
  const url = URL.createObjectURL(new Blob([workletSource as string], { type: "text/javascript" }));
  try {
    await ctx.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export class AudioGraph {
  private constructor(
    private ctx: AudioContext,
    private node: AudioWorkletNode,
    private ring: SabRingBuffer,
    private capacityFrames: number,
  ) {}

  static async create(channels: number, sampleRate: number): Promise<AudioGraph> {
    if (!self.crossOriginIsolated) {
      throw new Error("EngineUnsupported: SharedArrayBuffer needs cross-origin isolation (COOP/COEP)");
    }
    const ctx = new AudioContext({ sampleRate });
    await addWorklet(ctx);
    const capacityFrames = sampleRate; // ~1s buffer
    const ring = SabRingBuffer.create(capacityFrames, channels);
    const node = new AudioWorkletNode(ctx, "ring-processor", {
      outputChannelCount: [channels],
      processorOptions: { sab: ring.sab, channels, capacityFrames },
    });
    node.connect(ctx.destination);
    return new AudioGraph(ctx, node, ring, capacityFrames);
  }

  pushPcm(pcm: PcmChunk): void {
    this.ring.write(pcm.data);
  }

  async start(): Promise<void> {
    if (this.ctx.state !== "running") await this.ctx.resume();
  }

  stop(): void {
    void this.ctx.suspend();
  }

  reset(): void {
    this.ring.reset();
  }

  get currentTime(): number {
    return this.ctx.currentTime;
  }

  get availableRead(): number {
    return this.ring.availableRead();
  }

  get freeSpaceFrames(): number {
    // One slot reserved (ring disambiguates full vs empty), so usable capacity is capacityFrames - 1
    return this.capacityFrames - 1 - this.ring.availableRead();
  }

  dispose(): void {
    this.node.disconnect();
    void this.ctx.close();
  }
}
