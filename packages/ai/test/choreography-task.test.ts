import { describe, expect, test } from "vitest";
import { addChoreography, emptyProduction } from "@frontstage/core";
import { choreographyTask, choreoSampleFps, MAX_CHOREO_FRAMES } from "../src/studio/choreography-task.js";

function setup() {
  const c = addChoreography(emptyProduction(), { title: "ref", referenceMediaId: "v", permission: { attested: true } });
  if ("error" in c) throw new Error(c.error);
  const p = { ...c.production, choreographies: c.production.choreographies.map((x) => ({ ...x, notes: "fighter in red = Kai" })) };
  return { p, choreo: p.choreographies[0]! };
}
const frame = (i: number) => ({ timeSec: i * 0.5, mediaType: "image/jpeg" as const, base64: `F${i}` });

describe("choreographyTask", () => {
  test("sends the frames in order with their times and the user's notes", () => {
    const { p, choreo } = setup();
    const t = choreographyTask(p, choreo, [frame(0), frame(1), frame(2)]);
    expect(t.request.images).toEqual([{ mediaType: "image/jpeg", base64: "F0" }, { mediaType: "image/jpeg", base64: "F1" }, { mediaType: "image/jpeg", base64: "F2" }]);
    expect(t.request.prompt).toContain("Image 2: t=0.50s");
    expect(t.request.prompt).toContain("fighter in red = Kai");
  });

  test("never sends more than the frame cap", () => {
    const { p, choreo } = setup();
    expect(choreographyTask(p, choreo, Array.from({ length: 40 }, (_, i) => frame(i))).request.images).toHaveLength(MAX_CHOREO_FRAMES);
  });

  test("applies as a draft plan with sane durations", () => {
    const { p, choreo } = setup();
    const t = choreographyTask(p, choreo, [frame(0)]);
    const parsed = t.parse({
      shots: [{ durationSec: 30, characters: ["Kai"], startPositions: "s", action: "a", camera: "c", framing: "f", transitions: "t", impactTimesSec: [1, -2], continuity: "", prompt: "p" }],
    });
    const next = t.apply(p, parsed);
    expect(next.choreographies[0]).toMatchObject({ state: "draft", shots: [{ durationSec: 10, impactTimesSec: [1], action: "a" }] });
  });

  test("a reply in the wrong shape is rejected", () => {
    const { p, choreo } = setup();
    expect(() => choreographyTask(p, choreo, []).parse({ shots: [{ action: 1 }] })).toThrow(/expected shape/);
  });

  test("sampling rate keeps frames under the cap", () => {
    expect(choreoSampleFps(2)).toBe(4);
    expect(choreoSampleFps(40) * 40).toBeLessThanOrEqual(MAX_CHOREO_FRAMES);
    expect(choreoSampleFps(0)).toBe(1);
  });
});
