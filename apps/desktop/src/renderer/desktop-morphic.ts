import type { MorphicBridge, MorphicToolResult } from "@frontstage/ai";

// window.desktopMorphic (preload) → main's morphic:* IPC. OAuth tokens and signed upload URLs stay in main.
interface DesktopMorphicIpc {
  status(): Promise<{ signedIn: boolean }>;
  signIn(): Promise<{ ok: true } | { error: string }>;
  signOut(): Promise<{ ok: true }>;
  callTool(name: string, args: Record<string, unknown>): Promise<{ result: MorphicToolResult } | { error: string }>;
  upload(bytes: ArrayBuffer, contentType: string, fileName: string, projectId?: string): Promise<{ assetId: string } | { error: string }>;
  download(url: string): Promise<{ data: ArrayBuffer } | { error: string }>;
}

declare global {
  interface Window {
    desktopMorphic: DesktopMorphicIpc;
  }
}

export interface MorphicAccount {
  isSignedIn(): Promise<boolean>;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
}

export class DesktopMorphicBridge implements MorphicBridge, MorphicAccount {
  async callTool(name: string, args: Record<string, unknown>): Promise<MorphicToolResult> {
    const res = await window.desktopMorphic.callTool(name, args);
    if ("error" in res) throw new Error(res.error);
    return res.result;
  }

  async uploadFile(bytes: Uint8Array, contentType: string, fileName: string, projectId?: string): Promise<string> {
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const res = await window.desktopMorphic.upload(buffer, contentType, fileName, projectId);
    if ("error" in res) throw new Error(res.error);
    return res.assetId;
  }

  async download(url: string): Promise<Uint8Array> {
    const res = await window.desktopMorphic.download(url);
    if ("error" in res) throw new Error(res.error);
    return new Uint8Array(res.data);
  }

  async isSignedIn(): Promise<boolean> {
    return (await window.desktopMorphic.status()).signedIn;
  }

  async signIn(): Promise<void> {
    const res = await window.desktopMorphic.signIn();
    if ("error" in res) throw new Error(res.error);
  }

  async signOut(): Promise<void> {
    await window.desktopMorphic.signOut();
  }
}
