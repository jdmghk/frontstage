import { describe, expect, test } from "vitest";
import { buildAudioPlan, dbToGain, defaultTimeline, EditorStore, setTrackGainCommand, TimelineSchema, type Timeline } from "../src/index.js";

function withAudioClip(): Timeline {
  const t = defaultTimeline();
  return {
    ...t,
    tracks: [
      { id: "a", type: "audio", muted: false, hidden: false, syncLocked: false, clips: [{ id: "c", mediaRef: "m", mediaType: "audio", startFrame: 0, durationFrames: 100, trimStartFrame: 0, trimEndFrame: 0, speed: 1, volume: 1 } as never] },
    ],
  };
}

describe("track gain", () => {
  test("multiplies every clip's gain on the track", () => {
    const store = new EditorStore(withAudioClip());
    const before = buildAudioPlan(store.getSnapshot().timeline, 10).clips[0]!.gain;
    store.dispatch(setTrackGainCommand("a", -6));
    const after = buildAudioPlan(store.getSnapshot().timeline, 10).clips[0]!.gain;
    expect(after).toBeCloseTo(before * dbToGain(-6), 6);
    expect(dbToGain(-6)).toBeCloseTo(0.501, 3);
  });

  test("clamps to -60…+12, 0 dB removes the field, and it's undoable", () => {
    const store = new EditorStore(withAudioClip());
    store.dispatch(setTrackGainCommand("a", 40));
    expect(store.getSnapshot().timeline.tracks[0]!.gainDb).toBe(12);
    store.dispatch(setTrackGainCommand("a", 0));
    expect("gainDb" in store.getSnapshot().timeline.tracks[0]!).toBe(false);
    store.undo();
    expect(store.getSnapshot().timeline.tracks[0]!.gainDb).toBe(12);
  });

  test("old timelines without gainDb still parse", () => {
    expect(TimelineSchema.parse(defaultTimeline()).tracks.every((t) => t.gainDb === undefined)).toBe(true);
  });
});
