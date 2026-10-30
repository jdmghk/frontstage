import type { Timeline, TimelineResolver } from "@frontstage/core";
import type { MediaByteSource } from "@frontstage/engine";
import type { ExportInfo, ExportPresetId } from "./export-presets.js";

export interface ExportTarget {
  readonly label: string;
}

export type ExportProgressFn = (completed: number, total: number) => void;

export interface ExportRunOptions {
  resolveTimeline?: TimelineResolver;
}

export interface ExportGateway {
  // `info` lets a host offer size presets (timeline / YouTube 1080p / 4K); hosts may ignore it.
  // `presetId` is the in-app picker's choice when `choosesPresetInApp` is set.
  pickTarget(suggestedName: string, info?: ExportInfo, presetId?: ExportPresetId): Promise<ExportTarget | null>;
  /** True when the host has no native preset dialog and wants the editor's in-app picker. */
  readonly choosesPresetInApp?: boolean;
  run(
    timeline: Timeline,
    media: MediaByteSource,
    target: ExportTarget,
    onProgress: ExportProgressFn,
    opts?: ExportRunOptions,
  ): Promise<void>;
}
