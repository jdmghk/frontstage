import { useState } from "react";
import type { ContentState, SceneStatus, ShotStatus } from "@frontstage/core";
import { theme } from "../theme/theme.js";

export function TextArea(props: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
  testid?: string;
  disabled?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <textarea
      data-testid={props.testid}
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      placeholder={props.placeholder}
      disabled={props.disabled}
      rows={props.rows ?? 3}
      style={{
        resize: "vertical",
        width: "100%",
        boxSizing: "border-box",
        background: theme.bg.raised,
        borderWidth: theme.borderWidth.thin,
        borderStyle: "solid",
        borderColor: focused ? theme.accent.primary : theme.border.primary,
        borderRadius: theme.radius.xsSm,
        color: theme.text.primary,
        fontSize: theme.fontSize.sm,
        fontFamily: "inherit",
        padding: `${theme.spacing.xs} ${theme.spacing.sm}`,
        outline: "none",
      }}
    />
  );
}

export function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: theme.fontSize.xs, color: theme.text.tertiary, fontWeight: theme.fontWeight.medium }}>
      {children}
    </div>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: theme.spacing.xxs, minWidth: 0 }}>
      <FieldLabel>{label}</FieldLabel>
      {children}
    </label>
  );
}

const STATUS_LABEL: Record<ShotStatus | SceneStatus, string> = {
  draft: "Draft",
  ready: "Ready",
  generating: "Generating",
  generated: "Generated",
  approved: "Approved",
  "needs-regen": "Needs regen",
  failed: "Failed",
  empty: "No shots",
  "in-progress": "In progress",
  attention: "Needs attention",
  complete: "Complete",
};

function statusColor(status: ShotStatus | SceneStatus): string {
  if (status === "approved" || status === "complete") return theme.status.success;
  if (status === "failed" || status === "needs-regen" || status === "attention") return theme.status.error;
  if (status === "generating" || status === "generated" || status === "in-progress") return theme.accent.primary;
  return theme.text.tertiary;
}

export function StatusChip({ status, testid }: { status: ShotStatus | SceneStatus; testid?: string }) {
  const color = statusColor(status);
  return (
    <span
      data-testid={testid}
      data-status={status}
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: `0 ${theme.spacing.xs}`,
        borderRadius: theme.radius.pill,
        border: `${theme.borderWidth.thin} solid ${color}`,
        color,
        fontSize: theme.fontSize.xxs,
        fontWeight: theme.fontWeight.medium,
        whiteSpace: "nowrap",
        flexShrink: 0,
      }}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

/** Draft/approved toggle for AI-written text: approval is always an explicit user action. */
export function ApprovalToggle({ state, onChange, testid }: { state: ContentState; onChange: (s: ContentState) => void; testid?: string }) {
  const approved = state === "approved";
  return (
    <button
      type="button"
      data-testid={testid}
      aria-pressed={approved}
      onClick={() => onChange(approved ? "draft" : "approved")}
      style={{
        background: "none",
        border: `${theme.borderWidth.thin} solid ${approved ? theme.status.success : theme.border.primary}`,
        borderRadius: theme.radius.pill,
        color: approved ? theme.status.success : theme.text.tertiary,
        fontSize: theme.fontSize.xxs,
        padding: `0 ${theme.spacing.xs}`,
        cursor: "pointer",
      }}
    >
      {approved ? "Approved" : "Draft — click to approve"}
    </button>
  );
}

export const cardStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: theme.spacing.xs,
  padding: theme.spacing.sm,
  background: theme.bg.surface,
  border: `${theme.borderWidth.thin} solid ${theme.border.subtle}`,
  borderRadius: theme.radius.sm,
};

export const rowStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: theme.spacing.xs, minWidth: 0 };

export const scrollColumnStyle: React.CSSProperties = {
  flex: 1,
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: theme.spacing.sm,
  padding: theme.spacing.sm,
  minHeight: 0,
};

export function Thumb({ src, label, selected, testid }: { src?: string; label: string; selected?: boolean; testid?: string }) {
  return (
    <div
      data-testid={testid}
      title={label}
      style={{
        width: theme.size.genRefTileW,
        height: theme.size.genRefTileH,
        flexShrink: 0,
        borderRadius: theme.radius.xs,
        overflow: "hidden",
        background: theme.bg.tileEmpty,
        border: `${theme.borderWidth.medium} solid ${selected ? theme.status.success : "transparent"}`,
        boxSizing: "border-box",
      }}
    >
      {src && <img src={src} alt={label} style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
    </div>
  );
}
