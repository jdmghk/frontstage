import { describe, expect, test } from "vitest";
import { defaultTimeline, type MediaManifestEntry } from "@frontstage/core";
import { exportInfo, exportPresets } from "../src/editor/export-presets.js";

describe("export presets", () => {
  test("16:9 timeline: timeline size plus YouTube 1080p and 4K", () => {
    const ps = exportPresets({ width: 1920, height: 1080, maxSourceHeight: 2160 });
    expect(ps.map((p) => [p.id, p.width, p.height, p.enabled, p.youtube])).toEqual([
      ["timeline", 1920, 1080, true, false],
      ["youtube-1080p", 1920, 1080, true, true],
      ["youtube-4k", 3840, 2160, true, true],
    ]);
    expect(ps.every((p) => !p.note)).toBe(true);
  });

  test("non-16:9 timeline disables YouTube presets with a reason", () => {
    const ps = exportPresets({ width: 1080, height: 1920 });
    expect(ps[1]).toMatchObject({ enabled: false, note: expect.stringContaining("16:9") });
    expect(ps[0]!.enabled).toBe(true);
  });

  test("warns when sources are smaller than the output", () => {
    const ps = exportPresets({ width: 1280, height: 720, maxSourceHeight: 720 });
    expect(ps[1]!.note).toContain("at most 720p");
    expect(ps[2]!.note).toContain("upscales");
  });

  test("exportInfo reads the tallest source actually on the timeline", () => {
    const t = defaultTimeline();
    const withClip = { ...t, tracks: [{ id: "tr", type: "video" as const, muted: false, hidden: false, syncLocked: false, clips: [{ id: "c", mediaRef: "a", startFrame: 0, durationFrames: 10 }] }] };
    const entries = [
      { id: "a", type: "video", sourceHeight: 720 },
      { id: "b", type: "video", sourceHeight: 2160 },
    ] as unknown as MediaManifestEntry[];
    expect(exportInfo(withClip as never, entries)).toEqual({ width: t.width, height: t.height, maxSourceHeight: 720 });
  });
});
