import { LibraryCharacterSchema, type Character, type LibraryCharacter } from "@frontstage/core";

/**
 * Cross-project character library: one folder per character holding `character.json` plus its
 * reference images. Desktop stores it under ~/.frontstage/characters (fs IPC), web in OPFS.
 */
export interface CharacterLibraryStorage {
  listIds(): Promise<string[]>;
  readFile(id: string, name: string): Promise<Uint8Array | null>;
  writeFile(id: string, name: string, bytes: Uint8Array): Promise<void>;
  remove(id: string): Promise<void>;
}

const CHARACTER_JSON = "character.json";

export function isValidCharacterId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

function isValidFileName(name: string): boolean {
  return /^[A-Za-z0-9_.-]{1,128}$/.test(name) && name !== "." && name !== "..";
}

const MIME_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

export interface ProjectMediaAccess {
  entry(id: string): { name: string; type: string } | undefined;
  readEntryBytes(id: string): Promise<Uint8Array>;
  importBytes(bytes: Uint8Array, mimeType: string, name?: string, folderId?: string): Promise<{ assetId: string }>;
}

function sniffImageMime(bytes: Uint8Array): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return "image/gif";
  if (bytes[8] === 0x57 && bytes[9] === 0x45) return "image/webp";
  return "application/octet-stream";
}

export class CharacterLibrary {
  constructor(private readonly storage: CharacterLibraryStorage) {}

  /** Unreadable entries are skipped rather than failing the whole list. */
  async list(): Promise<LibraryCharacter[]> {
    const result: LibraryCharacter[] = [];
    for (const id of await this.storage.listIds()) {
      if (!isValidCharacterId(id)) continue;
      const bytes = await this.storage.readFile(id, CHARACTER_JSON);
      if (!bytes) continue;
      try {
        result.push(LibraryCharacterSchema.parse(JSON.parse(new TextDecoder().decode(bytes))));
      } catch {
        continue;
      }
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Saves a project character (and the bytes of its image references) to the library. Re-saving a
   * character that came from the library overwrites that entry.
   */
  async saveFromProject(character: Character, media: ProjectMediaAccess): Promise<LibraryCharacter> {
    const id = character.libraryId && isValidCharacterId(character.libraryId) ? character.libraryId : crypto.randomUUID();
    const approved = new Set(character.approvedDesignIds);
    const mediaIds = [...new Set([...character.referenceMediaIds, ...character.approvedDesignIds])];
    const images: LibraryCharacter["images"] = [];
    for (const [i, mediaId] of mediaIds.entries()) {
      const entry = media.entry(mediaId);
      if (!entry || entry.type !== "image") continue;
      const bytes = await media.readEntryBytes(mediaId);
      const mimeType = sniffImageMime(bytes);
      const file = `ref-${i + 1}.${MIME_EXT[mimeType] ?? "bin"}`;
      await this.storage.writeFile(id, file, bytes);
      images.push({ file, name: entry.name, mimeType, approved: approved.has(mediaId) });
    }
    const record: LibraryCharacter = {
      id,
      name: character.name,
      description: character.description,
      appearance: character.appearance,
      continuityNotes: character.continuityNotes,
      images,
      updatedAt: new Date().toISOString(),
    };
    await this.storage.writeFile(id, CHARACTER_JSON, new TextEncoder().encode(JSON.stringify(record, null, 2)));
    return record;
  }

  /** Copies a library character's images into the project so the project stays self-contained. */
  async importIntoProject(record: LibraryCharacter, media: ProjectMediaAccess, folderId?: string): Promise<Partial<Character> & { name: string }> {
    const referenceMediaIds: string[] = [];
    const approvedDesignIds: string[] = [];
    for (const img of record.images) {
      if (!isValidFileName(img.file)) continue;
      const bytes = await this.storage.readFile(record.id, img.file);
      if (!bytes) continue;
      const { assetId } = await media.importBytes(bytes, img.mimeType, img.name, folderId);
      referenceMediaIds.push(assetId);
      if (img.approved) approvedDesignIds.push(assetId);
    }
    return {
      libraryId: record.id,
      name: record.name,
      description: record.description,
      appearance: record.appearance,
      continuityNotes: record.continuityNotes,
      referenceMediaIds,
      approvedDesignIds,
    };
  }

  remove(id: string): Promise<void> {
    if (!isValidCharacterId(id)) return Promise.reject(new Error(`invalid character id: ${id}`));
    return this.storage.remove(id);
  }
}

/** OPFS-backed storage (web, and any Chromium renderer): frontstage-characters/<id>/<file>. */
export function createOpfsCharacterStorage(
  getRoot: () => Promise<FileSystemDirectoryHandle> = () => navigator.storage.getDirectory(),
): CharacterLibraryStorage {
  const DIR = "frontstage-characters";
  const isNotFound = (e: unknown) => (e as DOMException)?.name === "NotFoundError";
  async function charactersDir(): Promise<FileSystemDirectoryHandle> {
    return (await getRoot()).getDirectoryHandle(DIR, { create: true });
  }
  function check(id: string, name?: string): void {
    if (!isValidCharacterId(id)) throw new Error(`invalid character id: ${id}`);
    if (name !== undefined && !isValidFileName(name)) throw new Error(`invalid file name: ${name}`);
  }
  return {
    async listIds() {
      const ids: string[] = [];
      const dir = await charactersDir() as FileSystemDirectoryHandle & { keys(): AsyncIterable<string> };
      for await (const name of dir.keys()) ids.push(name);
      return ids;
    },
    async readFile(id, name) {
      check(id, name);
      try {
        const sub = await (await charactersDir()).getDirectoryHandle(id);
        const file = await (await sub.getFileHandle(name)).getFile();
        return new Uint8Array(await file.arrayBuffer());
      } catch (e) {
        if (isNotFound(e)) return null;
        throw e;
      }
    },
    async writeFile(id, name, bytes) {
      check(id, name);
      const sub = await (await charactersDir()).getDirectoryHandle(id, { create: true });
      const w = await (await sub.getFileHandle(name, { create: true })).createWritable();
      await w.write(new Uint8Array(bytes));
      await w.close();
    },
    async remove(id) {
      check(id);
      try {
        await (await charactersDir()).removeEntry(id, { recursive: true });
      } catch (e) {
        if (!isNotFound(e)) throw e;
      }
    },
  };
}

export function createMemoryCharacterStorage(): CharacterLibraryStorage & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    async listIds() {
      return [...new Set([...files.keys()].map((k) => k.split("/")[0]!))];
    },
    async readFile(id, name) {
      return files.get(`${id}/${name}`) ?? null;
    },
    async writeFile(id, name, bytes) {
      files.set(`${id}/${name}`, bytes);
    },
    async remove(id) {
      for (const k of [...files.keys()]) if (k.startsWith(`${id}/`)) files.delete(k);
    },
  };
}
