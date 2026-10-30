import { z } from "zod";
import { CharacterAppearanceSchema } from "./production.js";

/** A character saved to the cross-project library: character.json beside its image files. */
export const LibraryImageSchema = z.object({
  file: z.string(),
  name: z.string(),
  mimeType: z.string(),
  approved: z.boolean().default(false),
});

export const LibraryCharacterSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  description: z.string().default(""),
  appearance: CharacterAppearanceSchema.default({}),
  continuityNotes: z.string().default(""),
  images: z.array(LibraryImageSchema).default([]),
  updatedAt: z.string(),
});

export type LibraryCharacter = z.infer<typeof LibraryCharacterSchema>;
