import type { PcmChunk } from "../decode/audio-decoder.js";
import { SabRingBuffer } from "./ring-buffer.js";
import { PortRing, type PortRingPort } from "./port-ring.js";

// Vite gives us the worklet's text. A `?url` import of a small file is inlined into production
// bundles as a data: URL, which addModule rejects, so we load the text from a same-origin blob.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- Vite ?raw suffix not typed; resolved to string at build time
import workletSource from "./ring-worklet.js?raw";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- Vite ?raw suffix not typed; resolved to string at build time
import portWorkletSource from "./port-worklet.js?raw";

async function addWorklet(ctx: AudioContext, source: string): Promise<void> {
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  try {
    await ctx.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export type AudioTransport = "sab" | "port";

export function preferredAudioTransport(): AudioTransport {
  return self.crossOriginIsolated && typeof SharedArrayBuffer !== "undefined" ? "sab" : "port";
}

export class AudioGraph {
  private constructor(
    private ctx: AudioContext,
    private node: AudioWorkletNode,
    private ring: Pick<SabRingBuffer, "write" | "availableRead" | "reset">,
    private capacityFrames: number,
    readonly transport: AudioTransport,
  ) {}

  static async create(channels: number, sampleRate: number, transport: AudioTransport = preferredAudioTransport()): Promise<AudioGraph> {
    const ctx = new AudioContext({ sampleRate });
    const capacityFrames = sampleRate; // ~1s buffer
    if (transport === "port") {
      await addWorklet(ctx, portWorkletSource as string);
      const node = new AudioWorkletNode(ctx, "port-ring-processor", {
        outputChannelCount: [channels],
        processorOptions: { channels },
      });
      node.connect(ctx.destination);
      const ring = new PortRing(node.port as unknown as PortRingPort, channels, capacityFrames);
      return new AudioGraph(ctx, node, ring, capacityFrames, transport);
    }
    await addWorklet(ctx, workletSource as string);
    const ring = SabRingBuffer.create(capacityFrames, channels);
    const node = new AudioWorkletNode(ctx, "ring-processor", {
      outputChannelCount: [channels],
      processorOptions: { sab: ring.sab, channels, capacityFrames },
    });
    node.connect(ctx.destination);
    return new AudioGraph(ctx, node, ring, capacityFrames, transport);
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
