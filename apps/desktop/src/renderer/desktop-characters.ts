import type { CharacterLibraryStorage } from "@frontstage/ui";

interface DesktopCharactersBridge {
  listIds(): Promise<string[]>;
  readFile(id: string, name: string): Promise<Uint8Array | null>;
  writeFile(id: string, name: string, bytes: Uint8Array): Promise<void>;
  remove(id: string): Promise<void>;
}

declare global {
  interface Window {
    desktopCharacters: DesktopCharactersBridge;
  }
}

// Thin IPC facade over ~/.frontstage/characters; id/file-name validation lives main-side (characters-fs.mjs).
export function createDesktopCharacterStorage(): CharacterLibraryStorage {
  return {
    listIds: () => window.desktopCharacters.listIds(),
    readFile: (id, name) => window.desktopCharacters.readFile(id, name),
    writeFile: (id, name, bytes) => window.desktopCharacters.writeFile(id, name, bytes),
    remove: (id) => window.desktopCharacters.remove(id),
  };
}
