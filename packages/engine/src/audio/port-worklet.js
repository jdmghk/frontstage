// AudioWorkletGlobalScope: no imports, no DOM, no bundler globals. Plain JS because audio-graph.ts
// loads this exact text (?raw) as a blob, so nothing compiles it.
// Used where SharedArrayBuffer is missing. PCM arrives as messages; acks report cumulative frames
// consumed so the main thread can track what's buffered. See PortRing in port-ring.ts.

const ACK_EVERY_FRAMES = 1024;

class PortRingProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.channels = options.processorOptions.channels;
    this.queue = [];
    this.offset = 0; // next sample index within queue[0]
    this.gen = 0;
    this.consumed = 0;
    this.acked = 0;
    this.underrun = 0; // silent frames since the last reset, once playback has begun
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === "pcm") {
        if (m.gen === this.gen) this.queue.push(m.data);
      } else if (m.type === "reset") {
        this.gen = m.gen;
        this.queue = [];
        this.offset = 0;
        this.consumed = 0;
        this.acked = 0;
        this.underrun = 0;
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const frames = out[0].length;
    const channels = this.channels;
    let i = 0;
    while (i < frames && this.queue.length > 0) {
      const chunk = this.queue[0];
      const n = Math.min(frames - i, (chunk.length - this.offset) / channels);
      for (let f = 0; f < n; f++) {
        // Math.min clamps ch to last source channel, upmixing when output has more channels than source.
        for (let ch = 0; ch < out.length; ch++) {
          out[ch][i + f] = chunk[this.offset + f * channels + Math.min(ch, channels - 1)];
        }
      }
      i += n;
      this.consumed += n;
      this.offset += n * channels;
      if (this.offset >= chunk.length) {
        this.queue.shift();
        this.offset = 0;
      }
    }
    if (i < frames && this.consumed > 0) this.underrun += frames - i;
    for (; i < frames; i++) {
      for (let ch = 0; ch < out.length; ch++) out[ch][i] = 0;
    }
    const drained = this.queue.length === 0;
    if (this.consumed - this.acked >= ACK_EVERY_FRAMES || (drained && this.consumed > this.acked)) {
      this.acked = this.consumed;
      this.port.postMessage({ gen: this.gen, consumed: this.consumed, underrun: this.underrun });
    }
    return true;
  }
}

registerProcessor("port-ring-processor", PortRingProcessor);
