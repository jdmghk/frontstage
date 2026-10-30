// Voice profiles and per-line dialogue takes. Same rules as shots: a new take never changes the
// approved take or the timeline; a line reads "generated" only once its media is really there.

import { type DialogueLine, type Production, type Scene, type TakeMediaState, type VoiceProfile, VoiceProfileSchema } from "./production.js";

export type AddVoiceResult = { production: Production; voiceId: string } | { error: string };

/** Creates a voice profile. Refused unless the user attested they own the voice or have permission. */
export function addVoiceProfile(
  p: Production,
  init: { name: string; referenceMediaId: string; language?: VoiceProfile["language"]; expressiveness?: number; consent: { attested: boolean; note?: string } },
  now: () => string = () => new Date().toISOString(),
): AddVoiceResult {
  if (!init.consent.attested) return { error: "Confirm that this is your voice or that you have the speaker's permission." };
  if (!init.name.trim()) return { error: "Give the voice a name." };
  const parsed = VoiceProfileSchema.safeParse({ ...init, name: init.name.trim(), consent: { attested: true, note: init.consent.note ?? "", date: now() } });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid voice profile" };
  return { production: { ...p, voices: [...p.voices, parsed.data] }, voiceId: parsed.data.id };
}

export function updateVoiceProfile(p: Production, voiceId: string, patch: Partial<Pick<VoiceProfile, "name" | "language" | "expressiveness">>): Production {
  const voices = p.voices.map((v) => (v.id === voiceId ? { ...v, ...patch } : v));
  return { ...p, voices };
}

/** Removes a voice and unlinks it from characters and the narrator. Recorded takes are kept. */
export function removeVoiceProfile(p: Production, voiceId: string): Production {
  if (!p.voices.some((v) => v.id === voiceId)) return p;
  return {
    ...p,
    voices: p.voices.filter((v) => v.id !== voiceId),
    narratorVoiceId: p.narratorVoiceId === voiceId ? undefined : p.narratorVoiceId,
    characters: p.characters.map((c) => (c.voiceProfileId === voiceId ? { ...c, voiceProfileId: undefined } : c)),
  };
}

export function setCharacterVoice(p: Production, characterId: string, voiceId: string | undefined): Production {
  return { ...p, characters: p.characters.map((c) => (c.id === characterId ? { ...c, voiceProfileId: voiceId } : c)) };
}

export function setNarratorVoice(p: Production, voiceId: string | undefined): Production {
  return { ...p, narratorVoiceId: voiceId };
}

/** The voice that speaks a line: the narrator's, or the speaking character's. */
export function voiceForLine(p: Production, line: DialogueLine): VoiceProfile | undefined {
  const id = line.speaker === "narrator" ? p.narratorVoiceId : p.characters.find((c) => c.id === line.speaker)?.voiceProfileId;
  return id ? p.voices.find((v) => v.id === id) : undefined;
}

export function speakerName(p: Production, line: DialogueLine): string {
  if (line.speaker === "narrator") return "Narrator";
  return p.characters.find((c) => c.id === line.speaker)?.name ?? line.speaker;
}

function replaceLine(p: Production, lineId: string, fn: (l: DialogueLine) => DialogueLine): Production {
  let changed = false;
  const scenes = p.scenes.map((scene) => {
    const i = scene.dialogue.findIndex((l) => l.id === lineId);
    if (i === -1) return scene;
    const next = fn(scene.dialogue[i]!);
    if (next === scene.dialogue[i]) return scene;
    changed = true;
    const dialogue = [...scene.dialogue];
    dialogue[i] = next;
    return { ...scene, dialogue };
  });
  return changed ? { ...p, scenes } : p;
}

export function findLine(p: Production, lineId: string): { scene: Scene; line: DialogueLine; index: number } | null {
  for (const scene of p.scenes) {
    const index = scene.dialogue.findIndex((l) => l.id === lineId);
    if (index !== -1) return { scene, line: scene.dialogue[index]!, index };
  }
  return null;
}

/** Adds a generating take to one line; the approved take and timeline clip stay as they are. */
export function attachLineTake(p: Production, lineId: string, mediaId: string): Production {
  return replaceLine(p, lineId, (l) => (l.takes.includes(mediaId) ? l : { ...l, takes: [...l.takes, mediaId], status: "generating", lastError: undefined }));
}

export function approveLineTake(p: Production, lineId: string, mediaId: string): Production {
  return replaceLine(p, lineId, (l) => (l.takes.includes(mediaId) ? { ...l, approvedTakeId: mediaId, status: "approved" } : l));
}

export function setLineFailed(p: Production, lineId: string, message: string): Production {
  return replaceLine(p, lineId, (l) => ({ ...l, status: "failed", lastError: message }));
}

export function linkLineClip(p: Production, lineId: string, clipId: string | undefined): Production {
  return replaceLine(p, lineId, (l) => (l.timelineClipId === clipId ? l : { ...l, timelineClipId: clipId }));
}

export function setLineShot(p: Production, lineId: string, shotId: string | undefined): Production {
  return replaceLine(p, lineId, (l) => (l.shotId === shotId ? l : { ...l, shotId }));
}

/** Lines marked "generating" settle once their newest take is ready (generated) or fails. */
export function syncGeneratingLines(p: Production, stateOf: (mediaId: string) => TakeMediaState): Production {
  let next = p;
  for (const scene of p.scenes) {
    for (const line of scene.dialogue) {
      const last = line.takes[line.takes.length - 1];
      if (line.status !== "generating" || !last) continue;
      const state = stateOf(last);
      if (state.kind === "pending") continue;
      next = replaceLine(next, line.id, (l) =>
        state.kind === "ready"
          ? { ...l, status: l.approvedTakeId ? "approved" : "generated", lastError: undefined }
          : { ...l, status: "failed", lastError: state.kind === "failed" ? state.message : "The generated take was deleted" },
      );
    }
  }
  return next;
}
