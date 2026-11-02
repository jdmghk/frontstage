// Main-thread side of the MessagePort ring, for pages without SharedArrayBuffer. Same write,
// availableRead and reset as SabRingBuffer. The worklet owns the samples; here we only count, from
// its acks, so availableRead can lag by up to one ack interval and never under-reports.

export interface PortRingPort {
  postMessage(message: unknown, transfer: Transferable[]): void;
  onmessage: ((e: { data: PortRingAck }) => void) | null;
}

export interface PortRingAck {
  gen: number;
  consumed: number;
  underrun?: number;
}

export class PortRing {
  private gen = 0;
  private written = 0;
  private consumed = 0;
  /** Silent frames the worklet played after running dry, as of the latest ack. */
  underrunFrames = 0;

  constructor(
    private port: PortRingPort,
    private channels: number,
    private capacityFrames: number,
  ) {
    port.onmessage = (e) => {
      // An ack from before the last reset describes samples that were thrown away.
      if (e.data.gen !== this.gen) return;
      if (e.data.consumed > this.consumed) this.consumed = e.data.consumed;
      this.underrunFrames = e.data.underrun ?? this.underrunFrames;
    };
  }

  write(interleaved: Float32Array): number {
    // Usable capacity matches SabRingBuffer: capacityFrames - 1.
    const free = this.capacityFrames - 1 - this.availableRead();
    const n = Math.min(Math.floor(interleaved.length / this.channels), free);
    if (n <= 0) return 0;
    const data = interleaved.slice(0, n * this.channels);
    this.port.postMessage({ type: "pcm", gen: this.gen, data }, [data.buffer]);
    this.written += n;
    return n;
  }

  availableRead(): number {
    return this.written - this.consumed;
  }

  reset(): void {
    this.gen++;
    this.written = 0;
    this.consumed = 0;
    this.underrunFrames = 0;
    this.port.postMessage({ type: "reset", gen: this.gen }, []);
  }
}
