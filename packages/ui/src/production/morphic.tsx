import { useEffect, useState } from "react";
import type { Character, Production, Scene, Shot } from "@frontstage/core";
import type { MorphicStartResult } from "@frontstage/ai";
import { theme } from "../theme/theme.js";
import { Button } from "../primitives/index.js";

export interface MorphicAccount {
  isSignedIn(): Promise<boolean>;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
}

/** Morphic actions offered by the host (desktop only — sign-in needs a loopback redirect). */
export interface StudioMorphic {
  account: MorphicAccount;
  generateShotTake(p: Production, scene: Scene, shot: Shot, opts: { name: string; folderId?: string }): Promise<MorphicStartResult>;
  generateCharacterDesign(c: Character, opts: { name: string; folderId?: string }): Promise<MorphicStartResult>;
  /** Characters trained in Morphic Studio, to link as a character's likeness. */
  listTrainedCharacters?(): Promise<{ id: string; name: string; shared: boolean }[] | { error: string }>;
}

const noteStyle: React.CSSProperties = { fontSize: theme.fontSize.xs, color: theme.text.secondary, lineHeight: 1.4 };

/** Settings → Generation: Morphic sign-in status with Sign in / Sign out. */
export function MorphicAccountSection({ account }: { account: MorphicAccount }) {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    account.isSignedIn().then((v) => live && setSignedIn(v), () => live && setSignedIn(false));
    return () => {
      live = false;
    };
  }, [account]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setSignedIn(await account.isSignedIn());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: theme.spacing.sm }}>
      <div style={{ display: "flex", alignItems: "center", gap: theme.spacing.sm }}>
        <span style={{ flex: 1, fontSize: theme.fontSize.sm, color: theme.text.primary }} data-testid="settings-morphic-status">
          {signedIn === null ? "Checking…" : signedIn ? "Signed in" : "Not signed in"}
        </span>
        {signedIn ? (
          <Button testid="settings-morphic-signout" size="regular" disabled={busy} onClick={() => run(() => account.signOut())}>
            Sign out
          </Button>
        ) : (
          <Button testid="settings-morphic-signin" variant="accent" size="regular" disabled={busy || signedIn === null} onClick={() => run(() => account.signIn())}>
            {busy ? "Waiting for browser…" : "Sign in with Morphic"}
          </Button>
        )}
      </div>
      {error && (
        <span style={{ ...noteStyle, color: theme.status.error }} data-testid="settings-morphic-error">
          {error}
        </span>
      )}
      <span style={noteStyle}>
        Opens Morphic in your browser. Generations run on your Morphic credits and appear in your most recently updated
        Morphic project as well as here.
      </span>
    </div>
  );
}
