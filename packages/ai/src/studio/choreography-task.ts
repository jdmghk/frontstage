// Claude vision over frames sampled from a reference fight video → an editable shot plan. This is
// analysis only: the plan describes the moves for a video generator to attempt; it doesn't carry
// the reference's motion into the generated clips.

import { z } from "zod";
import type { Choreography, Production } from "@frontstage/core";
import { setChoreoShots } from "@frontstage/core";
import { DEFAULT_STUDIO_MODEL, productionContext, type ClaudeStudioRequest, type WriterTask } from "./writer.js";

export interface SampledFrame {
  timeSec: number;
  mediaType: "image/jpeg" | "image/png";
  base64: string;
}

/** At most this many frames per analysis; the sampler spreads them over the clip. */
export const MAX_CHOREO_FRAMES = 20;

/** Frames per second that keeps a clip of `durationSec` within MAX_CHOREO_FRAMES (≤ 4 fps). */
export function choreoSampleFps(durationSec: number): number {
  if (!(durationSec > 0)) return 1;
  return Math.min(4, MAX_CHOREO_FRAMES / durationSec);
}

const str = (description: string) => ({ type: "string", description });
const ShotZ = z.object({
  durationSec: z.number(),
  characters: z.array(z.string()),
  startPositions: z.string(),
  action: z.string(),
  camera: z.string(),
  framing: z.string(),
  transitions: z.string(),
  impactTimesSec: z.array(z.number()),
  continuity: z.string(),
  prompt: z.string(),
});
const PlanZ = z.object({ shots: z.array(ShotZ) });

const SHOT_SCHEMA = {
  type: "object",
  properties: {
    durationSec: { type: "number", description: "Seconds, 1-10" },
    characters: { type: "array", items: str("Character name (use the cast names from the notes)"), description: "Who is in the shot" },
    startPositions: str("Where each fighter stands and faces at the start"),
    action: str("The moves in order, precisely"),
    camera: str("Angle and movement"),
    framing: str("e.g. wide, medium, close-up"),
    transitions: str("How this shot hands off to the next"),
    impactTimesSec: { type: "array", items: { type: "number" }, description: "Seconds from the shot's start where hits land" },
    continuity: str("What must match neighbouring shots: positions, damage, props, lighting"),
    prompt: str("A 60-120 word video-generation prompt for this shot, as choreographed stunt work, no gore"),
  },
  required: ["durationSec", "characters", "startPositions", "action", "camera", "framing", "transitions", "impactTimesSec", "continuity", "prompt"],
  additionalProperties: false,
};

export function choreographyTask(
  p: Production,
  choreo: Choreography,
  frames: SampledFrame[],
  model = DEFAULT_STUDIO_MODEL,
): WriterTask<z.infer<typeof PlanZ>> {
  const used = frames.slice(0, MAX_CHOREO_FRAMES);
  const timeline = used.map((f, i) => `Image ${i + 1}: t=${f.timeSec.toFixed(2)}s`).join("\n");
  const ctx = productionContext(p);
  const request: ClaudeStudioRequest = {
    model,
    system:
      "You are a fight choreographer and director breaking reference footage into shots for AI video generation. Describe stunt choreography precisely and neutrally: stances, moves, distances, timing, camera. Never describe gore.",
    prompt: [
      ctx,
      `The images are ${used.length} frames sampled in order from a reference fight video the user owns or may use.`,
      timeline,
      choreo.notes ? `Notes from the user (who is who, what to focus on):\n${choreo.notes}` : "",
      "Break the action into consecutive shots of 1-10 seconds that together cover the fight. For each shot give the starting positions, the moves, camera and framing, the transition into the next shot, the impact times, continuity requirements, and a standalone generation prompt.",
    ]
      .filter(Boolean)
      .join("\n\n"),
    images: used.map((f) => ({ mediaType: f.mediaType, base64: f.base64 })),
    schema: { type: "object", properties: { shots: { type: "array", items: SHOT_SCHEMA, description: "Shots in order" } }, required: ["shots"], additionalProperties: false },
    effort: "high",
    maxTokens: 24000,
  };
  return {
    request,
    parse(json) {
      const r = PlanZ.safeParse(json);
      if (!r.success) throw new Error(`Claude's reply didn't match the expected shape: ${r.error.issues[0]?.message ?? "invalid"}`);
      return r.data;
    },
    apply: (cur, r) =>
      setChoreoShots(
        cur,
        choreo.id,
        r.shots.map((s) => ({ ...s, durationSec: Math.min(10, Math.max(1, s.durationSec || 3)), impactTimesSec: s.impactTimesSec.filter((t) => t >= 0) })),
      ),
    summary: (r) => `${r.shots.length} shots planned from the reference (draft). Review and edit before approving.`,
  };
}
