import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("ring worklet source", () => {
  // Loaded as text at runtime with nothing compiling it, so TypeScript syntax would break audio.
  it("is plain JavaScript that registers the ring processor", () => {
    const source = readFileSync(new URL("../src/audio/ring-worklet.js", import.meta.url), "utf8");
    const registered: string[] = [];
    const run = new Function("AudioWorkletProcessor", "registerProcessor", source);
    run(class {}, (name: string) => registered.push(name));
    expect(registered).toEqual(["ring-processor"]);
  });
});
