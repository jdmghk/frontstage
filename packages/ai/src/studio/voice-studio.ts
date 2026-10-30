// Dialogue lines → speech in the line's character (or narrator) voice, through fal-hosted
// Chatterbox Multilingual (Resemble AI, MIT-licensed model). No ElevenLabs account is needed: it
// runs on the fal.ai key the Generate panel already uses. Schema verified 2026-10-30 against
// fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/chatterbox/text-to-speech/multilingual:
// text (≤300 chars), voice (a reference-audio URL), custom_audio_language, exaggeration; output audio.url.

import type { GenerationInput, MediaManifestEntry, Production } from "@frontstage/core";
import { createPlaceholderEntry, findLine, speakerName, voiceForLine } from "@frontstage/core";
import type { StartJobArgs } from "../generation/generation-service.js";

export const CHATTERBOX_ENDPOINT = "fal-ai/chatterbox/text-to-speech/multilingual";
export const CHATTERBOX_MAX_CHARS = 300;
/** fal.ai price, $0.025 per 1,000 characters (fal model page, 2026-10-30), in fal credits (1 credit = $0.01). */
export const CHATTERBOX_CREDITS_PER_1K_CHARS = 2.5;

export interface VoiceStudioDeps {
  generation: {
    hasKey(): Promise<boolean>;
    addPlaceholder(entry: MediaManifestEntry): void;
    startJob(args: StartJobArgs): Promise<{ jobId: string } | { error: string }>;
  };
  /** Library media id → a URL fal can fetch (uploads once and caches). */
  entryUrl(mediaRef: string): Promise<string | undefined>;
  newId(): string;
}

export type VoiceStartResult = { placeholderId: string } | { error: string };

export function chatterboxInput(text: string, referenceUrl: string, language: string, expressiveness: number): Record<string, unknown> {
  return { text, voice: referenceUrl, custom_audio_language: language, exaggeration: expressiveness };
}

export class VoiceStudio {
  constructor(private readonly deps: VoiceStudioDeps) {}

  /** One new take for one line. Other lines and this line's earlier takes are untouched. */
  async generateLine(p: Production, lineId: string, opts: { name: string; folderId?: string }): Promise<VoiceStartResult> {
    const found = findLine(p, lineId);
    if (!found) return { error: "This line no longer exists." };
    const { line } = found;
    const text = line.text.trim();
    if (!text) return { error: "Write the line first." };
    if (text.length > CHATTERBOX_MAX_CHARS) return { error: `Lines can be at most ${CHATTERBOX_MAX_CHARS} characters; split this one (${text.length}).` };
    const voice = voiceForLine(p, line);
    if (!voice) return { error: `${speakerName(p, line)} has no voice yet. Assign one in the Voice tab.` };
    if (!voice.consent.attested) return { error: "This voice has no consent record." };
    if (!(await this.deps.generation.hasKey())) return { error: "Add a fal.ai key in Settings → Generation to generate speech." };
    const url = await this.deps.entryUrl(voice.referenceMediaId).catch(() => undefined);
    if (!url) return { error: `The reference recording for "${voice.name}" isn't available.` };

    const genInput: GenerationInput = {
      prompt: text,
      model: CHATTERBOX_ENDPOINT,
      duration: 0,
      aspectRatio: "",
      voice: voice.name,
      referenceAudioAssetIds: [voice.referenceMediaId],
      outputIndex: 0,
      createdAt: new Date().toISOString(),
    };
    const entry = createPlaceholderEntry({ id: this.deps.newId(), type: "audio", name: opts.name, duration: 0, ext: "wav", genInput, folderId: opts.folderId });
    this.deps.generation.addPlaceholder(entry);
    const r = await this.deps.generation.startJob({
      modelEndpoint: CHATTERBOX_ENDPOINT,
      input: chatterboxInput(text, url, voice.language, voice.expressiveness),
      placeholders: [entry],
      model: CHATTERBOX_ENDPOINT,
      costCredits: Math.ceil((text.length / 1000) * CHATTERBOX_CREDITS_PER_1K_CHARS * 100) / 100,
    });
    if ("error" in r) return { error: r.error };
    return { placeholderId: entry.id };
  }
}
