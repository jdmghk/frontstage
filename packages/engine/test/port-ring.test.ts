import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PortRing, type PortRingAck, type PortRingPort } from "../src/audio/port-ring.js";

interface WorkletHarness {
  process: (frames: number, outChannels?: number) => Float32Array[];
  acks: PortRingAck[];
  flushToWorklet: () => void;
  flushToMain: () => void;
  mainPort: PortRingPort;
}

// Runs the real worklet text against the real PortRing through a fake port pair with explicit
// delivery, so tests can hold messages in flight the way a real thread boundary does.
function harness(channels: number): WorkletHarness {
  const source = readFileSync(new URL("../src/audio/port-worklet.js", import.meta.url), "utf8");
  const toWorklet: unknown[] = [];
  const toMain: PortRingAck[] = [];
  const acks: PortRingAck[] = [];
  class Base {
    port = {
      onmessage: null as ((e: { data: unknown }) => void) | null,
      postMessage: (m: PortRingAck) => { toMain.push(m); acks.push(m); },
    };
  }
  let Processor: new (o: unknown) => Base & { process: (i: unknown, o: Float32Array[][]) => boolean };
  new Function("AudioWorkletProcessor", "registerProcessor", source)(Base, (_: string, c: typeof Processor) => { Processor = c; });
  const worklet = new Processor!({ processorOptions: { channels } });
  const mainPort: PortRingPort = {
    onmessage: null,
    postMessage: (m) => { toWorklet.push(m); },
  };
  return {
    acks,
    mainPort,
    flushToWorklet: () => { for (const m of toWorklet.splice(0)) worklet.port.onmessage!({ data: m }); },
    flushToMain: () => { for (const m of toMain.splice(0)) mainPort.onmessage!({ data: m }); },
    process: (frames, outChannels = channels) => {
      const out = Array.from({ length: outChannels }, () => new Float32Array(frames));
      worklet.process([], [out]);
      return out;
    },
  };
}

const ramp = (frames: number, channels: number, start = 0) => {
  const d = new Float32Array(frames * channels);
  for (let f = 0; f < frames; f++) for (let c = 0; c < channels; c++) d[f * channels + c] = start + f + c / 10;
  return d;
};

describe("PortRing accounting", () => {
  it("counts written frames as buffered until the worklet acks them", () => {
    const h = harness(2);
    const ring = new PortRing(h.mainPort, 2, 4800);
    expect(ring.write(ramp(2048, 2))).toBe(2048);
    expect(ring.availableRead()).toBe(2048);
    h.flushToWorklet();
    h.process(128);
    h.flushToMain();
    expect(ring.availableRead()).toBe(2048); // under the ack interval: stale high, never low
    for (let i = 0; i < 7; i++) h.process(128);
    h.flushToMain();
    expect(ring.availableRead()).toBe(2048 - 1024);
  });

  it("refuses frames past capacity - 1, like SabRingBuffer", () => {
    const ring = new PortRing(harness(1).mainPort, 1, 1000);
    expect(ring.write(ramp(1500, 1))).toBe(999);
    expect(ring.availableRead()).toBe(999);
    expect(ring.write(ramp(10, 1))).toBe(0);
  });

  it("frees space once acks arrive", () => {
    const h = harness(1);
    const ring = new PortRing(h.mainPort, 1, 2000);
    ring.write(ramp(1999, 1));
    h.flushToWorklet();
    for (let i = 0; i < 8; i++) h.process(128);
    h.flushToMain();
    expect(ring.availableRead()).toBe(1999 - 1024);
    expect(ring.write(ramp(2000, 1))).toBe(1024);
  });

  it("acks the remainder as soon as the queue drains, so availableRead reaches 0", () => {
    const h = harness(2);
    const ring = new PortRing(h.mainPort, 2, 4800);
    ring.write(ramp(300, 2));
    h.flushToWorklet();
    h.process(128);
    h.process(128);
    h.process(128);
    h.flushToMain();
    expect(ring.availableRead()).toBe(0);
  });

  it("reports underrun frames from the worklet", () => {
    const h = harness(1);
    const ring = new PortRing(h.mainPort, 1, 4800);
    ring.write(ramp(1100, 1));
    h.flushToWorklet();
    for (let i = 0; i < 9; i++) h.process(128); // 1152 frames asked, 1100 available
    h.flushToMain();
    expect(ring.availableRead()).toBe(0);
    expect(ring.underrunFrames).toBe(52);
    ring.reset();
    expect(ring.underrunFrames).toBe(0);
  });

  it("ignores acks and PCM from before a reset", () => {
    const h = harness(1);
    const ring = new PortRing(h.mainPort, 1, 4800);
    ring.write(ramp(2048, 1));
    h.flushToWorklet();
    for (let i = 0; i < 8; i++) h.process(128);
    ring.write(ramp(512, 1, 5000)); // in flight when reset lands
    ring.reset();
    expect(ring.availableRead()).toBe(0);
    h.flushToMain(); // stale ack, consumed=1024, gen 0
    expect(ring.availableRead()).toBe(0);
    ring.write(ramp(256, 1, 9000));
    expect(ring.availableRead()).toBe(256);
    h.flushToWorklet();
    const out = h.process(128)[0]!;
    expect(out[0]).toBe(9000); // the pre-reset chunk was dropped
    h.flushToMain();
    expect(ring.availableRead()).toBe(256); // 128 consumed, below the ack interval
  });
});

describe("port worklet", () => {
  it("registers under the name AudioGraph uses and is plain JavaScript", () => {
    const source = readFileSync(new URL("../src/audio/port-worklet.js", import.meta.url), "utf8");
    const names: string[] = [];
    new Function("AudioWorkletProcessor", "registerProcessor", source)(class {}, (n: string) => names.push(n));
    expect(names).toEqual(["port-ring-processor"]);
  });

  it("plays frames in order across chunk boundaries and pads an underrun with silence", () => {
    const h = harness(2);
    const ring = new PortRing(h.mainPort, 2, 4800);
    ring.write(ramp(100, 2));
    ring.write(ramp(100, 2, 100));
    h.flushToWorklet();
    const [l, r] = h.process(128) as [Float32Array, Float32Array];
    for (let f = 0; f < 128; f++) {
      expect(l[f]).toBeCloseTo(f, 3);
      expect(r[f]).toBeCloseTo(f + 0.1, 3);
    }
    const [l2] = h.process(128) as [Float32Array];
    expect(l2[71]).toBeCloseTo(199, 3);
    expect(l2[72]).toBe(0);
    expect(l2[127]).toBe(0);
  });

  it("upmixes a mono source to every output channel", () => {
    const h = harness(1);
    const ring = new PortRing(h.mainPort, 1, 4800);
    ring.write(ramp(128, 1));
    h.flushToWorklet();
    const [l, r] = h.process(128, 2) as [Float32Array, Float32Array];
    expect(Array.from(r)).toEqual(Array.from(l));
    expect(l[5]).toBe(5);
  });
});
