// Claude writing tasks for the Production tab. Each task builds one structured-output request
// (system + prompt + JSON schema), validates the reply with zod, and applies it to the production
// as a draft. Tasks act on one scene or one shot so regenerating never touches the rest.

import { z } from "zod";
import type { Character, Production, Scene, Shot } from "@frontstage/core";
import { replaceDraftShots, updateScene, updateShot, updateStory, upsertCharacter, addScene } from "@frontstage/core";

export const STUDIO_MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
] as const;
export const DEFAULT_STUDIO_MODEL = "claude-opus-5-5";

export type StudioEffort = "low" | "medium" | "high";

/** Transport-neutral request; the desktop main process / proxy turns it into a Messages API call. */
export interface ClaudeStudioRequest {
  model: string;
  system: string;
  prompt: string;
  images?: { mediaType: string; base64: string }[];
  schema: Record<string, unknown>;
  effort: StudioEffort;
  maxTokens: number;
}

export type ClaudeStudioErrorKind = "no-key" | "refusal" | "truncated" | "auth" | "rate-limit" | "api" | "invalid";
export type ClaudeStudioResult = { ok: true; json: unknown } | { ok: false; kind: ClaudeStudioErrorKind; error: string };

export interface ClaudeGateway {
  run(req: ClaudeStudioRequest): Promise<ClaudeStudioResult>;
  hasKey(): Promise<boolean>;
}

const SYSTEM = [
  "You are a story and production writer for short cinematic YouTube videos made with AI video generators.",
  "Write vivid, concrete, filmable material. Keep continuity with the story, characters and earlier scenes you are given.",
  "Visual prompts describe what the camera sees: subject, action, setting, lighting, lens and movement, in present tense,",
  "without dialogue, on-screen text or brand names. Fight action must read as choreographed stunt work, never gore.",
].join(" ");

// --- JSON schema helpers (structured outputs need additionalProperties:false and every key required) ---

type JsonSchema = Record<string, unknown>;
const str = (description: string): JsonSchema => ({ type: "string", description });
const num = (description: string): JsonSchema => ({ type: "number", description });
const arr = (items: JsonSchema, description: string): JsonSchema => ({ type: "array", items, description });
function obj(properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}

// --- context ---

function characterLine(c: Character): string {
  const a = c.appearance;
  const look = [a.ageRange, a.build, a.hair && `hair ${a.hair}`, a.clothing && `wears ${a.clothing}`, a.other].filter(Boolean).join(", ");
  return `- ${c.name}: ${c.description || "(no description)"}${look ? ` [${look}]` : ""}${c.continuityNotes ? ` Continuity: ${c.continuityNotes}` : ""}`;
}

/** Compact production context: story, cast, and every scene's synopsis in order. */
export function productionContext(p: Production): string {
  const parts: string[] = [];
  if (p.story.idea) parts.push(`Idea: ${p.story.idea}`);
  if (p.story.logline) parts.push(`Logline: ${p.story.logline}`);
  if (p.story.outline) parts.push(`Outline:\n${p.story.outline}`);
  if (p.characters.length) parts.push(`Characters:\n${p.characters.map(characterLine).join("\n")}`);
  if (p.scenes.length) parts.push(`Scenes:\n${p.scenes.map((s, i) => `${i + 1}. ${s.title || "Untitled"}: ${s.synopsis || "(no synopsis)"}`).join("\n")}`);
  return parts.join("\n\n");
}

function sceneContext(p: Production, scene: Scene): string {
  const idx = p.scenes.findIndex((s) => s.id === scene.id);
  const cast = p.characters.filter((c) => scene.characterIds.includes(c.id)).map((c) => c.name);
  return [
    `Scene ${idx + 1}: ${scene.title || "Untitled"}`,
    scene.synopsis && `Synopsis: ${scene.synopsis}`,
    cast.length ? `Cast: ${cast.join(", ")}` : "Cast: not set",
    scene.continuityNotes && `Continuity: ${scene.continuityNotes}`,
    scene.script && `Script:\n${scene.script}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function base(p: Production, prompt: string, schema: JsonSchema, effort: StudioEffort, model: string, maxTokens = 16000): ClaudeStudioRequest {
  const ctx = productionContext(p);
  return { model, system: SYSTEM, prompt: ctx ? `${ctx}\n\n---\n\n${prompt}` : prompt, schema, effort, maxTokens };
}

const findCharacter = (p: Production, name: string) => p.characters.find((c) => c.name.trim().toLowerCase() === name.trim().toLowerCase());

/** A writer task: the request to send, and how to validate + apply the reply. */
export interface WriterTask<T> {
  request: ClaudeStudioRequest;
  parse(json: unknown): T;
  apply(p: Production, result: T): Production;
  /** One line for the UI after applying. */
  summary(result: T): string;
}

function parser<S extends z.ZodTypeAny>(schema: S) {
  return (json: unknown): z.infer<S> => {
    const r = schema.safeParse(json);
    if (!r.success) throw new Error(`Claude's reply didn't match the expected shape: ${r.error.issues[0]?.message ?? "invalid"}`);
    return r.data;
  };
}

// --- tasks ---

const OutlineZ = z.object({ logline: z.string(), outline: z.string(), scenes: z.array(z.object({ title: z.string(), synopsis: z.string() })) });
export function outlineTask(p: Production, model = DEFAULT_STUDIO_MODEL): WriterTask<z.infer<typeof OutlineZ>> {
  return {
    request: base(
      p,
      `Write a story outline for this video${p.story.idea ? "" : " (invent a strong premise)"}: a one-sentence logline, a short outline (a few paragraphs), and the scenes in order, each with a title and a 1-3 sentence synopsis. Aim for 4-10 scenes.`,
      obj({
        logline: str("One sentence"),
        outline: str("A few short paragraphs"),
        scenes: arr(obj({ title: str("Short scene title"), synopsis: str("1-3 sentences") }), "Scenes in story order"),
      }),
      "high",
      model,
    ),
    parse: parser(OutlineZ),
    // Scenes are created only when the production has none: an outline rewrite never deletes scenes.
    apply(p, r) {
      let next = updateStory(p, { logline: r.logline, outline: r.outline, outlineState: "draft" });
      if (p.scenes.length === 0) for (const s of r.scenes) next = addScene(next, { title: s.title, synopsis: s.synopsis }).production;
      return next;
    },
    summary: (r) => `Outline written with ${r.scenes.length} scenes.`,
  };
}

const ScriptZ = z.object({ script: z.string() });
export function sceneScriptTask(p: Production, scene: Scene, model = DEFAULT_STUDIO_MODEL): WriterTask<z.infer<typeof ScriptZ>> {
  return {
    request: base(
      p,
      `${sceneContext(p, scene)}\n\nWrite the full screenplay for this scene: sluglines, action lines and dialogue, in standard screenplay style. Keep it filmable in under two minutes.`,
      obj({ script: str("The screenplay text") }),
      "high",
      model,
    ),
    parse: parser(ScriptZ),
    apply: (p, r) => updateScene(p, scene.id, { script: r.script, scriptState: "draft" }),
    summary: () => "Script written (draft).",
  };
}

const CharactersZ = z.object({
  characters: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      ageRange: z.string(),
      hair: z.string(),
      clothing: z.string(),
      build: z.string(),
      other: z.string(),
      continuityNotes: z.string(),
    }),
  ),
});
export function charactersTask(p: Production, model = DEFAULT_STUDIO_MODEL): WriterTask<z.infer<typeof CharactersZ>> {
  return {
    request: base(
      p,
      "List the story's characters with consistent, specific visual descriptions a video generator can follow. Include existing characters by their exact names. Leave a field empty when it doesn't apply.",
      obj({
        characters: arr(
          obj({
            name: str("Character name"),
            description: str("Who they are, 1-2 sentences"),
            ageRange: str("e.g. late 20s"),
            hair: str("Hair"),
            clothing: str("Signature outfit"),
            build: str("Build"),
            other: str("Scars, props, distinguishing marks"),
            continuityNotes: str("Things that must never change between shots"),
          }),
          "Characters",
        ),
      }),
      "medium",
      model,
    ),
    parse: parser(CharactersZ),
    // New characters are added; existing ones only get fields that are still empty.
    apply(p, r) {
      let next = p;
      for (const c of r.characters) {
        const existing = findCharacter(next, c.name);
        const fill = (cur: string, v: string) => cur.trim() || v;
        const appearance = {
          ageRange: fill(existing?.appearance.ageRange ?? "", c.ageRange),
          hair: fill(existing?.appearance.hair ?? "", c.hair),
          clothing: fill(existing?.appearance.clothing ?? "", c.clothing),
          build: fill(existing?.appearance.build ?? "", c.build),
          other: fill(existing?.appearance.other ?? "", c.other),
        };
        next = upsertCharacter(next, {
          ...(existing ?? {}),
          name: existing?.name ?? c.name,
          description: fill(existing?.description ?? "", c.description),
          continuityNotes: fill(existing?.continuityNotes ?? "", c.continuityNotes),
          appearance,
        }).production;
      }
      return next;
    },
    summary: (r) => `${r.characters.length} characters suggested; existing details were kept.`,
  };
}

const ShotListZ = z.object({
  shots: z.array(
    z.object({ title: z.string(), description: z.string(), durationSec: z.number(), camera: z.string(), framing: z.string(), characters: z.array(z.string()) }),
  ),
});
export function shotListTask(p: Production, scene: Scene, model = DEFAULT_STUDIO_MODEL): WriterTask<z.infer<typeof ShotListZ>> {
  return {
    request: base(
      p,
      `${sceneContext(p, scene)}\n\nBreak this scene into shots for AI video generation. Each shot is one continuous clip of 3-10 seconds with a single clear action, its camera angle and movement, its framing, and the characters visible (exact names).`,
      obj({
        shots: arr(
          obj({
            title: str("Short label"),
            description: str("What happens in the shot"),
            durationSec: num("Seconds, 3-10"),
            camera: str("Angle and movement"),
            framing: str("e.g. wide, medium, close-up"),
            characters: arr(str("Exact character name"), "Characters visible"),
          }),
          "Shots in order",
        ),
      }),
      "medium",
      model,
    ),
    parse: parser(ShotListZ),
    apply(p, r) {
      const shots = r.shots.map((s) => ({
        title: s.title,
        description: s.description,
        durationSec: Math.min(60, Math.max(1, s.durationSec || 5)),
        camera: s.camera,
        framing: s.framing,
        characterIds: s.characters.map((n) => findCharacter(p, n)?.id).filter((id): id is string => !!id),
      }));
      return replaceDraftShots(p, scene.id, shots);
    },
    summary: (r) => `${r.shots.length} shots written. Shots that already had takes were kept.`,
  };
}

const PromptZ = z.object({ prompt: z.string() });
export function shotPromptTask(p: Production, scene: Scene, shot: Shot, model = DEFAULT_STUDIO_MODEL): WriterTask<z.infer<typeof PromptZ>> {
  const cast = p.characters.filter((c) => shot.characterIds.includes(c.id));
  return {
    request: base(
      p,
      [
        sceneContext(p, scene),
        `Shot: ${shot.title || "Untitled"}`,
        shot.description && `Action: ${shot.description}`,
        shot.camera && `Camera: ${shot.camera}`,
        shot.framing && `Framing: ${shot.framing}`,
        `Duration: ${shot.durationSec}s`,
        cast.length ? `Characters in shot:\n${cast.map(characterLine).join("\n")}` : "",
        "",
        "Write one video-generation prompt for this shot (60-120 words). Restate each character's look from the descriptions so the shot stands alone.",
      ]
        .filter((l) => typeof l === "string")
        .join("\n"),
      obj({ prompt: str("The video prompt") }),
      "medium",
      model,
      4000,
    ),
    parse: parser(PromptZ),
    apply: (p, r) => updateShot(p, shot.id, { prompt: r.prompt, promptState: "draft" }),
    summary: () => "Prompt written (draft).",
  };
}

const DialogueZ = z.object({ lines: z.array(z.object({ speaker: z.string(), text: z.string(), direction: z.string() })) });
export function dialogueTask(p: Production, scene: Scene, model = DEFAULT_STUDIO_MODEL): WriterTask<z.infer<typeof DialogueZ>> {
  return {
    request: base(
      p,
      `${sceneContext(p, scene)}\n\nWrite this scene's spoken lines for voice recording, in order: dialogue by character (exact names) and voiceover as speaker "Narrator". Each line gets a short delivery direction. Base it on the script when there is one.`,
      obj({ lines: arr(obj({ speaker: str("Exact character name or Narrator"), text: str("The line"), direction: str("Delivery") }), "Lines in order") }),
      "medium",
      model,
    ),
    parse: parser(DialogueZ),
    apply(p, r) {
      const dialogue = r.lines.map((l) => ({
        id: crypto.randomUUID(),
        speaker: l.speaker.trim().toLowerCase() === "narrator" ? "narrator" : (findCharacter(p, l.speaker)?.id ?? l.speaker),
        text: l.text,
        direction: l.direction,
      }));
      return updateScene(p, scene.id, { dialogue, dialogueState: "draft" });
    },
    summary: (r) => `${r.lines.length} lines written (draft).`,
  };
}

const ContinuityZ = z.object({ sceneNotes: z.string(), characterNotes: z.array(z.object({ name: z.string(), note: z.string() })) });
export function continuityTask(p: Production, scene: Scene, model = DEFAULT_STUDIO_MODEL): WriterTask<z.infer<typeof ContinuityZ>> {
  return {
    request: base(
      p,
      `${sceneContext(p, scene)}\n\nList the continuity requirements for this scene: setting, time of day, weather, props, injuries and costume state carried from earlier scenes. Then, per character in the scene, what must match their established look.`,
      obj({ sceneNotes: str("Scene continuity notes"), characterNotes: arr(obj({ name: str("Exact name"), note: str("Note") }), "Per character") }),
      "medium",
      model,
      6000,
    ),
    parse: parser(ContinuityZ),
    // Scene notes are replaced; character notes are only appended to, never overwritten.
    apply(p, r) {
      let next = updateScene(p, scene.id, { continuityNotes: r.sceneNotes });
      for (const n of r.characterNotes) {
        const c = findCharacter(next, n.name);
        if (!c || !n.note.trim() || c.continuityNotes.includes(n.note.trim())) continue;
        next = upsertCharacter(next, { ...c, continuityNotes: c.continuityNotes ? `${c.continuityNotes}\n${n.note.trim()}` : n.note.trim() }).production;
      }
      return next;
    },
    summary: () => "Continuity notes updated.",
  };
}

/** Runs a task through a gateway; returns the new production or a user-facing error. */
export async function runWriterTask<T>(
  gateway: ClaudeGateway,
  task: WriterTask<T>,
  current: () => Production,
): Promise<{ production: Production; summary: string } | { error: string }> {
  const res = await gateway.run(task.request);
  if (!res.ok) return { error: res.error };
  let parsed: T;
  try {
    parsed = task.parse(res.json);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  // Apply to the latest production: the user may have kept editing while Claude wrote.
  return { production: task.apply(current(), parsed), summary: task.summary(parsed) };
}
