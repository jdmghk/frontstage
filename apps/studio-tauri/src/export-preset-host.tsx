// export:choosePreset. Electron used a native message box with a checkbox; here it's the editor's own
// ExportPresetDialog, mounted on its own root because the gateway asks outside the React tree.

import { createRoot } from "react-dom/client";
import { ExportPresetDialog } from "@frontstage/ui";

type Option = { id: string; label: string; enabled: boolean; note?: string };

const DETAIL = "YouTube presets use H.264 High (CRF 18) with 320 kbps AAC audio.";

export function chooseExportPreset(options: Option[], captions?: boolean): Promise<{ id: string; subtitleTrack: boolean } | null> {
  const list = (options ?? []).filter((o) => o && typeof o.id === "string" && typeof o.label === "string");
  if (!list.some((o) => o.enabled)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    root.render(
      <ExportPresetDialog
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        presets={list as any}
        captions={!!captions}
        detail={DETAIL}
        onChoose={(id, subtitleTrack) => {
          root.unmount();
          host.remove();
          resolve(id ? { id, subtitleTrack: !!captions && subtitleTrack } : null);
        }}
      />,
    );
  });
}
