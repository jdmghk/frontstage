import type { Timeline, TimelineResolver } from "@frontstage/core";
import type { MediaByteSource } from "@frontstage/engine";
import type { ExportInfo } from "./export-presets.js";

export interface ExportTarget {
  readonly label: string;
}

export type ExportProgressFn = (completed: number, total: number) => void;

export interface ExportRunOptions {
  resolveTimeline?: TimelineResolver;
}

export interface ExportGateway {
  // `info` lets a host offer size presets (timeline / YouTube 1080p / 4K); hosts may ignore it.
  pickTarget(suggestedName: string, info?: ExportInfo): Promise<ExportTarget | null>;
  run(
    timeline: Timeline,
    media: MediaByteSource,
    target: ExportTarget,
    onProgress: ExportProgressFn,
    opts?: ExportRunOptions,
  ): Promise<void>;
}
