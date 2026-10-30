import type { MediaFolder, MediaManifestEntry } from "@frontstage/core";

/** Minimal in-memory library covering what the Production/Characters tabs use. */
export function fakeProductionLibrary(initial: MediaManifestEntry[] = [], opts: { pendingImports?: boolean } = {}) {
  let entries = initial;
  let folders: MediaFolder[] = [];
  const bytes = new Map<string, Uint8Array>();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const l of listeners) l();
  };
  let n = 0;
  const add = (name: string, type: MediaManifestEntry["type"], folderId?: string, duration = 4): MediaManifestEntry => {
    const e: MediaManifestEntry = {
      id: `m${++n}`,
      name,
      type,
      source: { kind: "project", relativePath: `media/m${n}` },
      duration,
      hasAudio: false,
      folderId,
    };
    entries = [...entries, e];
    return e;
  };
  return {
    getSnapshot: () => ({ entries, folders }),
    subscribe: (cb: () => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    thumbnail: (_id: string) => undefined,
    entry: (id: string) => entries.find((e) => e.id === id),
    async importFiles(files: File[] | FileList, folderId?: string) {
      const added = Array.from(files).map((f) => {
        let e = add(f.name, f.type.startsWith("image/") ? "image" : f.type.startsWith("audio/") ? "audio" : "video", folderId);
        if (opts.pendingImports) {
          e = { ...e, duration: 0, generationStatus: "downloading" };
          entries = entries.map((x) => (x.id === e.id ? e : x));
        }
        bytes.set(e.id, new Uint8Array([0x89, 0x50, 1, 2]));
        return e;
      });
      notify();
      return added;
    },
    createFolder(name: string, parentFolderId?: string) {
      const f: MediaFolder = { id: `f${folders.length + 1}`, name, parentFolderId };
      folders = [...folders, f];
      notify();
      return f;
    },
    async readEntryBytes(id: string) {
      const b = bytes.get(id);
      if (!b) throw new Error(`no bytes for ${id}`);
      return b;
    },
    async importBytes(b: Uint8Array, _mime: string, name?: string, folderId?: string) {
      const e = add(name ?? "imported", "image", folderId);
      bytes.set(e.id, b);
      notify();
      return { assetId: e.id };
    },
    finishImports() {
      entries = entries.map(({ generationStatus: _g, ...e }) => ({ ...e, duration: 4 }));
      notify();
    },
    /** Stands in for GenerationService: a generating placeholder, later finished or failed. */
    addPlaceholder(name: string, type: MediaManifestEntry["type"], folderId?: string): MediaManifestEntry {
      const e = { ...add(name, type, folderId, 0), generationStatus: "generating" };
      entries = entries.map((x) => (x.id === e.id ? e : x));
      notify();
      return e;
    },
    failEntry(id: string, message: string) {
      entries = entries.map((e) => (e.id === id ? { ...e, generationStatus: `failed: ${message}` } : e));
      notify();
    },
    deleteEntries(ids: string[]) {
      entries = entries.filter((e) => !ids.includes(e.id));
      notify();
    },
  };
}
