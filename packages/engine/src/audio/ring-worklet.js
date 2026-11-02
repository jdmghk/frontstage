// AudioWorkletGlobalScope: no imports, no DOM, no bundler globals. Plain JS because audio-graph.ts
// loads this exact text (?raw) as a blob, so nothing compiles it.
// Header layout MUST match SabRingBuffer: [readIdx, writeIdx] as Int32 at byte offsets 0,4; data as Float32 at byte offset 8.

class RingProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { sab, channels, capacityFrames } = options.processorOptions;
    this.header = new Int32Array(sab, 0, 2);
    this.data = new Float32Array(sab, 8);
    this.channels = channels;
    this.capacity = capacityFrames;
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const frames = out[0].length;
    const read = Atomics.load(this.header, 0);
    const write = Atomics.load(this.header, 1);
    const avail = (write - read + this.capacity) % this.capacity;
    const n = Math.min(frames, avail);
    for (let i = 0; i < frames; i++) {
      if (i < n) {
        const base = ((read + i) % this.capacity) * this.channels;
        // Math.min clamps ch to last source channel, upmixing when output has more channels than source.
        for (let ch = 0; ch < out.length; ch++) {
          out[ch][i] = this.data[base + Math.min(ch, this.channels - 1)];
        }
      } else {
        for (let ch = 0; ch < out.length; ch++) out[ch][i] = 0;
      }
    }
    Atomics.store(this.header, 0, (read + n) % this.capacity);
    return true;
  }
}

registerProcessor("ring-processor", RingProcessor);
