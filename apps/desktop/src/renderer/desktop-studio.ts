import type { ClaudeGateway, ClaudeStudioRequest, ClaudeStudioResult, SampledFrame } from "@frontstage/ai";
import type { FlowExport, FrameSampler } from "@frontstage/ui";

// window.desktopStudio (preload) → main's claude:run / studio:writeFlowPack. The Anthropic key stays in main.
interface DesktopStudioIpc {
  claudeRun(req: ClaudeStudioRequest): Promise<ClaudeStudioResult>;
  writeFlowPack(pack: {
    folderName: string;
    files: { name: string; text: string }[];
    images: { name: string; bytes: ArrayBuffer }[];
  }): Promise<{ path: string } | { canceled: true } | { error: string }>;
  sampleFrames(req: { path: string; fps: number; width: number; maxFrames: number }): Promise<{ frames: { timeSec: number; base64: string }[] } | { error: string }>;
}

declare global {
  interface Window {
    desktopStudio: DesktopStudioIpc;
  }
}

export const desktopClaudeGateway: ClaudeGateway = {
  run: (req) => window.desktopStudio.claudeRun(req),
  hasKey: () => window.desktopAI.hasKey("anthropic"),
};

export const desktopFlowExport: FlowExport = (pack, images) =>
  window.desktopStudio.writeFlowPack({
    folderName: pack.folderName,
    files: pack.files,
    images: images.map((i) => ({ name: i.name, bytes: i.bytes.buffer.slice(i.bytes.byteOffset, i.bytes.byteOffset + i.bytes.byteLength) as ArrayBuffer })),
  });

/** Choreography frames via main's bundled ffmpeg; `resolvePath` maps a media id to its file on disk. */
export function makeDesktopFrameSampler(resolvePath: (mediaId: string) => string | null): FrameSampler {
  return async (mediaId, fps, maxFrames) => {
    const path = resolvePath(mediaId);
    if (!path) return { error: "Save the project first so the reference video is on disk." };
    const r = await window.desktopStudio.sampleFrames({ path, fps, width: 768, maxFrames });
    if ("error" in r) return r;
    return { frames: r.frames.map((f): SampledFrame => ({ timeSec: f.timeSec, mediaType: "image/jpeg", base64: f.base64 })) };
  };
}
