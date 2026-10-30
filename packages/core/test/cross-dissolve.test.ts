import { describe, expect, test } from "vitest";
import { crossDissolveCommand, cropAt, defaultTimeline, EditorStore, findClip, opacityAt, planCrossDissolve, planTransition, topLeftAt, transitionCommand, type Clip, type Timeline } from "../src/index.js";

const clip = (id: string, start: number, dur: number, extra: Partial<Clip> = {}): Clip =>
  ({ id, mediaRef: `m-${id}`, mediaType: "video", sourceClipType: "video", startFrame: start, durationFrames: dur, trimStartFrame: 0, trimEndFrame: 0, speed: 1, volume: 1, fadeInFrames: 0, fadeOutFrames: 0, fadeInInterpolation: "linear", fadeOutInterpolation: "linear", opacity: 1, transform: { centerX: 0.5, centerY: 0.5, width: 1, height: 1, rotation: 0, flipHorizontal: false, flipVertical: false }, crop: { left: 0, top: 0, right: 0, bottom: 0 }, ...extra }) as Clip;

function tl(a: Partial<Clip>, b: Partial<Clip>, extraTracks: Timeline["tracks"] = []): Timeline {
  return {
    ...defaultTimeline(),
    tracks: [
      ...extraTracks,
      { id: "v1", type: "video", muted: false, hidden: false, syncLocked: false, clips: [clip("a", 0, 100, a), clip("b", 100, 100, b), clip("c", 200, 50)] },
      { id: "au", type: "audio", muted: false, hidden: false, syncLocked: false, clips: [clip("music", 0, 250, { mediaType: "audio" })] },
    ],
  };
}

describe("cross-dissolve", () => {
  test("uses the outgoing clip's spare tail: A extends under B, B fades in above, nothing else moves", () => {
    const store = new EditorStore(tl({ trimEndFrame: 30 }, {}));
    store.dispatch(crossDissolveCommand("b", 24, () => "new-track"));
    const t = store.getSnapshot().timeline;
    const where = (id: string) => {
      const l = findClip(t, id)!;
      return { track: t.tracks[l.trackIndex]!.id, clip: t.tracks[l.trackIndex]!.clips[l.clipIndex]! };
    };
    expect(where("b")).toMatchObject({ track: "new-track", clip: { startFrame: 100, durationFrames: 100, fadeInFrames: 24 } });
    expect(where("a").clip).toMatchObject({ startFrame: 0, durationFrames: 124, trimEndFrame: 6 });
    expect(where("c").clip.startFrame).toBe(200);
    expect(where("music").clip.startFrame).toBe(0);
    expect(t.tracks[0]!.id).toBe("new-track");
    expect(opacityAt(where("b").clip, 112)).toBeCloseTo(0.5, 2);
    store.undo();
    expect(store.getSnapshot().timeline.tracks.map((x) => x.id)).toEqual(["v1", "au"]);
  });

  test("falls back to the incoming clip's spare head and moves its linked audio with it", () => {
    const linkedAudio = { id: "la", type: "audio" as const, muted: false, hidden: false, syncLocked: false, clips: [clip("b-audio", 100, 100, { mediaType: "audio", trimStartFrame: 40, linkGroupId: "g" })] };
    const store = new EditorStore({ ...tl({}, { trimStartFrame: 40, linkGroupId: "g" }), tracks: [...tl({}, { trimStartFrame: 40, linkGroupId: "g" }).tracks, linkedAudio] });
    expect(planCrossDissolve(store.getSnapshot().timeline, "b", 20)).toMatchObject({ ok: true, mode: "incoming-head" });
    store.dispatch(crossDissolveCommand("b", 20));
    const t = store.getSnapshot().timeline;
    const b = t.tracks.flatMap((x) => x.clips).find((c) => c.id === "b")!;
    const la = t.tracks.flatMap((x) => x.clips).find((c) => c.id === "b-audio")!;
    expect(b).toMatchObject({ startFrame: 80, durationFrames: 120, trimStartFrame: 20, fadeInFrames: 20 });
    expect(la).toMatchObject({ startFrame: 80, trimStartFrame: 20 });
  });

  test("reuses a free video track above instead of adding one", () => {
    const above = { id: "v0", type: "video" as const, muted: false, hidden: false, syncLocked: false, clips: [clip("title", 300, 20)] };
    const store = new EditorStore(tl({ trimEndFrame: 30 }, {}, [above]));
    store.dispatch(crossDissolveCommand("b", 10));
    const t = store.getSnapshot().timeline;
    expect(t.tracks.map((x) => x.id)).toEqual(["v0", "v1", "au"]);
    expect(t.tracks[0]!.clips.map((c) => c.id)).toEqual(["b", "title"]);
  });

  test("refuses with a clear reason and leaves the timeline untouched", () => {
    const base = tl({}, {});
    expect(planCrossDissolve(base, "b", 24)).toMatchObject({ ok: false, message: expect.stringContaining("spare frames") });
    expect(planCrossDissolve(base, "a", 24)).toMatchObject({ ok: false, message: expect.stringContaining("directly follows") });
    expect(planCrossDissolve(tl({ trimEndFrame: 100 }, {}), "b", 80)).toMatchObject({ ok: false, message: expect.stringContaining("half") });
    const store = new EditorStore(base);
    store.dispatch(crossDissolveCommand("b", 24));
    expect(store.getSnapshot().timeline).toBe(base);
  });
});

describe("slide and wipe", () => {
  test("slide from the right: B starts one frame-width right of its place and lands there", () => {
    const store = new EditorStore(tl({ trimEndFrame: 30 }, {}));
    store.dispatch(transitionCommand("b", 20, { type: "slide", from: "right" }));
    const b = store.getSnapshot().timeline.tracks.flatMap((x) => x.clips).find((c) => c.id === "b")!;
    expect(b.fadeInFrames).toBe(0);
    expect(topLeftAt(b, b.startFrame)).toEqual({ x: 1, y: 0 });
    expect(topLeftAt(b, b.startFrame + 20)).toEqual({ x: 0, y: 0 });
    expect(topLeftAt(b, b.startFrame + 10).x).toBeCloseTo(0.5, 5);
  });

  test("wipe from the left: B is fully cropped from the right, then opens to its own crop", () => {
    const store = new EditorStore(tl({ trimEndFrame: 30 }, {}));
    store.dispatch(transitionCommand("b", 20, { type: "wipe", from: "left" }));
    const b = store.getSnapshot().timeline.tracks.flatMap((x) => x.clips).find((c) => c.id === "b")!;
    expect(cropAt(b, b.startFrame)).toEqual({ left: 0, top: 0, right: 1, bottom: 0 });
    expect(cropAt(b, b.startFrame + 10).right).toBeCloseTo(0.5, 5);
    expect(cropAt(b, b.startFrame + 20)).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
  });

  test("refuses when the clip already has keyframes of that kind", () => {
    const pos = { keyframes: [{ frame: 0, value: { a: 0, b: 0 }, interpolationOut: "linear" as const }] };
    expect(planTransition(tl({ trimEndFrame: 30 }, { positionTrack: pos }), "b", 10, { type: "slide", from: "left" })).toMatchObject({ ok: false, message: expect.stringContaining("position keyframes") });
  });
});
