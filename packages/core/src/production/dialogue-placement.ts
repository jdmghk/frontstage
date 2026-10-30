// Approved dialogue goes onto an audio track over the picture (never rippling it): a line starts at
// its shot's clip, or at the scene's first placed shot, and after the previous placed line of the
// same scene so lines don't talk over each other.

import type { Command } from "../editor/editor-store.js";
import { addClipCommand, resolveOrCreateAudioTrack } from "../editor/timeline-commands.js";
import type { MediaManifestEntry } from "../media.js";
import { findClip, type Timeline } from "../timeline.js";
import type { Production } from "./production.js";
import { findLine } from "./voice.js";

function clipSpan(timeline: Timeline, clipId: string | undefined): { start: number; end: number } | null {
  if (!clipId) return null;
  const loc = findClip(timeline, clipId);
  if (!loc) return null;
  const c = timeline.tracks[loc.trackIndex]!.clips[loc.clipIndex]!;
  return { start: c.startFrame, end: c.startFrame + c.durationFrames };
}

export type LinePlacement = { ok: true; atFrame: number } | { ok: false; message: string };

export function resolveLinePlacement(p: Production, timeline: Timeline, lineId: string): LinePlacement {
  const found = findLine(p, lineId);
  if (!found) return { ok: false, message: "This line no longer exists." };
  const { scene, line, index } = found;
  const ownShot = line.shotId ? scene.shots.find((s) => s.id === line.shotId) : undefined;
  const anchor =
    clipSpan(timeline, ownShot?.timelineClipId) ??
    scene.shots.map((s) => clipSpan(timeline, s.timelineClipId)).find((s) => s !== null) ??
    null;
  if (!anchor) return { ok: false, message: "Place this scene's shots on the timeline first; dialogue lines up with them." };
  let atFrame = anchor.start;
  for (let i = index - 1; i >= 0; i--) {
    const prev = clipSpan(timeline, scene.dialogue[i]!.timelineClipId);
    if (prev) {
      atFrame = Math.max(atFrame, prev.end);
      break;
    }
  }
  return { ok: true, atFrame };
}

/** Adds the approved take on a free (or new) audio track as one undo step; reports the clip id. */
export function placeLineCommand(
  p: Production,
  timeline: Timeline,
  lineId: string,
  entry: MediaManifestEntry,
  onPlaced: (clipId: string | null) => void,
  newId: () => string = () => crypto.randomUUID(),
): { ok: true; command: Command } | { ok: false; message: string } {
  const placement = resolveLinePlacement(p, timeline, lineId);
  if (!placement.ok) return placement;
  return {
    ok: true,
    command: {
      label: "Place Dialogue",
      apply(t) {
        const frames = Math.max(1, Math.round(entry.duration * t.fps));
        const { timeline: withTrack, trackIndex } = resolveOrCreateAudioTrack(t, placement.atFrame, frames, newId);
        const next = addClipCommand(entry, { kind: "existing", index: trackIndex }, placement.atFrame, t.fps, undefined, newId, frames).apply(withTrack);
        const placed = next.tracks[trackIndex]?.clips.find((c) => c.startFrame === placement.atFrame && c.mediaRef === entry.id);
        onPlaced(placed?.id ?? null);
        return next;
      },
    },
  };
}
