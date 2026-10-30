import type { ClaudeGateway, ClaudeStudioRequest, ClaudeStudioResult } from "@frontstage/ai";
import type { FlowExport } from "@frontstage/ui";

// window.desktopStudio (preload) → main's claude:run / studio:writeFlowPack. The Anthropic key stays in main.
interface DesktopStudioIpc {
  claudeRun(req: ClaudeStudioRequest): Promise<ClaudeStudioResult>;
  writeFlowPack(pack: {
    folderName: string;
    files: { name: string; text: string }[];
    images: { name: string; bytes: ArrayBuffer }[];
  }): Promise<{ path: string } | { canceled: true } | { error: string }>;
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
