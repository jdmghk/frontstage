import { useState } from "react";
import { theme } from "../theme/theme.js";
import { Button } from "../primitives/index.js";
import type { ExportPreset, ExportPresetId } from "./export-presets.js";

/** In-app export size picker for hosts without a native dialog (the web editor). */
export function ExportPresetDialog({ presets, onChoose }: { presets: ExportPreset[]; onChoose: (id: ExportPresetId | null) => void }) {
  const [selected, setSelected] = useState<ExportPresetId>(presets.find((p) => p.enabled)?.id ?? "timeline");
  return (
    <div
      data-testid="export-preset-dialog"
      style={{ position: "fixed", inset: 0, background: theme.bg.scrim, display: "flex", alignItems: "center", justifyContent: "center", zIndex: theme.z.dialog }}
    >
      <div style={{ background: theme.bg.raised, border: `${theme.borderWidth.thin} solid ${theme.border.primary}`, borderRadius: theme.radius.md, padding: theme.spacing.lg, width: 420, display: "flex", flexDirection: "column", gap: theme.spacing.sm }}>
        <div style={{ fontSize: theme.fontSize.md, fontWeight: theme.fontWeight.medium, color: theme.text.primary }}>Export size</div>
        {presets.map((p) => (
          <label key={p.id} style={{ display: "flex", gap: theme.spacing.sm, alignItems: "flex-start", opacity: p.enabled ? 1 : 0.5, cursor: p.enabled ? "pointer" : "default" }}>
            <input type="radio" name="export-preset" checked={selected === p.id} disabled={!p.enabled} onChange={() => setSelected(p.id)} data-testid={`export-preset-${p.id}`} />
            <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ fontSize: theme.fontSize.sm, color: theme.text.primary }}>{p.label}</span>
              {p.note && <span style={{ fontSize: theme.fontSize.xs, color: theme.text.secondary }}>{p.note}</span>}
            </span>
          </label>
        ))}
        <div style={{ fontSize: theme.fontSize.xs, color: theme.text.tertiary }}>YouTube presets use H.264 High at a YouTube-class bitrate with 320 kbps audio.</div>
        <div style={{ display: "flex", gap: theme.spacing.sm, justifyContent: "flex-end" }}>
          <Button onClick={() => onChoose(null)} testid="export-preset-cancel">
            Cancel
          </Button>
          <Button variant="accent" onClick={() => onChoose(selected)} testid="export-preset-continue">
            Continue
          </Button>
        </div>
      </div>
    </div>
  );
}
