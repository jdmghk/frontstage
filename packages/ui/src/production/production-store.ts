import { dropMediaRefs, emptyProduction, parseGenerationStatus, syncGeneratingShots } from "@frontstage/core";
import type { TakeMediaState } from "@frontstage/core";
import type { MediaFolder, MediaManifestEntry, Production } from "@frontstage/core";

interface LibraryLike {
  getSnapshot(): { entries: MediaManifestEntry[]; folders: MediaFolder[] };
  subscribe(cb: () => void): () => void;
}

/**
 * Observable holder for the project's production.json — same subscribe/getSnapshot shape as
 * MediaLibrary. Like the library it has no undo; timeline changes keep using the editor's undo.
 */
export class ProductionStore {
  private _production: Production = emptyProduction();
  private listeners = new Set<() => void>();
  private knownMediaIds: Set<string> | null = null;
  private syncing = false;

  getSnapshot(): Production {
    return this._production;
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  load(production: Production | undefined): void {
    this._production = production ?? emptyProduction();
    this.emit();
  }

  /** Applies a pure op from @frontstage/core; a same-reference result is a no-op. */
  update(fn: (p: Production) => Production): void {
    const next = fn(this._production);
    if (next === this._production) return;
    this._production = next;
    this.emit();
  }

  /**
   * Keeps takes/references in step when assets are deleted from the media library, and settles
   * "generating" shots once their take finishes or fails.
   */
  attachLibrary(library: LibraryLike): () => void {
    this.knownMediaIds = new Set(library.getSnapshot().entries.map((e) => e.id));
    const sync = () => this.update((p) => syncGeneratingShots(p, (id) => takeMediaState(library.getSnapshot().entries, id)));
    sync();
    const unsubscribe = library.subscribe(() => {
      const ids = new Set(library.getSnapshot().entries.map((e) => e.id));
      const removed = new Set([...(this.knownMediaIds ?? [])].filter((id) => !ids.has(id)));
      this.knownMediaIds = ids;
      if (removed.size > 0) this.update((p) => dropMediaRefs(p, removed));
      sync();
    });
    // A project open replaces the production after the library loads; settle it then too.
    const unsubscribeSelf = this.subscribe(() => {
      if (this.syncing) return;
      this.syncing = true;
      try {
        sync();
      } finally {
        this.syncing = false;
      }
    });
    return () => {
      unsubscribe();
      unsubscribeSelf();
    };
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}

function takeMediaState(entries: MediaManifestEntry[], id: string): TakeMediaState {
  const entry = entries.find((e) => e.id === id);
  if (!entry) return { kind: "missing" };
  const status = parseGenerationStatus(entry.generationStatus);
  if (status.kind === "none") return { kind: "ready" };
  if (status.kind === "failed") return { kind: "failed", message: status.message };
  return { kind: "pending" };
}

interface FolderLibrary {
  getSnapshot(): { folders: MediaFolder[] };
  createFolder(name: string, parentFolderId?: string): MediaFolder;
}

/** Finds or creates each folder along `path` (e.g. ["Production", "01 Opening", "02 Shot"]); returns the leaf id. */
export function ensureFolderPath(library: FolderLibrary, path: string[]): string | undefined {
  let parent: string | undefined;
  for (const name of path) {
    const existing = library.getSnapshot().folders.find((f) => f.name === name && f.parentFolderId === parent);
    parent = (existing ?? library.createFolder(name, parent)).id;
  }
  return parent;
}

export function numbered(index: number, title: string, fallback: string): string {
  return `${String(index + 1).padStart(2, "0")} ${title.trim() || fallback}`;
}
