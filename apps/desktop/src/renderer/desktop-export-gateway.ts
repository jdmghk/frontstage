import { runExport } from "@frontstage/engine";
import type { Timeline } from "@frontstage/core";
import { cuesFromCaptionClips, formatSrt } from "@frontstage/core";
import type { MediaByteSource } from "@frontstage/engine";
import type { ExportGateway, ExportInfo, ExportTarget, ExportProgressFn, ExportRunOptions } from "@frontstage/ui";
import { exportPresets } from "@frontstage/ui";
import { FfmpegIpcSink } from "./ffmpeg-sink.js";

interface DesktopExportTarget extends ExportTarget {
  outPath: string;
  codec: string;
  /** Output size; omitted = the timeline's own size. */
  width?: number;
  height?: number;
  /** Captions go out as a soft subtitle track and are left out of the picture. */
  subtitleTrack?: boolean;
}

export class DesktopExportGateway implements ExportGateway {
  async pickTarget(suggestedName: string, info?: ExportInfo): Promise<ExportTarget | null> {
    // Size preset first (timeline / YouTube 1080p / 4K), then where to save.
    const presets = info ? exportPresets(info) : [];
    let preset = presets[0];
    let subtitleTrack = false;
    if (presets.length > 0) {
      const choice = await window.desktopProject.choosePreset(presets.map(({ id, label, enabled, note }) => ({ id, label, enabled, note })), info?.hasCaptions);
      if (!choice) return null;
      preset = presets.find((p) => p.id === choice.id) ?? presets[0];
      subtitleTrack = choice.subtitleTrack;
    }
    const p = await window.desktopProject.pickExportSave(suggestedName + ".mp4");
    if (!p) return null;
    const mov = p.toLowerCase().endsWith(".mov");
    const codec = mov ? "prores_ks" : preset?.youtube ? "libx264_youtube" : "libx264";
    const label = p.split(/[/\\]/).pop()!;
    const target: DesktopExportTarget = { label, outPath: p, codec, width: preset?.width, height: preset?.height, subtitleTrack };
    return target;
  }

  async run(
    timeline: Timeline,
    media: MediaByteSource,
    target: ExportTarget,
    onProgress: ExportProgressFn,
    opts?: ExportRunOptions,
  ): Promise<void> {
    const t = target as DesktopExportTarget;
    const size = t.width && t.height && (t.width !== timeline.width || t.height !== timeline.height) ? { width: t.width, height: t.height } : {};
    // Subtitle-track export: captions become an SRT track and are left out of the rendered picture.
    const srt = t.subtitleTrack ? formatSrt(cuesFromCaptionClips(timeline, timeline.fps)) : undefined;
    const rendered = srt ? withoutCaptionClips(timeline) : timeline;
    await runExport(
      rendered,
      media,
      new FfmpegIpcSink(window.desktopExport, { codec: t.codec, outPath: t.outPath, subtitlesSrt: srt }),
      onProgress,
      { ...size, ...(opts?.resolveTimeline ? { resolveTimeline: opts.resolveTimeline } : {}) },
    );
  }
}

export function withoutCaptionClips(timeline: Timeline): Timeline {
  return { ...timeline, tracks: timeline.tracks.map((tr) => ({ ...tr, clips: tr.clips.filter((c) => c.captionGroupId === undefined) })) };
}
