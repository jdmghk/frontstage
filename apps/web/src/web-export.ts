import type { ExportGateway, ExportInfo, ExportPresetId, ExportTarget, ExportProgressFn, ExportRunOptions } from "@frontstage/ui";
import { exportPresets } from "@frontstage/ui";
import type { Timeline } from "@frontstage/core";
import type { MediaByteSource } from "@frontstage/engine";
import { runExport, WebCodecsMp4Sink } from "@frontstage/engine";

interface WebExportTarget extends ExportTarget {
  handle: FileSystemFileHandle;
  /** Output size and quality from the export size picker; absent = timeline size, standard. */
  width?: number;
  height?: number;
  youtube?: boolean;
}

export interface WebExportGatewayOptions {
  pickSaveFile?: (suggestedName: string) => Promise<FileSystemFileHandle | null>;
}

export class WebExportGateway implements ExportGateway {
  // No native dialog in a browser: the editor shows its in-app size picker.
  readonly choosesPresetInApp = true;
  private readonly opts: WebExportGatewayOptions | undefined;

  constructor(opts?: WebExportGatewayOptions) {
    this.opts = opts;
  }

  async pickTarget(suggestedName: string, info?: ExportInfo, presetId?: ExportPresetId): Promise<ExportTarget | null> {
    const preset = info && presetId ? exportPresets(info).find((p) => p.id === presetId && p.enabled) : undefined;
    try {
      let handle: FileSystemFileHandle | null;
      if (this.opts?.pickSaveFile) {
        handle = await this.opts.pickSaveFile(suggestedName);
      } else {
        handle = await (window as any).showSaveFilePicker({
          suggestedName: suggestedName + ".mp4",
          types: [{ description: "MP4 video", accept: { "video/mp4": [".mp4"] } }],
        });
      }
      if (!handle) return null;
      const target: WebExportTarget = { label: handle.name, handle, width: preset?.width, height: preset?.height, youtube: preset?.youtube };
      return target;
    } catch (e) {
      if ((e as DOMException).name === "AbortError") return null;
      throw e;
    }
  }

  async run(
    timeline: Timeline,
    media: MediaByteSource,
    target: ExportTarget,
    onProgress: ExportProgressFn,
    opts?: ExportRunOptions,
  ): Promise<void> {
    const t = target as WebExportTarget;
    const size = t.width && t.height && (t.width !== timeline.width || t.height !== timeline.height) ? { width: t.width, height: t.height } : {};
    const blob = await runExport(
      timeline,
      media,
      new WebCodecsMp4Sink(t.youtube ? { quality: "youtube" } : undefined),
      onProgress,
      { ...size, ...(opts?.resolveTimeline ? { resolveTimeline: opts.resolveTimeline } : {}) },
    );
    const w = await (target as WebExportTarget).handle.createWritable();
    await w.write(blob!);
    await w.close();
  }
}
