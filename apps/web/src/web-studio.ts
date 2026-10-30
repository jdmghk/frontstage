import type { ClaudeGateway, ClaudeStudioRequest, ClaudeStudioResult, SampledFrame } from "@frontstage/ai";
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
