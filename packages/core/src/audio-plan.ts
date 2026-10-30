import type { Timeline } from "./timeline.js";
import { clipContains, volumeAt } from "./clip.js";

export interface AudioClipGain {
  clipId: string;
  mediaRef: string;
  gain: number;
  startFrame: number;
  trimStartFrame: number;
  speed: number;
}

export interface AudioPlan {
  clips: AudioClipGain[];
}

/** dB → linear amplitude. */
export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

export function buildAudioPlan(timeline: Timeline, frame: number): AudioPlan {
  const clips: AudioClipGain[] = [];
  for (const track of timeline.tracks) {
    if (track.hidden) continue;
    const trackGain = track.gainDb ? dbToGain(track.gainDb) : 1;
    for (const clip of track.clips) {
      if (clip.mediaType !== "audio" && clip.mediaType !== "video") continue;
      if (!clipContains(clip, frame)) continue;
      clips.push({
        clipId: clip.id,
        mediaRef: clip.mediaRef,
        gain: volumeAt(clip, frame) * trackGain,
        startFrame: clip.startFrame,
        trimStartFrame: clip.trimStartFrame,
        speed: clip.speed,
      });
    }
  }
  return { clips };
}
