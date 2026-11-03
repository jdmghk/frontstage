// Test builds only: drives the real editor in the hidden WKWebView and reports to Rust. Playwright
// can't reach WKWebView. Inspect the result with scripts/smoke.sh, which also checks the MP4s.
import { invoke } from "@tauri-apps/api/core";

type Clip = { name: string; file: string; expectProxy: boolean; w: number; h: number };
type Store = { load(t: unknown): void; getSnapshot(): { timeline: { tracks: unknown[] } } };
type Lib = {
  getSnapshot(): { entries: { id: string; name: string; generationStatus?: string; source: { relativePath: string }; hasAudio?: boolean; sourceWidth?: number }[] };
};
type Session = { getState(): { ref: { path: string } | null; name: string }; isDirty(): boolean };

const w = window as unknown as Record<string, unknown> & typeof window;
const results: Record<string, unknown> = { csp: [], errors: [] };
const errors = results.errors as string[];
const csp = results.csp as string[];
window.addEventListener("securitypolicyviolation", (e) => csp.push(`${e.violatedDirective} ${e.blockedURI}`));
window.addEventListener("error", (e) => errors.push(`error: ${e.message}`));
window.addEventListener("unhandledrejection", (e) => errors.push(`rejection: ${String(e.reason)}`));
const consoleError = console.error;
console.error = (...a: unknown[]) => {
  errors.push(`console: ${a.map(String).join(" ")}`.slice(0, 400));
  consoleError(...a);
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (name: string, value: unknown) => invoke("progress", { name, value: JSON.stringify(value) });

async function until<T>(what: string, fn: () => T | Promise<T>, ms = 120_000): Promise<NonNullable<T>> {
  const end = performance.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (performance.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

async function step(name: string, fn: () => Promise<unknown>): Promise<unknown> {
  const t0 = performance.now();
  let out: unknown;
  try {
    out = { ok: true, value: await fn(), ms: Math.round(performance.now() - t0) };
  } catch (e) {
    out = { ok: false, error: String(e), ms: Math.round(performance.now() - t0) };
  }
  results[name] = out;
  await log(name, out);
  return out;
}

const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const file = (name: string) => invoke<ArrayBuffer>("spike_file", { name });
const fire = (cmd: string, arg?: unknown) => (w.__e2eMenuTrigger as { fire(c: string, a?: unknown): void }).fire(cmd, arg);
const dp = () => w.desktopProject as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
const lib = () => w.__mediaLibrary as Lib;
const store = () => w.__frontstageStore as Store;
const session = () => w.__projectSession as Session;

async function importClip(c: Clip) {
  const before = new Set(lib().getSnapshot().entries.map((e) => e.id));
  const input = await until("file input", () => document.querySelector<HTMLInputElement>('[data-testid="media-panel"] input[type="file"]'));
  const dt = new DataTransfer();
  dt.items.add(new File([await file(c.file)], c.file, { type: "video/mp4" }));
  input.files = dt.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return until(`import of ${c.file}`, () => lib().getSnapshot().entries.find((e) => !before.has(e.id) && e.generationStatus === undefined));
}

function timelineWith(mediaRef: string, W: number, H: number, frames: number, withAudio = false) {
  const clip = (type: "video" | "audio") => ({
    id: `c-${type}`,
    mediaRef,
    mediaType: type,
    sourceClipType: "video",
    startFrame: 0,
    durationFrames: frames,
    trimStartFrame: 0,
    trimEndFrame: 0,
    speed: 1,
    volume: 1,
    fadeInFrames: 0,
    fadeOutFrames: 0,
    fadeInInterpolation: "linear",
    fadeOutInterpolation: "linear",
    opacity: 1,
    transform: { centerX: 0.5, centerY: 0.5, width: 1, height: 1, rotation: 0, flipHorizontal: false, flipVertical: false },
    crop: { left: 0, top: 0, right: 0, bottom: 0 },
  });
  const track = (type: "video" | "audio") => ({ id: `t-${type}`, type, muted: false, hidden: false, syncLocked: false, clips: [clip(type)] });
  return {
    fps: 30,
    width: W,
    height: H,
    settingsConfigured: true,
    tracks: withAudio ? [track("video"), track("audio")] : [track("video")],
  };
}

async function exportTo(path: string) {
  await dp().__setNextExportPick!(path);
  fire("export", "video");
  const dialog = await until("preset dialog", () => q("export-preset-dialog"), 30_000);
  const text = dialog.textContent ?? "";
  q("export-preset-continue")!.click();
  await until("export start", () => q("export-progress"), 30_000).catch(() => null);
  await until("export end", () => !q("export-progress"), 300_000);
  return { presetDialogSaid: text.slice(0, 120) };
}

const opts = await invoke<{ dir: string; clips: Clip[] }>("spike_file", { name: "smoke-plan.json" }).then((b) => JSON.parse(new TextDecoder().decode(b as unknown as ArrayBuffer)) as { dir: string; clips: Clip[] });
const projectDir = `${opts.dir}/project`;

await step("env", async () => ({
  ua: navigator.userAgent,
  crossOriginIsolated,
  origin: location.origin,
  gpu: "gpu" in navigator,
  AudioDecoder: typeof (w as unknown as { AudioDecoder?: unknown }).AudioDecoder,
  tools: await invoke("app_tools_status"),
  // What the minimum macOS version rests on, measured in this WKWebView.
  required: {
    VideoDecoder: typeof VideoDecoder,
    VideoFrameCopyTo: typeof VideoFrame !== "undefined" && typeof VideoFrame.prototype.copyTo,
    OffscreenCanvas2d: typeof OffscreenCanvas !== "undefined" && !!new OffscreenCanvas(1, 1).getContext("2d"),
    OffscreenCanvasWebgl2: typeof OffscreenCanvas !== "undefined" && !!new OffscreenCanvas(1, 1).getContext("webgl2"),
    AudioWorklet: typeof AudioWorkletNode,
    WebGL2: !!document.createElement("canvas").getContext("webgl2"),
    h264Baseline: (await VideoDecoder.isConfigSupported({ codec: "avc1.42E01E" }).catch(() => null))?.supported ?? null,
  },
}));

await step("editor_mounted", () => until("top bar", () => q("top-bar-title")?.textContent ?? ""));

await step("import_clip", async () => {
  const plain = opts.clips[0]!;
  const e = await importClip(plain);
  store().load(timelineWith(e.id, plain.w, plain.h, 45, true));
  return { id: e.id, rel: e.source.relativePath, hasAudio: e.hasAudio, width: e.sourceWidth };
});

await step("save_as_project", async () => {
  await dp().__setNextPick!(projectDir);
  fire("save-as");
  await until("saved", () => session().getState().ref?.path === projectDir && !session().isDirty());
  const rel = lib().getSnapshot().entries[0]!.source.relativePath;
  return { mediaOnDisk: await dp().hasMedia!(projectDir, rel), name: session().getState().name };
});

await step("reopen_project", async () => {
  fire("new");
  await until("new project", () => !session().getState().ref);
  await dp().__setNextPick!(projectDir);
  fire("open");
  await until("reopened", () => session().getState().ref?.path === projectDir);
  await until("media loaded", () => lib().getSnapshot().entries.length > 0);
  return { entries: lib().getSnapshot().entries.length, tracks: store().getSnapshot().timeline.tracks.length };
});

await step("play", async () => {
  const time = () => q("transport-time")?.textContent ?? "";
  const start = time();
  await until("transport", () => q("transport-playpause"), 30_000);
  q("transport-playpause")!.click();
  await until("time to advance", () => time() !== start, 60_000);
  await sleep(1500);
  const playing = time();
  q("transport-playpause")!.click();
  return { start, playing };
});

await step("export_plain_with_audio", () => exportTo(`${opts.dir}/out/${opts.clips[0]!.file}`));

// Each clip WebKit can't decode: import, see the message, and export it through the engine.
for (const c of opts.clips.slice(1)) {
  await step(`proxy_${c.name}`, async () => {
    const seenMessages = new Set<string>();
    const watch = setInterval(() => {
      for (const id of ["video-proxy-converting", "video-proxy-done", "video-proxy-failed"]) {
        const t = q(id)?.textContent;
        if (t) seenMessages.add(t);
      }
    }, 50);
    const e = await importClip(c);
    store().load(timelineWith(e.id, c.w, c.h, 15));
    if (c.expectProxy) await until("conversion message", () => q("video-proxy-done") ?? q("video-proxy-failed"), 240_000);
    await sleep(100);
    const manifestRel = e.source.relativePath;
    const ex = await exportTo(`${opts.dir}/out/${c.file}`);
    clearInterval(watch);
    const failed = q("video-proxy-failed")?.textContent;
    q("video-proxy-failed-dismiss")?.click();
    return { manifestRel, messages: [...seenMessages], failed, ...ex };
  });
}

// The project still holds the source's own bytes, and the same clip reaches the proxy again by path
// after a reopen, instead of by in-memory bytes.
await step("original_kept_and_proxy_after_reopen", async () => {
  const hevc = opts.clips.find((c) => c.name === "hevc")!;
  const entry = lib().getSnapshot().entries.find((e) => e.name === hevc.file)!;
  await invoke("smoke_menu", { id: "save" });
  await until("saved through the menu event", () => !session().isDirty());
  const rel = entry.source.relativePath;
  const saved = (await dp().readMedia!(projectDir, rel)) as Uint8Array;
  const source = new Uint8Array(await file(hevc.file));
  const identical = saved.length === source.length && saved.every((b, i) => b === source[i]);
  fire("new");
  await until("new project", () => !session().getState().ref);
  await dp().__setNextPick!(projectDir);
  fire("open");
  await until("reopened", () => session().getState().ref?.path === projectDir);
  await until("media loaded", () => lib().getSnapshot().entries.some((e) => e.source.relativePath === rel));
  const after = lib().getSnapshot().entries.find((e) => e.source.relativePath === rel)!;
  store().load(timelineWith(after.id, hevc.w, hevc.h, 15));
  await exportTo(`${opts.dir}/out/hevc-reopened.mp4`);
  return { rel, identical, bytes: saved.length, sourceWidth: after.sourceWidth };
});

// ── Every other channel, through the real bridge ──
await step("project_negative", async () => {
  const refused = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      return "NOT REFUSED";
    } catch (e) {
      return String(e);
    }
  };
  const nav = w.desktopProjectNav as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  return {
    readOutside: await refused(() => dp().readText!("/etc", "passwd")),
    traversal: await refused(() => dp().readText!(projectDir, "../../etc/passwd")),
    writeOutside: await refused(() => dp().writeMedia!("/tmp/frontstage-nope", "x", new Uint8Array([1]))),
    authorizeNoNonce: await nav.authorizePath!(opts.dir, null),
    spikeRemoved: await refused(() => (w.desktopSpike as { encodeFrame(): Promise<unknown> }).encodeFrame()),
  };
});

await step("project_misc", async () => {
  const out = await dp().writeExportText!(`${projectDir}/x.xml`, "<x/>", true);
  let overwrite = "";
  try {
    await dp().writeExportText!(`${projectDir}/x.xml`, "<y/>", false);
  } catch (e) {
    overwrite = String(e);
  }
  const rec = { id: "smoke", name: "Smoke", path: projectDir };
  await dp().addRecent!(rec);
  const recent = await dp().listRecent!();
  await dp().removeRecent!("smoke");
  return { out, overwrite, recent, after: await dp().listRecent!() };
});

await step("project_nav", async () => {
  const nav = w.desktopProjectNav as unknown as Record<string, (...a: unknown[]) => Promise<Record<string, string>>>;
  const made = await nav.create!("Smoke Created");
  const up = await nav.upsert!(made.path, "Smoke Created");
  const resolved = await nav.resolve!(up.id);
  const list = await nav.list!();
  return { made, resolved, list, bad: await nav.create!("../evil"), cleanup: await nav.cleanupFailedCreate!(made.path), refused: await nav.cleanupFailedCreate!("/tmp") };
});

await step("media_channels", async () => {
  const m = w.desktopMedia as unknown as Record<string, (...a: unknown[]) => Promise<Record<string, unknown>>>;
  const src = `${opts.dir}/media/${opts.clips[0]!.file}`;
  const scan = await m.importScan!(projectDir, src);
  const copy = await m.importCopy!(projectDir, src, "media/copied.mp4");
  const wavPath = await m.extractAudio!({ path: src });
  const wavBytes = await m.extractAudio!({ bytes: await file(opts.clips[0]!.file) });
  const frames = (await (w.desktopStudio as unknown as Record<string, (...a: unknown[]) => Promise<{ frames?: { timeSec: number; base64: string }[]; error?: string }>>).sampleFrames!({ path: src, fps: 2, width: 320, maxFrames: 3 })) as { frames?: { timeSec: number; base64: string }[]; error?: string };
  const lut = await m.readLocalFile!(`${opts.dir}/media/smoke.cube`);
  return {
    scan,
    copy,
    wavPathSec: wavPath.durationSeconds,
    wavIsBuffer: wavPath.wav instanceof ArrayBuffer,
    wavBytesSec: wavBytes.durationSeconds,
    frames: frames.frames?.map((f) => [f.timeSec, f.base64.slice(0, 4)]) ?? frames.error,
    timecode: await m.readTimecode!([src, 3]),
    lutBytes: (lut.bytes as ArrayBuffer)?.byteLength,
    lutRefused: await m.readLocalFile!("/etc/passwd"),
    downloadRefused: await m.importDownload!(projectDir, "https://169.254.169.254/x.mp4", "media/x.mp4"),
  };
});

await step("characters", async () => {
  const c = w.desktopCharacters as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  await c.writeFile!("kai", "ref.png", new Uint8Array([137, 80]));
  const read = (await c.readFile!("kai", "ref.png")) as Uint8Array;
  const missing = await c.readFile!("kai", "none.png");
  const ids = await c.listIds!();
  await c.remove!("kai");
  let traversal = "";
  try {
    await c.writeFile!("../x", "a", new Uint8Array([1]));
  } catch (e) {
    traversal = String(e);
  }
  return { read: [...read], isU8: read instanceof Uint8Array, missing, ids, after: await c.listIds!(), traversal };
});

await step("skills", async () => {
  const s = w.desktopSkills as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  await s.write!("smoke-skill", "---\nname: X\n---\nbody");
  const read = await s.read!("smoke-skill");
  const list = await s.list!();
  await s.writeLedger!({ a: "b" });
  const ledger = await s.readLedger!();
  const exported = await s.exportToAgent!("smoke-skill", "claude");
  await s.cacheWrite!("cached");
  const cache = await s.cacheRead!();
  await s.reveal!("smoke-skill");
  await s.openRoot!();
  await s.remove!("smoke-skill");
  return { read, list, ledger, exported, cache, after: await s.read!("smoke-skill") };
});

await step("flow_pack", async () => {
  await dp().__setNextPick!(`${opts.dir}/out`);
  const bytes = new Uint8Array([9, 8, 7]).buffer;
  return (w.desktopStudio as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>).writeFlowPack!({ folderName: "Pack", files: [{ name: "a.txt", text: "hi" }], images: [{ name: "b.png", bytes }] });
});

await step("secrets", async () => {
  const a = w.desktopAI as unknown as Record<string, (...x: unknown[]) => Promise<unknown>>;
  const before = await a.hasKey!("fal");
  await a.setKey!("smoke-fal-key", "fal");
  await a.setKey!("smoke-or-key");
  await a.setKey!("smoke-anthropic-key", "anthropic");
  return { before, after: await a.hasKey!("fal"), openrouter: await a.hasKey!(), anthropic: await a.hasKey!("anthropic") };
});

await step("ai_against_mock", async () => {
  const a = w.desktopAI as unknown as { generateImage(b: object): Promise<unknown>; streamChat(id: string, b: object): void; onChunk(cb: (m: { id: string; data?: Uint8Array; done?: boolean; error?: string }) => void): () => void };
  const image = await a.generateImage({ model: "m" });
  const text = await new Promise<string>((resolve, reject) => {
    let s = "";
    const off = a.onChunk((m) => {
      if (m.id !== "c1") return;
      if (m.error) reject(new Error(m.error));
      if (m.data) s += new TextDecoder().decode(m.data);
      if (m.done) {
        off();
        resolve(s);
      }
    });
    a.streamChat("c1", { model: "m", stream: true });
  });
  return { image, text };
});

await step("fal_against_mock", async () => {
  const g = w.desktopGen as unknown as Record<string, (...x: unknown[]) => Promise<unknown>>;
  return {
    submit: await g.falSubmit!("fal-ai/test/x", { prompt: "p" }),
    status: await g.falStatus!("fal-ai/test/x", "job-1"),
    uploadHostRefused: await g.falUpload!(new Uint8Array([1, 2]).buffer, "image/png", "a b.png"),
    downloadRefused: await g.falDownload!("https://169.254.169.254/x"),
  };
});

await step("claude_against_mock", async () => {
  const s = w.desktopStudio as unknown as { claudeRun(r: unknown): Promise<unknown> };
  const schema = { type: "object", properties: { script: { type: "string" } }, required: ["script"], additionalProperties: false };
  return {
    ok: await s.claudeRun({ model: "claude-opus-5-5", system: "s", prompt: "p", schema, effort: "high", maxTokens: 1000 }),
    refusedModel: await s.claudeRun({ model: "gpt", system: "s", prompt: "p", schema, effort: "high", maxTokens: 1000 }),
  };
});

await step("morphic_against_mock", async () => {
  const m = w.desktopMorphic as unknown as Record<string, (...x: unknown[]) => Promise<unknown>>;
  const before = await m.status!();
  const noTool = await m.callTool!("prepare_media_upload", {});
  const notSignedIn = await m.callTool!("list_projects", {});
  const signIn = await m.signIn!();
  const after = await m.status!();
  const call = await m.callTool!("list_projects", {});
  const upload = await m.upload!(new Uint8Array([1, 2, 3]).buffer, "image/png", "a b.png", "proj");
  const httpRefused = await m.download!("http://example.com/x");
  const ssrfRefused = await m.download!("https://169.254.169.254/x");
  await m.signOut!();
  return { before, noTool, notSignedIn, signIn, after, call, upload, httpRefused, ssrfRefused, final: await m.status!() };
});

await step("clear_keys", async () => {
  const a = w.desktopAI as unknown as Record<string, (...x: unknown[]) => Promise<unknown>>;
  await a.clearKey!("fal");
  await a.clearKey!();
  await a.clearKey!("anthropic");
  return { fal: await a.hasKey!("fal"), openrouter: await a.hasKey!(), anthropic: await a.hasKey!("anthropic") };
});

await step("mcp_through_the_real_renderer", async () => {
  const m = w.desktopMcp as unknown as Record<string, (...x: unknown[]) => Promise<Record<string, unknown>>>;
  const before = await m.getStatus!();
  const on = await m.setEnabled!(true);
  // A folder nothing has authorised: reading it is refused until a live MCP tool call opens it,
  // which is the nonce path. The bridge has no other way to authorise without a picker.
  const other = `${opts.dir}/media`;
  const readable = async () => dp().readText!(other, "smoke-plan.json").then(() => "readable", (e) => String(e));
  const beforeOpen = await readable();
  const probe = await invoke("smoke_mcp_probe", { projectDir: other });
  const afterOpen = await readable();
  const oldToken = (await m.getStatus!()).token;
  const newToken = await m.regenerateToken!();
  const off = await m.setEnabled!(false);
  return { before: { enabled: before.enabled, url: before.url }, on, probe, beforeOpen, afterOpen, tokenChanged: oldToken !== (newToken as unknown as string), off };
});

await step("js_dialogs", async () => {
  const c = window.confirm("smoke confirm");
  const p = window.prompt("smoke prompt", "x");
  window.alert("smoke alert");
  return { confirm: c, prompt: p, log: await invoke("smoke_js_dialog_log") };
});

await step("legacy_notice", async () => ({ shown: !!q("legacy-secrets-notice"), text: q("legacy-secrets-notice")?.textContent }));

await invoke("report", { json: JSON.stringify(results, null, 1) });
