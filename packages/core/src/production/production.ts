import { z } from "zod";

const uuid = () => crypto.randomUUID();

// AI-written text arrives as a draft; nothing downstream should treat it as final until approved.
export const ContentStateSchema = z.enum(["draft", "approved"]);

export const ShotStatusSchema = z.enum([
  "draft", "ready", "generating", "generated", "approved", "needs-regen", "failed",
]);

// Where a take came from. "flow-manual" = generated in Google Flow by hand and imported; there is no Flow API.
export const ShotProviderSchema = z.enum(["fal-veo", "morphic", "flow-manual", "import"]);

export const TakeSchema = z.object({
  mediaId: z.string(),
  provider: ShotProviderSchema.default("import"),
  createdAt: z.string().default(() => new Date().toISOString()),
  note: z.string().default(""),
});

export const ShotSchema = z.object({
  id: z.string().default(uuid),
  title: z.string().default(""),
  description: z.string().default(""),
  durationSec: z.number().positive().default(5),
  camera: z.string().default(""),
  framing: z.string().default(""),
  characterIds: z.array(z.string()).default([]),
  prompt: z.string().default(""),
  promptState: ContentStateSchema.default("draft"),
  referenceMediaIds: z.array(z.string()).default([]),
  provider: ShotProviderSchema.optional(),
  takes: z.array(TakeSchema).default([]),
  approvedTakeId: z.string().optional(),
  timelineClipId: z.string().optional(),
  status: ShotStatusSchema.default("draft"),
  lastError: z.string().optional(),
  notes: z.string().default(""),
});

/** One spoken line. speaker = a character id, or "narrator" for voiceover. */
export const DialogueLineSchema = z.object({
  id: z.string().default(uuid),
  speaker: z.string().default("narrator"),
  text: z.string().default(""),
  /** Delivery note for the voice (e.g. "whispered, out of breath"). */
  direction: z.string().default(""),
  /** The shot this line plays over; placement starts at that shot's clip. */
  shotId: z.string().optional(),
  /** Generated recordings (media-library ids); one can be approved. */
  takes: z.array(z.string()).default([]),
  approvedTakeId: z.string().optional(),
  timelineClipId: z.string().optional(),
  status: z.enum(["draft", "generating", "generated", "approved", "failed"]).default("draft"),
  lastError: z.string().optional(),
});

/** Languages Chatterbox Multilingual accepts for a reference voice. */
export const VOICE_LANGUAGES = [
  "english", "arabic", "danish", "german", "greek", "spanish", "finnish", "french", "hebrew", "hindi", "italian", "japanese",
  "korean", "malay", "dutch", "norwegian", "polish", "portuguese", "russian", "swedish", "swahili", "turkish", "chinese",
] as const;

/**
 * A reusable voice made from a reference recording. The consent record is required: a profile is
 * only created when the user confirms the voice is theirs or they have the speaker's permission.
 */
export const VoiceProfileSchema = z.object({
  id: z.string().default(uuid),
  name: z.string().min(1),
  referenceMediaId: z.string(),
  language: z.enum(VOICE_LANGUAGES).default("english"),
  /** 0.25–2; 0.5 is neutral. */
  expressiveness: z.number().min(0.25).max(2).default(0.5),
  consent: z.object({
    attested: z.literal(true),
    note: z.string().default(""),
    date: z.string(),
  }),
});

export const SceneSchema = z.object({
  id: z.string().default(uuid),
  title: z.string().default(""),
  synopsis: z.string().default(""),
  script: z.string().default(""),
  scriptState: ContentStateSchema.default("draft"),
  characterIds: z.array(z.string()).default([]),
  continuityNotes: z.string().default(""),
  dialogue: z.array(DialogueLineSchema).default([]),
  dialogueState: ContentStateSchema.default("draft"),
  shots: z.array(ShotSchema).default([]),
});

export const CharacterAppearanceSchema = z.object({
  ageRange: z.string().default(""),
  hair: z.string().default(""),
  clothing: z.string().default(""),
  build: z.string().default(""),
  other: z.string().default(""),
});

export const CharacterSchema = z.object({
  id: z.string().default(uuid),
  /** Id in the cross-project character library this was copied from, if any. */
  libraryId: z.string().optional(),
  name: z.string().min(1),
  description: z.string().default(""),
  appearance: CharacterAppearanceSchema.default({}),
  referenceMediaIds: z.array(z.string()).default([]),
  approvedDesignIds: z.array(z.string()).default([]),
  voiceProfileId: z.string().optional(),
  continuityNotes: z.string().default(""),
});

export const StorySchema = z.object({
  idea: z.string().default(""),
  logline: z.string().default(""),
  outline: z.string().default(""),
  outlineState: ContentStateSchema.default("draft"),
});

export const ProductionSchema = z.object({
  version: z.number().default(1),
  story: StorySchema.default({}),
  voices: z.array(VoiceProfileSchema).default([]),
  narratorVoiceId: z.string().optional(),
  scenes: z.array(SceneSchema).default([]),
  characters: z.array(CharacterSchema).default([]),
});

export type ContentState = z.infer<typeof ContentStateSchema>;
export type ShotStatus = z.infer<typeof ShotStatusSchema>;
export type ShotProvider = z.infer<typeof ShotProviderSchema>;
export type Take = z.infer<typeof TakeSchema>;
export type Shot = z.infer<typeof ShotSchema>;
export type Scene = z.infer<typeof SceneSchema>;
export type DialogueLine = z.infer<typeof DialogueLineSchema>;
export type VoiceProfile = z.infer<typeof VoiceProfileSchema>;
export type VoiceLanguage = (typeof VOICE_LANGUAGES)[number];
export type Story = z.infer<typeof StorySchema>;
export type CharacterAppearance = z.infer<typeof CharacterAppearanceSchema>;
export type Character = z.infer<typeof CharacterSchema>;
export type Production = z.infer<typeof ProductionSchema>;

export function emptyProduction(): Production {
  return ProductionSchema.parse({});
}

export type SceneStatus = "empty" | "in-progress" | "attention" | "complete";

/** Derived, never stored: a scene is complete only when every shot is approved. */
export function sceneStatus(scene: Scene): SceneStatus {
  if (scene.shots.length === 0) return "empty";
  if (scene.shots.some((s) => s.status === "needs-regen" || s.status === "failed")) return "attention";
  if (scene.shots.every((s) => s.status === "approved")) return "complete";
  return "in-progress";
}

export interface ShotLocation {
  scene: Scene;
  shot: Shot;
  sceneIndex: number;
  shotIndex: number;
}

export function findShot(p: Production, shotId: string): ShotLocation | null {
  for (let si = 0; si < p.scenes.length; si++) {
    const scene = p.scenes[si]!;
    const shotIndex = scene.shots.findIndex((s) => s.id === shotId);
    if (shotIndex !== -1) return { scene, shot: scene.shots[shotIndex]!, sceneIndex: si, shotIndex };
  }
  return null;
}

/** Every shot in story order (scene order, then shot order). */
export function shotsInOrder(p: Production): Shot[] {
  return p.scenes.flatMap((s) => s.shots);
}

function moveItem<T>(items: T[], from: number, to: number): T[] {
  const clamped = Math.max(0, Math.min(to, items.length - 1));
  if (from === clamped) return items;
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(clamped, 0, item!);
  return next;
}

// --- scenes ---

export function addScene(p: Production, init: Partial<Scene> = {}, atIndex?: number): { production: Production; sceneId: string } {
  const scene = SceneSchema.parse(init);
  const scenes = [...p.scenes];
  scenes.splice(atIndex ?? scenes.length, 0, scene);
  return { production: { ...p, scenes }, sceneId: scene.id };
}

export function updateScene(p: Production, sceneId: string, patch: Partial<Omit<Scene, "id" | "shots">>): Production {
  const idx = p.scenes.findIndex((s) => s.id === sceneId);
  if (idx === -1) return p;
  const scenes = [...p.scenes];
  scenes[idx] = { ...scenes[idx]!, ...patch };
  return { ...p, scenes };
}

export function removeScene(p: Production, sceneId: string): Production {
  const scenes = p.scenes.filter((s) => s.id !== sceneId);
  return scenes.length === p.scenes.length ? p : { ...p, scenes };
}

export function moveScene(p: Production, sceneId: string, toIndex: number): Production {
  const from = p.scenes.findIndex((s) => s.id === sceneId);
  if (from === -1) return p;
  const scenes = moveItem(p.scenes, from, toIndex);
  return scenes === p.scenes ? p : { ...p, scenes };
}

export function updateStory(p: Production, patch: Partial<Story>): Production {
  return { ...p, story: { ...p.story, ...patch } };
}

/**
 * Replaces a scene's shot list with new draft shots, keeping every shot that already has takes
 * (and so possibly a timeline clip): regenerating a shot list never discards generated work.
 */
export function replaceDraftShots(p: Production, sceneId: string, shots: Partial<Shot>[]): Production {
  const idx = p.scenes.findIndex((s) => s.id === sceneId);
  if (idx === -1) return p;
  const scene = p.scenes[idx]!;
  const kept = scene.shots.filter((s) => s.takes.length > 0);
  const scenes = [...p.scenes];
  scenes[idx] = { ...scene, shots: [...kept, ...shots.map((s) => ShotSchema.parse(s))] };
  return { ...p, scenes };
}

// --- shots ---

function replaceShot(p: Production, shotId: string, fn: (shot: Shot) => Shot): Production {
  const loc = findShot(p, shotId);
  if (!loc) return p;
  const nextShot = fn(loc.shot);
  if (nextShot === loc.shot) return p;
  const shots = [...loc.scene.shots];
  shots[loc.shotIndex] = nextShot;
  const scenes = [...p.scenes];
  scenes[loc.sceneIndex] = { ...loc.scene, shots };
  return { ...p, scenes };
}

export function addShot(
  p: Production,
  sceneId: string,
  init: Partial<Shot> = {},
  atIndex?: number,
): { production: Production; shotId: string | null } {
  const idx = p.scenes.findIndex((s) => s.id === sceneId);
  if (idx === -1) return { production: p, shotId: null };
  const shot = ShotSchema.parse(init);
  const scene = p.scenes[idx]!;
  const shots = [...scene.shots];
  shots.splice(atIndex ?? shots.length, 0, shot);
  const scenes = [...p.scenes];
  scenes[idx] = { ...scene, shots };
  return { production: { ...p, scenes }, shotId: shot.id };
}

export function updateShot(p: Production, shotId: string, patch: Partial<Omit<Shot, "id" | "takes">>): Production {
  return replaceShot(p, shotId, (shot) => ({ ...shot, ...patch }));
}

export function removeShot(p: Production, shotId: string): Production {
  const loc = findShot(p, shotId);
  if (!loc) return p;
  const scenes = [...p.scenes];
  scenes[loc.sceneIndex] = { ...loc.scene, shots: loc.scene.shots.filter((s) => s.id !== shotId) };
  return { ...p, scenes };
}

export function moveShot(p: Production, shotId: string, toIndex: number): Production {
  const loc = findShot(p, shotId);
  if (!loc) return p;
  const shots = moveItem(loc.scene.shots, loc.shotIndex, toIndex);
  if (shots === loc.scene.shots) return p;
  const scenes = [...p.scenes];
  scenes[loc.sceneIndex] = { ...loc.scene, shots };
  return { ...p, scenes };
}

export function setShotStatus(p: Production, shotId: string, status: ShotStatus, error?: string): Production {
  return replaceShot(p, shotId, (shot) => ({ ...shot, status, lastError: status === "failed" ? error : undefined }));
}

/**
 * Adds a take without touching the approved take or the timeline link, so a regeneration never
 * disturbs what is already cut — the user approves and replaces explicitly.
 */
export function attachTake(p: Production, shotId: string, take: Partial<Take> & { mediaId: string }): Production {
  return replaceShot(p, shotId, (shot) => {
    if (shot.takes.some((t) => t.mediaId === take.mediaId)) return shot;
    return {
      ...shot,
      takes: [...shot.takes, TakeSchema.parse(take)],
      status: "generated",
      lastError: undefined,
    };
  });
}

export function approveTake(p: Production, shotId: string, mediaId: string): Production {
  return replaceShot(p, shotId, (shot) => {
    if (!shot.takes.some((t) => t.mediaId === mediaId)) return shot;
    return { ...shot, approvedTakeId: mediaId, status: "approved" };
  });
}

export function markNeedsRegen(p: Production, shotId: string, note?: string): Production {
  return replaceShot(p, shotId, (shot) => ({
    ...shot,
    status: "needs-regen",
    notes: note ? (shot.notes ? `${shot.notes}\n${note}` : note) : shot.notes,
  }));
}

/** A take's media as the library sees it: still generating/downloading, ready, failed, or deleted. */
export type TakeMediaState = { kind: "pending" } | { kind: "ready" } | { kind: "failed"; message: string } | { kind: "missing" };

/**
 * Settles shots marked "generating" once their newest take's media resolves: ready → "generated",
 * failed → "failed" with the provider's message. A shot only reads as generated when the media is
 * really in the library.
 */
export function syncGeneratingShots(p: Production, stateOf: (mediaId: string) => TakeMediaState): Production {
  let changed = false;
  const scenes = p.scenes.map((scene) => {
    let sceneChanged = false;
    const shots = scene.shots.map((shot) => {
      const last = shot.takes[shot.takes.length - 1];
      if (shot.status !== "generating" || !last) return shot;
      const state = stateOf(last.mediaId);
      if (state.kind === "pending") return shot;
      sceneChanged = true;
      if (state.kind === "ready") return { ...shot, status: "generated" as const, lastError: undefined };
      return { ...shot, status: "failed" as const, lastError: state.kind === "failed" ? state.message : "The generated take was deleted" };
    });
    if (!sceneChanged) return scene;
    changed = true;
    return { ...scene, shots };
  });
  return changed ? { ...p, scenes } : p;
}

export function linkShotClip(p: Production, shotId: string, clipId: string | undefined): Production {
  return replaceShot(p, shotId, (shot) => (shot.timelineClipId === clipId ? shot : { ...shot, timelineClipId: clipId }));
}

// --- characters ---

export function upsertCharacter(p: Production, character: Partial<Character> & { name: string }): { production: Production; characterId: string } {
  const parsed = CharacterSchema.parse(character);
  const idx = p.characters.findIndex((c) => c.id === parsed.id);
  const characters = [...p.characters];
  if (idx === -1) characters.push(parsed);
  else characters[idx] = parsed;
  return { production: { ...p, characters }, characterId: parsed.id };
}

/** Removes the character and every scene/shot reference to it. */
export function removeCharacter(p: Production, characterId: string): Production {
  if (!p.characters.some((c) => c.id === characterId)) return p;
  const strip = (ids: string[]) => ids.filter((id) => id !== characterId);
  return {
    ...p,
    characters: p.characters.filter((c) => c.id !== characterId),
    scenes: p.scenes.map((scene) => ({
      ...scene,
      characterIds: strip(scene.characterIds),
      shots: scene.shots.map((shot) => ({ ...shot, characterIds: strip(shot.characterIds) })),
    })),
  };
}

/** Reference images for a shot: its own references first, then its characters' approved designs/references. */
export function shotReferenceMediaIds(p: Production, shot: Shot): string[] {
  const ids = new Set(shot.referenceMediaIds);
  for (const cid of shot.characterIds) {
    const c = p.characters.find((ch) => ch.id === cid);
    if (!c) continue;
    for (const id of c.approvedDesignIds.length ? c.approvedDesignIds : c.referenceMediaIds) ids.add(id);
  }
  return [...ids];
}

/** Drops references to deleted library entries (takes, references, designs). */
export function dropMediaRefs(p: Production, mediaIds: ReadonlySet<string>): Production {
  if (mediaIds.size === 0) return p;
  const keep = (id: string) => !mediaIds.has(id);
  let changed = false;
  const scenes = p.scenes.map((scene) => ({
    ...scene,
    shots: scene.shots.map((shot) => {
      const takes = shot.takes.filter((t) => keep(t.mediaId));
      const referenceMediaIds = shot.referenceMediaIds.filter(keep);
      if (takes.length === shot.takes.length && referenceMediaIds.length === shot.referenceMediaIds.length) return shot;
      changed = true;
      const approvedGone = shot.approvedTakeId !== undefined && !keep(shot.approvedTakeId);
      return {
        ...shot,
        takes,
        referenceMediaIds,
        approvedTakeId: approvedGone ? undefined : shot.approvedTakeId,
        status: approvedGone ? (takes.length ? "generated" as const : "draft" as const) : shot.status,
      };
    }),
  }));
  const characters = p.characters.map((c) => {
    const referenceMediaIds = c.referenceMediaIds.filter(keep);
    const approvedDesignIds = c.approvedDesignIds.filter(keep);
    if (referenceMediaIds.length === c.referenceMediaIds.length && approvedDesignIds.length === c.approvedDesignIds.length) return c;
    changed = true;
    return { ...c, referenceMediaIds, approvedDesignIds };
  });
  // Dialogue takes follow the same rule as shot takes; a voice whose reference is gone is removed.
  const scenes2 = scenes.map((scene) => {
    if (!scene.dialogue.some((l) => l.takes.some((t) => !keep(t)))) return scene;
    changed = true;
    return {
      ...scene,
      dialogue: scene.dialogue.map((l) => {
        const takes = l.takes.filter(keep);
        if (takes.length === l.takes.length) return l;
        const approvedGone = l.approvedTakeId !== undefined && !keep(l.approvedTakeId);
        return { ...l, takes, approvedTakeId: approvedGone ? undefined : l.approvedTakeId, status: approvedGone ? (takes.length ? "generated" as const : "draft" as const) : l.status };
      }),
    };
  });
  const voices = p.voices.filter((v) => keep(v.referenceMediaId));
  if (voices.length !== p.voices.length) {
    changed = true;
    const gone = new Set(p.voices.filter((v) => !keep(v.referenceMediaId)).map((v) => v.id));
    return {
      ...p,
      scenes: scenes2,
      voices,
      narratorVoiceId: p.narratorVoiceId && gone.has(p.narratorVoiceId) ? undefined : p.narratorVoiceId,
      characters: characters.map((c) => (c.voiceProfileId && gone.has(c.voiceProfileId) ? { ...c, voiceProfileId: undefined } : c)),
    };
  }
  return changed ? { ...p, scenes: scenes2, characters } : p;
}
