import type { MediaManifestEntry, Timeline } from "@frontstage/core";

export type ExportPresetId = "timeline" | "youtube-1080p" | "youtube-4k";

export interface ExportPreset {
  id: ExportPresetId;
  label: string;
  width: number;
  height: number;
  /** YouTube presets use high-quality H.264 + AAC with faststart. */
  youtube: boolean;
  enabled: boolean;
  /** Why it's disabled, or a caution (sources smaller than the output). */
  note?: string;
}

/** What the export picker needs to know about the timeline. */
export interface ExportInfo {
  width: number;
  height: number;
  /** Tallest video/image source used on the timeline, if known. */
  maxSourceHeight?: number;
}

export function exportInfo(timeline: Timeline, entries: MediaManifestEntry[]): ExportInfo {
  const used = new Set(timeline.tracks.flatMap((t) => t.clips.map((c) => c.mediaRef)));
  const heights = entries.filter((e) => used.has(e.id) && (e.type === "video" || e.type === "image") && e.sourceHeight).map((e) => e.sourceHeight!);
  return { width: timeline.width, height: timeline.height, maxSourceHeight: heights.length ? Math.max(...heights) : undefined };
}

const is16x9 = (w: number, h: number) => Math.abs(w / h - 16 / 9) < 0.01;

export function exportPresets(info: ExportInfo): ExportPreset[] {
  const yt = (id: ExportPresetId, label: string, width: number, height: number): ExportPreset => {
    if (!is16x9(info.width, info.height)) {
      return { id, label, width, height, youtube: true, enabled: false, note: `The timeline is ${info.width}×${info.height}; YouTube presets need a 16:9 timeline.` };
    }
    const small = info.maxSourceHeight !== undefined && info.maxSourceHeight < height;
    return {
      id,
      label,
      width,
      height,
      youtube: true,
      enabled: true,
      note: small ? `Your sources are at most ${info.maxSourceHeight}p, so this upscales them; it won't add detail.` : undefined,
    };
  };
  return [
    { id: "timeline", label: `Timeline size (${info.width}×${info.height})`, width: info.width, height: info.height, youtube: false, enabled: true },
    yt("youtube-1080p", "YouTube 1080p (1920×1080)", 1920, 1080),
    yt("youtube-4k", "YouTube 4K (3840×2160)", 3840, 2160),
  ];
}
