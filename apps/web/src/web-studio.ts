import type { ClaudeGateway, ClaudeStudioRequest, ClaudeStudioResult, MorphicBridge, MorphicToolResult, SampledFrame } from "@frontstage/ai";
import type { FrameSampler } from "@frontstage/ui";
import type { UserKeys } from "./relay-config.js";

// Claude writing in the web editor. Proxy mode: the self-host proxy holds ANTHROPIC_API_KEY.
// Relay mode: the user's own key (browser storage) rides X-Anthropic-Key, same as the fal key.
export type WebClaudeConfig = { mode: "proxy"; proxyUrl: string; proxyToken?: string } | { mode: "relay"; origin: string; getKeys: () => UserKeys };

export class WebClaudeGateway implements ClaudeGateway {
  constructor(private readonly cfg: WebClaudeConfig) {}

  private base(): string {
    return this.cfg.mode === "relay" ? `${this.cfg.origin}/api` : this.cfg.proxyUrl;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.cfg.mode === "relay") {
      const key = this.cfg.getKeys().anthropicKey;
      if (key) h["X-Anthropic-Key"] = key;
    } else if (this.cfg.proxyToken) {
      h["Authorization"] = "Bearer " + this.cfg.proxyToken;
    }
    return h;
  }

  async hasKey(): Promise<boolean> {
    if (this.cfg.mode === "relay") return Boolean(this.cfg.getKeys().anthropicKey);
    try {
      const res = await fetch(this.base() + "/anthropic/enabled", { headers: this.headers() });
      return res.ok && ((await res.json()) as { enabled?: boolean }).enabled === true;
    } catch {
      return false;
    }
  }

  async run(req: ClaudeStudioRequest): Promise<ClaudeStudioResult> {
    try {
      const res = await fetch(this.base() + "/anthropic/run", {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(req),
        ...(this.cfg.mode === "relay" ? { credentials: "include" as const } : {}),
      });
      const body = (await res.json().catch(() => null)) as ClaudeStudioResult | null;
      if (body && typeof body === "object" && "ok" in body) return body;
      return { ok: false, kind: "api", error: `Claude request failed (HTTP ${res.status})` };
    } catch (e) {
      return { ok: false, kind: "api", error: `Could not reach the server: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
}

/**
 * Choreography frames in the browser: seek a <video> through the reference and draw each frame to
 * a canvas as JPEG (768 px wide). Needs a codec the browser can decode (H.264 in Chrome/Edge/Safari).
 */
export function makeWebFrameSampler(readBytes: (mediaId: string) => Promise<Uint8Array>): FrameSampler {
  return async (mediaId, fps, maxFrames) => {
    let url: string | null = null;
    try {
      url = URL.createObjectURL(new Blob([(await readBytes(mediaId)) as BlobPart], { type: "video/mp4" }));
      const video = document.createElement("video");
      video.muted = true;
      video.preload = "auto";
      video.src = url;
      await new Promise<void>((resolve, reject) => {
        video.onloadedmetadata = () => resolve();
        video.onerror = () => reject(new Error("this browser can't decode the reference video"));
      });
      const width = 768;
      const height = Math.round((video.videoHeight / Math.max(1, video.videoWidth)) * width);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d")!;
      const frames: SampledFrame[] = [];
      for (let i = 0; i < maxFrames; i++) {
        const t = i / fps;
        if (t > video.duration) break;
        await new Promise<void>((resolve) => {
          video.onseeked = () => resolve();
          video.currentTime = Math.min(t, Math.max(0, video.duration - 0.01));
        });
        ctx.drawImage(video, 0, 0, width, height);
        frames.push({ timeSec: t, mediaType: "image/jpeg", base64: canvas.toDataURL("image/jpeg", 0.8).split(",")[1]! });
      }
      if (frames.length === 0) return { error: "no frames could be read from this video" };
      return { frames };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    } finally {
      if (url) URL.revokeObjectURL(url);
    }
  };
}

/**
 * Morphic in the web editor, through the self-host proxy (MORPHIC=1), which is the MCP client:
 * browsers can't call Morphic's server directly (no CORS). Sign-in opens Morphic's page in a new
 * tab and waits until the proxy reports the session; results download through /import/download.
 */
export class WebMorphicBridge implements MorphicBridge {
  constructor(private readonly proxyUrl: () => string, private readonly proxyToken?: string) {}

  private headers(json = true): Record<string, string> {
    const h: Record<string, string> = json ? { "Content-Type": "application/json" } : {};
    if (this.proxyToken) h["Authorization"] = "Bearer " + this.proxyToken;
    return h;
  }

  private async post<T>(route: string, body?: unknown): Promise<T> {
    const res = await fetch(this.proxyUrl() + route, { method: "POST", headers: this.headers(), body: body === undefined ? undefined : JSON.stringify(body) });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(data.error ?? `Morphic proxy error ${res.status}`);
    return data;
  }

  /** False when the proxy doesn't run with MORPHIC=1 (route missing). */
  async available(): Promise<boolean> {
    try {
      const res = await fetch(this.proxyUrl() + "/morphic/status", { headers: this.headers(false) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async isSignedIn(): Promise<boolean> {
    try {
      const res = await fetch(this.proxyUrl() + "/morphic/status", { headers: this.headers(false) });
      return res.ok && ((await res.json()) as { signedIn?: boolean }).signedIn === true;
    } catch {
      return false;
    }
  }

  async signIn(): Promise<void> {
    const r = await this.post<{ authorizationUrl?: string; signedIn?: boolean; error?: string }>("/morphic/sign-in");
    if (r.error) throw new Error(r.error);
    if (r.signedIn) return;
    if (r.authorizationUrl) window.open(r.authorizationUrl, "_blank", "noopener");
    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 2000));
      const s = await fetch(this.proxyUrl() + "/morphic/status", { headers: this.headers(false) }).then((x) => x.json() as Promise<{ signedIn?: boolean; lastError?: string | null }>);
      if (s.signedIn) return;
      if (s.lastError) throw new Error(s.lastError);
    }
    throw new Error("Morphic sign-in timed out");
  }

  async signOut(): Promise<void> {
    await this.post("/morphic/sign-out");
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<MorphicToolResult> {
    return (await this.post<{ result: MorphicToolResult }>("/morphic/call", { name, args })).result;
  }

  async uploadFile(bytes: Uint8Array, contentType: string, fileName: string, projectId?: string): Promise<string> {
    const q = new URLSearchParams({ contentType, fileName, ...(projectId ? { projectId } : {}) });
    const res = await fetch(`${this.proxyUrl()}/morphic/upload?${q}`, { method: "POST", headers: this.headers(false), body: bytes as BodyInit });
    const data = (await res.json().catch(() => ({}))) as { assetId?: string; error?: string };
    if (!res.ok || !data.assetId) throw new Error(data.error ?? `Morphic upload failed (${res.status})`);
    return data.assetId;
  }

  async download(url: string): Promise<Uint8Array> {
    const res = await fetch(this.proxyUrl() + "/import/download", { method: "POST", headers: this.headers(), body: JSON.stringify({ url }) });
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  }
}
