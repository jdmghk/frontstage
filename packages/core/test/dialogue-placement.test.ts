import { describe, expect, test } from "vitest";
import {
  addScene,
  addShot,
  defaultTimeline,
  EditorStore,
  emptyProduction,
  findClip,
  linkLineClip,
  linkShotClip,
  placeLineCommand,
  placeShotOnTimeline,
  resolveLinePlacement,
  updateScene,
  type MediaManifestEntry,
  type Production,
} from "../src/index.js";

const video = (id: string, duration: number): MediaManifestEntry => ({ id, name: id, type: "video", source: { kind: "project", relativePath: `media/${id}.mp4` }, duration, hasAudio: false });
const audio = (id: string, duration: number): MediaManifestEntry => ({ id, name: id, type: "audio", source: { kind: "project", relativePath: `media/${id}.wav` }, duration, hasAudio: true });

function sceneWithTwoPlacedShots() {
  const s = addScene(emptyProduction(), { title: "S" });
  let p: Production = s.production;
  const a = addShot(p, s.sceneId, { title: "A" });
  p = a.production;
  const b = addShot(p, s.sceneId, { title: "B" });
  p = b.production;
  let timeline = defaultTimeline();
  const ra = placeShotOnTimeline(p, timeline, a.shotId!, video("va", 4));
  timeline = ra.timeline;
  p = linkShotClip(p, a.shotId!, ra.clipId!);
  const rb = placeShotOnTimeline(p, timeline, b.shotId!, video("vb", 4));
  timeline = rb.timeline;
  p = linkShotClip(p, b.shotId!, rb.clipId!);
  p = updateScene(p, s.sceneId, {
    dialogue: [
      { id: "l1", speaker: "narrator", text: "one", direction: "", takes: [], status: "draft" },
      { id: "l2", speaker: "narrator", text: "two", direction: "", takes: [], status: "draft", shotId: b.shotId! },
      { id: "l3", speaker: "narrator", text: "three", direction: "", takes: [], status: "draft" },
    ],
  });
  return { p, timeline, fps: timeline.fps };
}

describe("dialogue placement", () => {
  test("no placed shots → a clear refusal", () => {
    const s = addScene(emptyProduction(), {});
    const p = updateScene(s.production, s.sceneId, { dialogue: [{ id: "l1", speaker: "narrator", text: "x", direction: "", takes: [], status: "draft" }] });
    expect(resolveLinePlacement(p, defaultTimeline(), "l1")).toMatchObject({ ok: false, message: expect.stringContaining("Place this scene's shots") });
  });

  test("a line starts at its own shot, else the scene's first shot, after the previous placed line", () => {
    let { p, timeline, fps } = sceneWithTwoPlacedShots();
    expect(resolveLinePlacement(p, timeline, "l1")).toEqual({ ok: true, atFrame: 0 });
    expect(resolveLinePlacement(p, timeline, "l2")).toEqual({ ok: true, atFrame: 4 * fps });
    const store = new EditorStore(timeline);
    let clip: string | null = null;
    const r = placeLineCommand(p, store.getSnapshot().timeline, "l1", audio("t1", 1.5), (id) => (clip = id));
    if (!r.ok) throw new Error(r.message);
    store.dispatch(r.command);
    p = linkLineClip(p, "l1", clip!);
    expect(resolveLinePlacement(p, store.getSnapshot().timeline, "l3")).toEqual({ ok: true, atFrame: Math.round(1.5 * fps) });
  });

  test("placing dialogue never moves picture clips and is one undo step", () => {
    const { p, timeline } = sceneWithTwoPlacedShots();
    const store = new EditorStore(timeline);
    const before = store.getSnapshot().timeline;
    let clip: string | null = null;
    const r = placeLineCommand(p, before, "l2", audio("t2", 2), (id) => (clip = id));
    if (!r.ok) throw new Error(r.message);
    store.dispatch(r.command);
    const after = store.getSnapshot().timeline;
    const loc = findClip(after, clip!)!;
    expect(after.tracks[loc.trackIndex]!.type).toBe("audio");
    const videoBefore = before.tracks.filter((t) => t.type === "video");
    expect(after.tracks.filter((t) => t.type === "video")).toEqual(videoBefore);
    store.undo();
    expect(findClip(store.getSnapshot().timeline, clip!)).toBeNull();
  });
});
