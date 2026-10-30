// Fight choreography planned from a reference video the user owns or may use. The reference is
// *analyzed* into a shot-by-shot plan (positions, action, camera, impact timing); no motion is
// transferred. Approving a plan turns its shots into ordinary scene shots.

import { z } from "zod";
import { addShot, type Production } from "./production.js";

const uuid = () => crypto.randomUUID();

export const ChoreoShotSchema = z.object({
  id: z.string().default(uuid),
  durationSec: z.number().positive().default(3),
  /** Character names as written by the analysis / the user; matched to the cast on approval. */
  characters: z.array(z.string()).default([]),
  startPositions: z.string().default(""),
  action: z.string().default(""),
  camera: z.string().default(""),
  framing: z.string().default(""),
  transitions: z.string().default(""),
  /** Seconds from the start of this shot where hits land. */
  impactTimesSec: z.array(z.number().min(0)).default([]),
  continuity: z.string().default(""),
  prompt: z.string().default(""),
});

export const ChoreographySchema = z.object({
  id: z.string().default(uuid),
  title: z.string().default(""),
  referenceMediaId: z.string(),
  permission: z.object({ attested: z.literal(true), note: z.string().default(""), date: z.string() }),
  /** What to look for, and who is who ("fighter in red = Kai"). Sent with the analysis. */
  notes: z.string().default(""),
  shots: z.array(ChoreoShotSchema).default([]),
  state: z.enum(["draft", "approved"]).default("draft"),
  /** The scene its shots were added to, once approved. */
  sceneId: z.string().optional(),
});

export type ChoreoShot = z.infer<typeof ChoreoShotSchema>;
export type Choreography = z.infer<typeof ChoreographySchema>;

export function addChoreography(
  p: Production,
  init: { title: string; referenceMediaId: string; permission: { attested: boolean; note?: string } },
  now: () => string = () => new Date().toISOString(),
): { production: Production; choreographyId: string } | { error: string } {
  if (!init.permission.attested) return { error: "Confirm you own this video or have permission to use it as a reference." };
  const c = ChoreographySchema.parse({
    title: init.title,
    referenceMediaId: init.referenceMediaId,
    permission: { attested: true, note: init.permission.note ?? "", date: now() },
  });
  return { production: { ...p, choreographies: [...p.choreographies, c] }, choreographyId: c.id };
}

function replaceChoreo(p: Production, id: string, fn: (c: Choreography) => Choreography): Production {
  const i = p.choreographies.findIndex((c) => c.id === id);
  if (i === -1) return p;
  const choreographies = [...p.choreographies];
  choreographies[i] = fn(choreographies[i]!);
  return { ...p, choreographies };
}

export function updateChoreography(p: Production, id: string, patch: Partial<Pick<Choreography, "title" | "notes">>): Production {
  return replaceChoreo(p, id, (c) => ({ ...c, ...patch }));
}

/** Any edit to the plan returns it to draft. */
export function setChoreoShots(p: Production, id: string, shots: Partial<ChoreoShot>[]): Production {
  return replaceChoreo(p, id, (c) => ({ ...c, shots: shots.map((s) => ChoreoShotSchema.parse(s)), state: "draft" }));
}

export function updateChoreoShot(p: Production, id: string, shotId: string, patch: Partial<Omit<ChoreoShot, "id">>): Production {
  return replaceChoreo(p, id, (c) => ({ ...c, state: "draft", shots: c.shots.map((s) => (s.id === shotId ? { ...s, ...patch } : s)) }));
}

export function removeChoreography(p: Production, id: string): Production {
  return { ...p, choreographies: p.choreographies.filter((c) => c.id !== id) };
}

/** Shot description text: action, starting positions, transitions and hit timing in one place. */
export function choreoShotDescription(s: ChoreoShot): string {
  return [
    s.action,
    s.startPositions && `Start: ${s.startPositions}`,
    s.transitions && `Into next: ${s.transitions}`,
    s.impactTimesSec.length ? `Impacts at ${s.impactTimesSec.map((t) => `${t}s`).join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Approves the plan and appends its shots to the scene, in order, as draft shots (nothing existing
 * is changed). Names are matched to the cast case-insensitively; unmatched names stay in the text.
 */
export function approveChoreographyToScene(p: Production, id: string, sceneId: string): { production: Production; added: number } | { error: string } {
  const c = p.choreographies.find((x) => x.id === id);
  if (!c) return { error: "This choreography no longer exists." };
  if (c.shots.length === 0) return { error: "Analyze the reference or add shots first." };
  if (!p.scenes.some((s) => s.id === sceneId)) return { error: "Choose a scene." };
  let next = p;
  for (const s of c.shots) {
    const characterIds = s.characters
      .map((n) => p.characters.find((ch) => ch.name.trim().toLowerCase() === n.trim().toLowerCase())?.id)
      .filter((x): x is string => !!x);
    next = addShot(next, sceneId, {
      title: s.action.split(/[.,;]/)[0]!.slice(0, 40) || "Fight beat",
      description: choreoShotDescription(s),
      durationSec: s.durationSec,
      camera: s.camera,
      framing: s.framing,
      characterIds,
      prompt: s.prompt,
      notes: s.continuity,
      motionReferenceMediaId: c.referenceMediaId,
    }).production;
  }
  next = replaceChoreo(next, id, (x) => ({ ...x, state: "approved", sceneId }));
  return { production: next, added: c.shots.length };
}
