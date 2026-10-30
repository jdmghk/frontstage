import { applySwapClipMedia, planSwapClipMedia } from "../clip-media-swap.js";
import type { Command } from "../editor/editor-store.js";
import { rippleInsertClipsSpecs } from "../editor/ripple-commands.js";
import type { MediaManifestEntry } from "../media.js";
import { findClip, type Timeline, type Track } from "../timeline.js";
import { shotsInOrder, type Production } from "./production.js";

export interface ShotPlacement {
  trackIndex: number;
  atFrame: number;
  /** A video track must be created at index 0 before inserting. */
  createTrack: boolean;
}

function clipEnd(timeline: Timeline, clipId: string): { trackIndex: number; start: number; end: number } | null {
  const loc = findClip(timeline, clipId);
  if (!loc) return null;
  const clip = timeline.tracks[loc.trackIndex]!.clips[loc.clipIndex]!;
  return { trackIndex: loc.trackIndex, start: clip.startFrame, end: clip.startFrame + clip.durationFrames };
}

/**
 * Where an unplaced shot belongs: right after the nearest earlier placed shot, else right before
 * the nearest later one, else at the end of the first video track. Links to clips the user has
 * since deleted are ignored.
 */
export function resolveShotPlacement(p: Production, timeline: Timeline, shotId: string): ShotPlacement {
  const shots = shotsInOrder(p);
  const idx = shots.findIndex((s) => s.id === shotId);
  for (let i = idx - 1; i >= 0; i--) {
    const id = shots[i]!.timelineClipId;
    const loc = id ? clipEnd(timeline, id) : null;
    if (loc) return { trackIndex: loc.trackIndex, atFrame: loc.end, createTrack: false };
  }
  for (let i = idx + 1; i < shots.length; i++) {
    const id = shots[i]!.timelineClipId;
    const loc = id ? clipEnd(timeline, id) : null;
    if (loc) return { trackIndex: loc.trackIndex, atFrame: loc.start, createTrack: false };
  }
  const videoIdx = timeline.tracks.findIndex((t) => t.type === "video");
  if (videoIdx === -1) return { trackIndex: 0, atFrame: 0, createTrack: true };
  const clips = timeline.tracks[videoIdx]!.clips;
  const end = clips.reduce((m, c) => Math.max(m, c.startFrame + c.durationFrames), 0);
  return { trackIndex: videoIdx, atFrame: end, createTrack: false };
}

/** True when the shot's linked clip still exists on this timeline. */
export function isShotPlaced(timeline: Timeline, timelineClipId: string | undefined): boolean {
  return timelineClipId !== undefined && findClip(timeline, timelineClipId) !== null;
}

export interface PlaceShotResult {
  timeline: Timeline;
  clipId: string | null;
}

/** Ripple-inserts the take at the shot's story position so later shots move right, not get overwritten. */
export function placeShotOnTimeline(
  p: Production,
  timeline: Timeline,
  shotId: string,
  entry: MediaManifestEntry,
  newId: () => string = () => crypto.randomUUID(),
): PlaceShotResult {
  const placement = resolveShotPlacement(p, timeline, shotId);
  let base = timeline;
  if (placement.createTrack) {
    const track: Track = { id: newId(), type: "video", muted: false, hidden: false, syncLocked: false, clips: [] };
    base = { ...timeline, tracks: [track, ...timeline.tracks] };
  }
  const durationFrames = Math.max(1, Math.round(entry.duration * timeline.fps));
  const { timeline: next } = rippleInsertClipsSpecs(
    base, [{ entry, durationFrames }], placement.trackIndex, placement.atFrame, timeline.fps, newId,
  );
  if (next === base) return { timeline, clipId: null };
  const placed = next.tracks[placement.trackIndex]!.clips.find(
    (c) => c.startFrame === placement.atFrame && c.mediaRef === entry.id,
  );
  return { timeline: next, clipId: placed?.id ?? null };
}

/** The placed clip id is reported through `onPlaced` once the command has run. */
export function placeShotCommand(
  p: Production,
  shotId: string,
  entry: MediaManifestEntry,
  onPlaced: (clipId: string | null) => void,
): Command {
  return {
    label: "Place Shot",
    apply(timeline) {
      const r = placeShotOnTimeline(p, timeline, shotId, entry);
      onPlaced(r.clipId);
      return r.timeline;
    },
  };
}

export type ReplaceShotOutcome = { ok: true; command: Command } | { ok: false; message: string };

/**
 * Swaps only the shot's clip (and its linked audio) to a new take, keeping timing, effects and
 * keyframes. Every other clip is untouched.
 */
export function replaceShotClip(timeline: Timeline, clipId: string, entry: MediaManifestEntry): ReplaceShotOutcome {
  const result = planSwapClipMedia(timeline, clipId, entry);
  if (!result.ok) return result;
  return {
    ok: true,
    command: {
      label: "Replace Shot",
      apply(t) {
        const fresh = planSwapClipMedia(t, clipId, entry);
        return fresh.ok ? applySwapClipMedia(t, fresh.plan) : t;
      },
    },
  };
}
