// The same window.desktop* objects as apps/desktop/src/preload/index.cjs, over Tauri IPC, so the
// renderer's gateways run unchanged. test/bridge-parity.test.ts checks this against the preload and
// against the Rust command list. Anything not ported must reject with a clear error here.
//
// Binary data travels as a raw IPC body, with its metadata in percent-encoded headers. Raw responses
// arrive as an ArrayBuffer.

import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { chooseExportPreset } from "./export-preset-host.js";
import { attachVideoProxy } from "./video-proxy.js";

const enc = encodeURIComponent;


// For commands that answer with raw bytes: a rejection is the {error} shape the renderer expects.
async function softBytes<K extends string>(key: K, run: () => Promise<ArrayBuffer>): Promise<Record<K, ArrayBuffer> | { error: string }> {
  try {
    return { [key]: await run() } as Record<K, ArrayBuffer>;
  } catch (e) {
    return { error: String(e) };
  }
}

function asBody(bytes: ArrayBuffer | Uint8Array): Uint8Array {
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

function platform(): string {
  const ua = navigator.userAgent;
  if (/Macintosh|Mac OS X/.test(ua)) return "darwin";
  if (/Windows/.test(ua)) return "win32";
  return "linux";
}

// ── Export ───────────────────────────────────────────────────────────────────
// A chain, because concurrent invokes aren't ordered and frames must reach ffmpeg in order. The
// promise each call returns resolves when that frame has been written, which is the backpressure.

let exportChain: Promise<void> = Promise.resolve();
let exportFailure: unknown = null;

function exportEnqueue(run: () => Promise<void>): Promise<void> {
  exportChain = exportChain.then(() => (exportFailure ? undefined : run())).catch((e) => {
    exportFailure ??= e;
  });
  return exportChain;
}

const desktopExport = {
  start: (opts: unknown) => {
    exportChain = Promise.resolve();
    exportFailure = null;
    return invoke<string>("export_session_start", { opts });
  },
  videoFrame: (buf: Uint8Array) => exportEnqueue(() => invoke("export_video_frame", buf)),
  audioData: (buf: Uint8Array) => exportEnqueue(() => invoke("export_audio_data", buf)),
  abort: async () => {
    await exportChain;
    exportFailure = null;
    await invoke("export_session_abort");
  },
  finish: async () => {
    await exportChain;
    const failure = exportFailure;
    exportFailure = null;
    try {
      const out = await invoke<string>("export_session_finish");
      if (failure) throw failure;
      return out;
    } catch (e) {
      // ffmpeg's own error from the first failed frame says more than the broken pipe after it.
      throw failure ?? e;
    }
  },
};

// ── AI ───────────────────────────────────────────────────────────────────────

type Chunk = { id: string; data?: Uint8Array; done?: boolean; error?: string };
const chunkListeners = new Set<(m: Chunk) => void>();
const emitChunk = (m: Chunk) => {
  for (const l of [...chunkListeners]) l(m);
};

const desktopAI = {
  setKey: (key: string, provider?: string) => invoke<void>("ai_set_key", { key, provider }),
  hasKey: (provider?: string) => invoke<boolean>("ai_has_key", { provider }),
  clearKey: (provider?: string) => invoke<void>("ai_clear_key", { provider }),
  streamChat: (id: string, body: object) => {
    const channel = new Channel<ArrayBuffer | { done?: boolean; error?: string }>();
    channel.onmessage = (m) => {
      if (m instanceof ArrayBuffer) emitChunk({ id, data: new Uint8Array(m) });
      else emitChunk({ id, ...m });
    };
    invoke("ai_stream_chat", { body, channel }).catch((e) => emitChunk({ id, error: String(e) }));
  },
  onChunk: (cb: (m: Chunk) => void) => {
    chunkListeners.add(cb);
    return () => {
      chunkListeners.delete(cb);
    };
  },
  generateImage: (body: object) => invoke<unknown>("ai_generate_image", { body }),
};

// ── Generation ───────────────────────────────────────────────────────────────

const desktopGen = {
  falSubmit: (modelEndpoint: string, input: unknown) => invoke("gen_fal_submit", { modelEndpoint, input }),
  falStatus: (modelEndpoint: string, jobId: string) => invoke("gen_fal_status", { modelEndpoint, jobId }),
  falDownload: (url: string) => softBytes("data", () => invoke<ArrayBuffer>("gen_fal_download", { url })),
  falUpload: (bytes: ArrayBuffer, contentType: string, fileName: string) =>
    invoke("gen_fal_upload", asBody(bytes), { headers: { "x-content-type": enc(contentType), "x-file-name": enc(fileName) } }),
};

// ── Media ────────────────────────────────────────────────────────────────────

const desktopMedia = {
  extractAudio: async (opts: { path?: string; bytes?: ArrayBuffer }) => {
    if ((opts.path == null) === (opts.bytes == null)) return { error: "media:extractAudio requires exactly one of path or bytes" };
    try {
      const wav = opts.path != null ? await invoke<ArrayBuffer>("media_extract_audio_path", { path: opts.path }) : await invoke<ArrayBuffer>("media_extract_audio_bytes", asBody(opts.bytes!));
      return { wav, durationSeconds: Math.max(0, (wav.byteLength - 44) / (16000 * 2)) };
    } catch (e) {
      return { error: String(e) };
    }
  },
  importScan: (dir: string, absPath: string) => invoke("media_import_scan", { dir, absPath }),
  importCopy: (dir: string, absPath: string, relPath: string) => invoke("media_import_copy", { dir, absPath, relPath }),
  importDownload: (dir: string, url: string, relPath: string) => invoke("media_import_download", { dir, url, relPath }),
  readTimecode: (paths: string[]) => invoke("media_read_timecode", { paths }),
  readLocalFile: (absPath: string) => softBytes("bytes", () => invoke<ArrayBuffer>("media_read_local_file", { absPath })),
};

// ── MCP ──────────────────────────────────────────────────────────────────────

let mcpUnlisten: Promise<UnlistenFn> | null = null;

const desktopMcp = {
  setEnabled: (on: boolean) => invoke("mcp_set_enabled", { on }),
  getStatus: () => invoke("mcp_get_status"),
  regenerateToken: () => invoke<string>("mcp_regenerate_token"),
  onBridgeRequest: (cb: (msg: unknown) => void) => {
    void mcpUnlisten?.then((u) => u());
    mcpUnlisten = listen("mcp:request", (e) => cb(e.payload));
  },
  bridgeRespond: (id: number, payload: { result?: unknown; error?: string }) => {
    void invoke("mcp_response", { id, result: payload.result, error: payload.error });
  },
};

// ── Project navigation ───────────────────────────────────────────────────────

const desktopProjectNav = {
  list: () => invoke("projects_list"),
  resolve: (id: string) => invoke("projects_resolve", { id }),
  create: (name: string) => invoke("projects_create", { name }),
  upsert: (projectPath: string, name: string) => invoke("projects_upsert", { path: projectPath, name }),
  authorizePath: (p: string, nonce: string | null) => invoke("project_authorize_path", { p, nonce }),
  cleanupFailedCreate: (p: string) => invoke("projects_cleanup_failed_create", { p }),
};

// ── Skills and characters ────────────────────────────────────────────────────

const desktopSkills = {
  list: () => invoke("skills_list"),
  read: (id: string) => invoke("skills_read", { id }),
  write: (id: string, text: string) => invoke("skills_write", { id, text }),
  remove: (id: string) => invoke("skills_remove", { id }),
  readLedger: () => invoke("skills_read_ledger"),
  writeLedger: (ledger: unknown) => invoke("skills_write_ledger", { ledger }),
  reveal: (id: string) => invoke("skills_reveal", { id }),
  openRoot: () => invoke("skills_open_root"),
  exportToAgent: (id: string, agent: string) => invoke("skills_export_to_agent", { id, agent }),
  cacheRead: () => invoke("skills_cache_read"),
  cacheWrite: (text: string) => invoke("skills_cache_write", { text }),
};

const desktopCharacters = {
  listIds: () => invoke("characters_list_ids"),
  readFile: async (id: string, name: string) => {
    const r = await invoke<ArrayBuffer | null>("characters_read_file", { id, name });
    return r === null ? null : new Uint8Array(r);
  },
  writeFile: (id: string, name: string, bytes: Uint8Array) => invoke("characters_write_file", bytes, { headers: { "x-id": enc(id), "x-name": enc(name) } }),
  remove: (id: string) => invoke("characters_remove", { id }),
};

// ── Studio ───────────────────────────────────────────────────────────────────

const desktopStudio = {
  claudeRun: (req: unknown) => invoke("claude_run", { req }),
  // Body: u32 LE metadata length, metadata JSON, then each image's bytes in order.
  writeFlowPack: (pack: { folderName: string; files?: { name: string; text: string }[]; images?: { name: string; bytes: ArrayBuffer }[] }) => {
    const images = pack.images ?? [];
    const meta = new TextEncoder().encode(JSON.stringify({ folderName: pack.folderName, files: pack.files ?? [], images: images.map((i) => ({ name: i.name, size: i.bytes.byteLength })) }));
    const total = 4 + meta.length + images.reduce((n, i) => n + i.bytes.byteLength, 0);
    const body = new Uint8Array(total);
    new DataView(body.buffer).setUint32(0, meta.length, true);
    body.set(meta, 4);
    let at = 4 + meta.length;
    for (const i of images) {
      body.set(new Uint8Array(i.bytes), at);
      at += i.bytes.byteLength;
    }
    return invoke("studio_write_flow_pack", body);
  },
  sampleFrames: (req: unknown) => invoke("media_sample_frames", { req }),
};

// ── Morphic ──────────────────────────────────────────────────────────────────

const desktopMorphic = {
  status: () => invoke("morphic_status"),
  signIn: () => invoke("morphic_sign_in"),
  signOut: () => invoke("morphic_sign_out"),
  callTool: (name: string, args?: unknown) => invoke("morphic_call_tool", { name, args }),
  upload: (bytes: ArrayBuffer, contentType: string, fileName: string, projectId?: string) =>
    invoke("morphic_upload", asBody(bytes), { headers: { "x-content-type": enc(contentType), "x-file-name": enc(fileName), ...(projectId ? { "x-project-id": enc(projectId) } : {}) } }),
  download: (url: string) => softBytes("data", () => invoke<ArrayBuffer>("morphic_download", { url })),
};

// ── Project ──────────────────────────────────────────────────────────────────

let menuUnlisten: Promise<UnlistenFn> | null = null;
let menuCallback: ((cmd: string, arg?: unknown) => void) | null = null;

const testBuild = (window as unknown as { __FRONTSTAGE_SMOKE__?: boolean }).__FRONTSTAGE_SMOKE__ === true;

const desktopProject = {
  pickOpen: () => invoke<string | null>("project_pick_open"),
  pickSaveAs: (name: string) => invoke<string | null>("project_pick_save_as", { name }),
  pickExportSave: (suggestedName: string, filter?: unknown) => invoke<string | null>("project_pick_export_save", { suggestedName, filter }),
  choosePreset: chooseExportPreset,
  writeExportText: (outPath: string, contents: string, overwrite?: boolean) => invoke<string>("project_write_export_text", { outPath, contents, overwrite }),
  readText: (dir: string, name: string) => invoke<string | null>("project_read_text", { dir, name }),
  writeText: (dir: string, name: string, data: string) => invoke<void>("project_write_text", { dir, name, data }),
  writeMedia: (dir: string, rel: string, bytes: Uint8Array) => invoke<void>("project_write_media", bytes, { headers: { "x-dir": enc(dir), "x-rel": enc(rel) } }),
  readMedia: async (dir: string, rel: string) => new Uint8Array(await invoke<ArrayBuffer>("project_read_media", { dir, rel })),
  hasMedia: (dir: string, rel: string) => invoke<boolean>("project_has_media", { dir, rel }),
  listRecent: () => invoke("project_list_recent"),
  addRecent: (rec: unknown) => invoke<void>("project_add_recent", { rec }),
  removeRecent: (id: string) => invoke<void>("project_remove_recent", { id }),
  __setNextPick: (p: string) => invoke<void>("project_set_next_pick", { p }),
  ...(testBuild ? { __setNextExportPick: (p: string) => invoke<void>("project_set_next_export_pick", { p }) } : {}),
  onMenuCommand: (cb: (cmd: string, arg?: unknown) => void) => {
    menuCallback = cb;
    void menuUnlisten?.then((u) => u());
    menuUnlisten = listen<{ command: string; arg: unknown }>("menu:command", (e) => cb(e.payload.command, e.payload.arg ?? undefined));
  },
  platform: platform(),
};

// spike:encode-frame was Electron's first bring-up test and nothing in the editor calls it.
const desktopSpike = {
  encodeFrame: () => Promise.reject(new Error("desktopSpike.encodeFrame isn't available in this app: the spike:encode-frame channel wasn't ported")),
};

Object.assign(window, {
  desktopExport,
  desktopAI,
  desktopGen,
  desktopMedia,
  desktopMcp,
  desktopProjectNav,
  desktopSkills,
  desktopCharacters,
  desktopStudio,
  desktopMorphic,
  desktopProject,
  desktopSpike,
  desktopVideoProxy: { attach: attachVideoProxy },
  ...(testBuild ? { __e2eMenuTrigger: { fire: (cmd: string, arg?: unknown) => menuCallback?.(cmd, arg) } } : {}),
});

