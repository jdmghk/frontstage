// Cross-dissolve between two adjacent clips on one video track, built from the existing fade:
// the incoming clip moves to a track above (index 0 draws on top), overlaps the outgoing clip by
// `frames`, and fades in over it. No other clip moves, so dialogue and music stay in sync.
//
// The overlap needs spare footage: preferably the outgoing clip's unused tail (it extends under the
// incoming clip), otherwise the incoming clip's unused head (it starts earlier, with its linked
// clips). Stills always have spare frames. With no spare footage the command is refused.

import type { Command } from "./editor-store.js";
import type { Clip } from "../clip.js";
import { findClip, type Timeline, type Track } from "../timeline.js";

export type DissolvePlan =
  | { ok: true; mode: "outgoing-tail" | "incoming-head"; frames: number }
  | { ok: false; message: string };

const isStill = (c: Clip) => c.mediaType === "image";
const hasKeyframes = (c: Clip) => !!(c.opacityTrack || c.positionTrack || c.scaleTrack || c.rotationTrack || c.cropTrack || c.volumeTrack);

function outgoingOf(timeline: Timeline, incomingId: string): { track: Track; trackIndex: number; a: Clip; b: Clip } | null {
  const loc = findClip(timeline, incomingId);
  if (!loc) return null;
  const track = timeline.tracks[loc.trackIndex]!;
  const b = track.clips[loc.clipIndex]!;
  const a = track.clips.find((c) => c.id !== b.id && c.startFrame + c.durationFrames === b.startFrame);
  return a ? { track, trackIndex: loc.trackIndex, a, b } : null;
}

export function planCrossDissolve(timeline: Timeline, incomingClipId: string, frames: number): DissolvePlan {
  const found = outgoingOf(timeline, incomingClipId);
  if (!found) return { ok: false, message: "Select a clip that directly follows another clip on the same track." };
  const { track, a, b } = found;
  if (track.type !== "video") return { ok: false, message: "Cross-dissolves work between video clips." };
  if (a.speed !== 1 || b.speed !== 1) return { ok: false, message: "Reset clip speed to 100% before adding a dissolve." };
  const d = Math.round(frames);
  if (d < 1) return { ok: false, message: "The dissolve needs at least one frame." };
  if (d > Math.floor(Math.min(a.durationFrames, b.durationFrames) / 2)) return { ok: false, message: "The dissolve is longer than half of one of the clips." };
  if (isStill(a) || a.trimEndFrame >= d) return { ok: true, mode: "outgoing-tail", frames: d };
  if ((isStill(b) || b.trimStartFrame >= d) && !hasKeyframes(b)) return { ok: true, mode: "incoming-head", frames: d };
  return {
    ok: false,
    message: `Neither clip has ${d} spare frames: trim the end of the first clip or the start of the second by that much, then try again.`,
  };
}

function overlaps(track: Track, start: number, end: number, ignore: Set<string>): boolean {
  return track.clips.some((c) => !ignore.has(c.id) && c.startFrame < end && start < c.startFrame + c.durationFrames);
}

export function crossDissolveCommand(incomingClipId: string, frames: number, newId: () => string = () => crypto.randomUUID()): Command {
  return {
    label: "Cross Dissolve",
    apply(timeline: Timeline): Timeline {
      const plan = planCrossDissolve(timeline, incomingClipId, frames);
      if (!plan.ok) return timeline;
      const { trackIndex, a, b } = outgoingOf(timeline, incomingClipId)!;
      const d = plan.frames;

      const headShift = (c: Clip): Clip => ({
        ...c,
        startFrame: c.startFrame - d,
        durationFrames: c.durationFrames + d,
        trimStartFrame: isStill(c) ? c.trimStartFrame : Math.max(0, c.trimStartFrame - d),
      });
      const newB: Clip = { ...(plan.mode === "incoming-head" ? headShift(b) : b), fadeInFrames: d };
      const newA: Clip =
        plan.mode === "outgoing-tail"
          ? { ...a, durationFrames: a.durationFrames + d, trimEndFrame: isStill(a) ? a.trimEndFrame : a.trimEndFrame - d }
          : a;

      // Remove B from its track and apply A's change.
      let tracks = timeline.tracks.map((t, i) =>
        i === trackIndex ? { ...t, clips: t.clips.filter((c) => c.id !== b.id).map((c) => (c.id === a.id ? newA : c)) } : t,
      );
      // Incoming-head mode: linked clips (separate audio) start earlier with it to stay in sync.
      if (plan.mode === "incoming-head" && b.linkGroupId) {
        tracks = tracks.map((t) => ({
          ...t,
          clips: t.clips.map((c) => (c.id !== b.id && c.linkGroupId === b.linkGroupId && c.trimStartFrame >= d ? headShift(c) : c)),
        }));
      }

      // Nearest video track above A that is free over B's new span, else a new one right above A.
      const start = newB.startFrame;
      const end = newB.startFrame + newB.durationFrames;
      let target = -1;
      for (let i = trackIndex - 1; i >= 0; i--) {
        const t = tracks[i]!;
        if (t.type === "video" && !overlaps(t, start, end, new Set([b.id]))) {
          target = i;
          break;
        }
      }
      if (target === -1) {
        const fresh: Track = { id: newId(), type: "video", muted: false, hidden: false, syncLocked: false, clips: [] };
        tracks = [...tracks.slice(0, trackIndex), fresh, ...tracks.slice(trackIndex)];
        target = trackIndex;
      }
      tracks = tracks.map((t, i) => (i === target ? { ...t, clips: [...t.clips, newB].sort((x, y) => x.startFrame - y.startFrame) } : t));
      return { ...timeline, tracks };
    },
  };
}
