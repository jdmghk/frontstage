// Google Flow has no public API, so a shot goes to Flow as a hand-off folder the user drags into
// Flow by hand: the prompt, up to three reference images (Flow's "ingredients" limit), and a
// shot sheet. The result comes back through the shot's "Import take…" with source Google Flow.

import type { Production, Scene, Shot } from "@frontstage/core";
import { shotReferenceMediaIds } from "@frontstage/core";
import { shotPrompt } from "../generation/morphic-studio.js";

export const FLOW_MAX_REFERENCES = 3;

export interface FlowPack {
  /** Folder name, e.g. "02-03 Rooftop duel - Spinning kick". */
  folderName: string;
  /** Text files written into the folder. */
  files: { name: string; text: string }[];
  /** Library media ids to copy in as ref-1, ref-2, … keeping each file's extension (designs first). */
  referenceIds: string[];
}

const safe = (s: string) => s.replace(/[\\/:*?"<>|\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
const pad = (n: number) => String(n + 1).padStart(2, "0");

export function buildFlowPack(p: Production, scene: Scene, shot: Shot, imageIds: ReadonlySet<string>): FlowPack {
  const si = p.scenes.findIndex((s) => s.id === scene.id);
  const shi = scene.shots.findIndex((s) => s.id === shot.id);
  const prompt = shotPrompt(p, scene, shot);
  const referenceIds = shotReferenceMediaIds(p, shot).filter((id) => imageIds.has(id)).slice(0, FLOW_MAX_REFERENCES);
  const cast = p.characters.filter((c) => shot.characterIds.includes(c.id));
  const sheet = [
    `# ${scene.title || `Scene ${si + 1}`}, ${shot.title || `Shot ${shi + 1}`}`,
    "",
    `- Duration: ${shot.durationSec} s`,
    shot.camera && `- Camera: ${shot.camera}`,
    shot.framing && `- Framing: ${shot.framing}`,
    `- Aspect ratio: 16:9`,
    cast.length ? `- Characters: ${cast.map((c) => c.name).join(", ")}` : "",
    "",
    "## In Google Flow",
    "",
    "1. Start a new clip and paste prompt.txt as the prompt.",
    referenceIds.length
      ? `2. Add the images ${referenceIds.map((_, i) => `ref-${i + 1}`).join(", ")} as ingredients (character designs come first).`
      : "2. No reference images: this shot's cast has no designs or references yet.",
    `3. Generate, pick the best clip and download it.`,
    `4. In Frontstage, open this shot, set the source to "Google Flow (manual)" and use Import take….`,
    "",
    scene.continuityNotes && `## Continuity\n\n${scene.continuityNotes}`,
    shot.notes && `## Notes\n\n${shot.notes}`,
  ]
    .filter((l): l is string => typeof l === "string")
    .join("\n");
  return {
    folderName: `${pad(si)}-${pad(shi)} ${safe(scene.title || "Scene")} - ${safe(shot.title || "Shot")}`,
    files: [
      { name: "prompt.txt", text: prompt + "\n" },
      { name: "shot.md", text: sheet.replace(/\n{3,}/g, "\n\n") + "\n" },
    ],
    referenceIds,
  };
}
