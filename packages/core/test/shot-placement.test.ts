import { describe, expect, test } from "vitest";
import {
  addScene,
  addShot,
  defaultTimeline,
  EditorStore,
  emptyProduction,
  findClip,
  isShotPlaced,
  linkShotClip,
  placeShotCommand,
  placeShotOnTimeline,
  replaceShotClip,
  resolveShotPlacement,
  type MediaManifestEntry,
  type Production,
  type Timeline,
} from "../src/index.js";

function asset(id: string, duration = 2, extra: Partial<MediaManifestEntry> = {}): MediaManifestEntry {
  return {
    id,
    name: id,
    type: "video",
    source: { kind: "project", relativePath: `media/${id}.mp4` },
    duration,
    hasAudio: false,
    ...extra,
  };
}

function threeShots(): { p: Production; ids: string[] } {
  const scene = addScene(emptyProduction(), { title: "S1" });
  let p = scene.production;
  const ids: string[] = [];
  for (const t of ["A", "B", "C"]) {
    const r = addShot(p, scene.sceneId, { title: t });
    p = r.production;
    ids.push(r.shotId!);
  }
  return { p, ids };
}

function clipIds(t: Timeline): string[] {
  return t.tracks.flatMap((tr) => tr.clips.map((c) => c.id));
}

describe("resolveShotPlacement", () => {
  test("empty timeline asks for a new video track at frame 0", () => {
    const { p, ids } = threeShots();
    expect(resolveShotPlacement(p, defaultTimeline(), ids[0]!)).toEqual({ trackIndex: 0, atFrame: 0, createTrack: true });
  });

  test("ignores links to clips the user deleted", () => {
    const { p, ids } = threeShots();
    const linked = linkShotClip(p, ids[0]!, "deleted-clip");
    expect(isShotPlaced(defaultTimeline(), "deleted-clip")).toBe(false);
    expect(resolveShotPlacement(linked, defaultTimeline(), ids[1]!).createTrack).toBe(true);
  });
});

describe("placeShotOnTimeline", () => {
  test("places shots in story order even when placed out of order", () => {
    let { p, ids } = threeShots();
    let t = defaultTimeline();

    const c = placeShotOnTimeline(p, t, ids[2]!, asset("mc", 1));
    t = c.timeline;
    p = linkShotClip(p, ids[2]!, c.clipId!);

    const a = placeShotOnTimeline(p, t, ids[0]!, asset("ma", 2));
    t = a.timeline;
    p = linkShotClip(p, ids[0]!, a.clipId!);

    // B belongs between A and C: it lands at A's end and pushes C right.
    const b = placeShotOnTimeline(p, t, ids[1]!, asset("mb", 3));
    t = b.timeline;

    const track = t.tracks[0]!;
    const order = [...track.clips].sort((x, y) => x.startFrame - y.startFrame).map((c) => c.mediaRef);
    expect(order).toEqual(["ma", "mb", "mc"]);
    const byRef = Object.fromEntries(track.clips.map((cl) => [cl.mediaRef, cl.startFrame]));
    expect(byRef).toEqual({ ma: 0, mb: 60, mc: 150 });
    expect(findClip(t, c.clipId!)).not.toBeNull();
  });

  test("placeShotCommand reports the new clip id and is one undo step", () => {
    const { p, ids } = threeShots();
    const store = new EditorStore(defaultTimeline());
    let placed: string | null = null;
    store.dispatch(placeShotCommand(p, ids[0]!, asset("ma"), (id) => (placed = id)));
    expect(placed).not.toBeNull();
    expect(clipIds(store.getSnapshot().timeline)).toContain(placed);
    store.undo();
    expect(clipIds(store.getSnapshot().timeline)).toEqual([]);
  });
});

describe("replaceShotClip", () => {
  test("swaps only the shot's clip and keeps its timing", () => {
    let { p, ids } = threeShots();
    let t = defaultTimeline();
    const a = placeShotOnTimeline(p, t, ids[0]!, asset("ma", 2));
    t = a.timeline;
    p = linkShotClip(p, ids[0]!, a.clipId!);
    const b = placeShotOnTimeline(p, t, ids[1]!, asset("mb", 2));
    t = b.timeline;

    const r = replaceShotClip(t, a.clipId!, asset("ma-v2", 4));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const next = r.command.apply(t);
    const clips = next.tracks[0]!.clips;
    const swapped = clips.find((c) => c.id === a.clipId)!;
    expect(swapped.mediaRef).toBe("ma-v2");
    expect(swapped.startFrame).toBe(0);
    expect(swapped.durationFrames).toBe(60);
    expect(clips.find((c) => c.id === b.clipId)).toEqual(t.tracks[0]!.clips.find((c) => c.id === b.clipId));
  });

  test("a take shorter than the cut is refused with a message, not silently trimmed", () => {
    const { p, ids } = threeShots();
    const a = placeShotOnTimeline(p, defaultTimeline(), ids[0]!, asset("ma", 4));
    const r = replaceShotClip(a.timeline, a.clipId!, asset("short", 1));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/too short/);
  });
});
