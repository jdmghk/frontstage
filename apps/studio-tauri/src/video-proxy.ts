// H.264 conversion on import for clips this webview can't decode (HEVC, AV1, 10-bit, 4:4:4, left/top
// crop). The project keeps referencing the original: the manifest entry, the saved media file, uploads
// and interchange exports are untouched. Only what the engine reads changes, through
// MediaLibrary.setByteFilter. The proxy lives in the app's cache and can be rebuilt at any time.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { MediaManifestEntry } from "@frontstage/core";
import { demuxMp4, videoDecodeProblem } from "@frontstage/engine";
import { probeMediaBlob, type MediaLibrary } from "@frontstage/ui";
import { showNotice, type Notice } from "./notices.js";

type Decision = { key: string | null };

// Rust runs one conversion at a time, so progress belongs to the notice most recently waiting.
const onProgress = new Set<(fraction: number) => void>();
let listening = false;

function listenForProgress(): void {
  if (listening) return;
  listening = true;
  void listen<{ key: string; fraction: number }>("media:proxy-progress", (e) => {
    for (const f of onProgress) f(e.payload.fraction);
  });
}

function extensionOf(entry: MediaManifestEntry): string {
  const rel = entry.source.kind === "project" ? entry.source.relativePath : entry.source.absolutePath;
  return /\.([a-z0-9]{1,8})$/i.exec(rel)?.[1]?.toLowerCase() ?? "mp4";
}

export function attachVideoProxy(library: MediaLibrary, projectDir: () => string | undefined): void {
  listenForProgress();
  const decisions = new Map<string, Promise<Decision>>();

  async function convert(entry: MediaManifestEntry, blob: Blob, reason: string): Promise<Decision> {
    const name = entry.name;
    const base = `Converting “${name}” to H.264. ${reason}. Your original file stays in the project.`;
    const notice: Notice = showNotice("video-proxy-converting", base);
    let update: ((f: number) => void) | undefined;
    try {
      const dir = projectDir();
      const rel = entry.source.kind === "project" ? entry.source.relativePath : null;
      const onDisk = !!(dir && rel && (await window.desktopProject.hasMedia(dir, rel)));
      const started = (async () => {
        if (onDisk) return invoke<string>("media_proxy_ensure_path", { dir, rel });
        return invoke<string>("media_proxy_ensure_bytes", new Uint8Array(await blob.arrayBuffer()), { headers: { "x-ext": extensionOf(entry) } });
      })();
      update = (f: number) => notice.set(`Converting “${name}” to H.264 (${Math.round(f * 100)}%). ${reason}. Your original file stays in the project.`);
      onProgress.add(update);
      const key = await started;
      onProgress.delete(update);
      notice.remove();
      await fillMissingMetadata(entry, key);
      showNotice("video-proxy-done", `“${name}” was converted to H.264 to play here. Preview and export use the converted copy. The project still uses your original file.`).dismissAfter(8000);
      return { key };
    } catch (e) {
      if (update) onProgress.delete(update);
      notice.remove();
      showNotice("video-proxy-failed", `Couldn’t convert “${name}”, so it will stay blank here. ${reason}. ${String(e)}`, () => {});
      return { key: null };
    }
  }

  // WebKit's <video> can't read some of these clips either (AV1 on this Mac), so the import probe
  // falls back to placeholder values. The proxy has the same picture, so read them from it.
  async function fillMissingMetadata(entry: MediaManifestEntry, key: string): Promise<void> {
    if (entry.sourceWidth !== undefined) return;
    try {
      const blob = new Blob([await invoke<ArrayBuffer>("media_proxy_read", { key })], { type: "video/mp4" });
      const p = await probeMediaBlob(blob, "video");
      library.patchEntry(entry.id, {
        duration: p.duration,
        ...(p.sourceWidth !== undefined ? { sourceWidth: p.sourceWidth } : {}),
        ...(p.sourceHeight !== undefined ? { sourceHeight: p.sourceHeight } : {}),
        ...(p.hasAudio !== undefined ? { hasAudio: p.hasAudio } : {}),
      });
      if (p.thumb) library.setThumbnail(entry.id, p.thumb);
    } catch {
      /* the clip still plays; only its library details stay approximate */
    }
  }

  async function decide(entry: MediaManifestEntry, blob: Blob): Promise<Decision> {
    let reason: string | null;
    try {
      const { video } = await demuxMp4(blob);
      if (!video) return { key: null };
      reason = await videoDecodeProblem(video);
    } catch {
      return { key: null }; // not an MP4 we can read: the engine's own error applies, as before
    }
    return reason ? convert(entry, blob, reason) : { key: null };
  }

  library.setByteFilter(async (entry, blob) => {
    if (entry.type !== "video") return blob;
    const id = entry.source.kind === "project" ? entry.source.relativePath : entry.id;
    let decision = decisions.get(id);
    if (!decision) {
      decision = decide(entry, blob);
      decisions.set(id, decision);
    }
    const { key } = await decision;
    if (!key) return blob;
    return new Blob([await invoke<ArrayBuffer>("media_proxy_read", { key })], { type: "video/mp4" });
  });

  // On import rather than on first play: a freshly imported clip's bytes are in memory.
  const seen = new Set<string>();
  library.subscribe(() => {
    for (const e of library.getSnapshot().entries) {
      if (e.type !== "video" || e.generationStatus !== undefined || e.source.kind !== "project" || seen.has(e.id)) continue;
      const bytes = library.bytesFor(e);
      if (!bytes) continue;
      seen.add(e.id);
      void library.byteSource.open(e.id).catch(() => {});
    }
  });
}
