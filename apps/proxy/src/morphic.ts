// Morphic for the web editor through the self-host proxy. Browsers can't call Morphic's MCP server
// (no CORS), so this proxy is the MCP client, reusing the desktop app's tested module
// (apps/desktop/src/main/morphic-client.mjs). Sign-in returns Morphic's authorization URL for the
// browser to open; the OAuth redirect is the registered loopback http://127.0.0.1:53917, so the
// proxy must run on the same computer as the browser. Tokens are kept in a 0600 file.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type MorphicModule = {
  createMorphicClient(opts: { store: TokenStore; openBrowser: (url: string) => Promise<void> }): MorphicClient;
  RENDERER_TOOLS: Set<string>;
};
interface TokenStore {
  load(): { tokens?: unknown } | null;
  save(v: unknown): void;
  clear(): void;
}
interface MorphicClient {
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  isSignedIn(): boolean;
  callTool(name: string, args: Record<string, unknown>): Promise<{ structuredContent?: unknown; content?: unknown; isError?: boolean }>;
  uploadFile(bytes: Uint8Array, contentType: string, fileName: string, projectId?: string): Promise<string>;
}

// A non-literal specifier keeps tsc from resolving the .mjs; Node resolves its SDK dependency from
// the desktop package's node_modules.
const MODULE_PATH = new URL("../../desktop/src/main/morphic-client.mjs", import.meta.url).href;

export function fileTokenStore(file: string): TokenStore {
  return {
    load() {
      try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        return null;
      }
    },
    save(v) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(v), { mode: 0o600 });
    },
    clear() {
      try {
        fs.unlinkSync(file);
      } catch {
        /* already gone */
      }
    },
  };
}

export function defaultTokenFile(): string {
  return process.env["MORPHIC_TOKEN_FILE"] ?? path.join(os.homedir(), ".frontstage", "morphic-proxy-tokens.json");
}

/** One Morphic session per proxy process; sign-in hands its authorization URL back to the caller. */
export class MorphicProxy {
  private mod: MorphicModule | null = null;
  private client: MorphicClient | null = null;
  private onAuthUrl: ((url: string) => void) | null = null;
  lastSignInError: string | null = null;

  constructor(
    private readonly store: TokenStore,
    private readonly load: () => Promise<MorphicModule> = async () => (await import(MODULE_PATH)) as MorphicModule,
  ) {}

  private async ensure(): Promise<{ mod: MorphicModule; client: MorphicClient }> {
    if (!this.mod) this.mod = await this.load();
    if (!this.client) {
      this.client = this.mod.createMorphicClient({
        store: this.store,
        openBrowser: async (url) => this.onAuthUrl?.(url),
      });
    }
    return { mod: this.mod, client: this.client };
  }

  isSignedIn(): boolean {
    return !!this.store.load()?.tokens;
  }

  /** Starts sign-in; resolves with the URL the browser should open (or signedIn if already done). */
  async startSignIn(): Promise<{ authorizationUrl: string } | { signedIn: true } | { error: string }> {
    const { client } = await this.ensure();
    this.lastSignInError = null;
    const url = new Promise<string>((resolve) => (this.onAuthUrl = resolve));
    const done = client.signIn().then(
      () => ({ signedIn: true as const }),
      (e: unknown) => {
        this.lastSignInError = e instanceof Error ? e.message : String(e);
        return { error: this.lastSignInError };
      },
    );
    return Promise.race([url.then((authorizationUrl) => ({ authorizationUrl })), done]);
  }

  async signOut(): Promise<void> {
    const { client } = await this.ensure();
    await client.signOut();
  }

  async call(name: string, args: Record<string, unknown>) {
    const { mod, client } = await this.ensure();
    if (!mod.RENDERER_TOOLS.has(name)) throw Object.assign(new Error(`Morphic tool not allowed: ${name}`), { status: 400 });
    return client.callTool(name, args);
  }

  async upload(bytes: Uint8Array, contentType: string, fileName: string, projectId?: string): Promise<string> {
    const { client } = await this.ensure();
    return client.uploadFile(bytes, contentType, fileName, projectId);
  }
}
