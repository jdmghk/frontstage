// Keys and Morphic tokens saved by the Electron app are encrypted with Electron's own key and can't
// be carried over. Rather than failing, say so once, and the normal key fields do the rest.

import { invoke } from "@tauri-apps/api/core";
import { showNotice } from "./notices.js";

void invoke<boolean>("secrets_legacy_notice")
  .then((show) => {
    if (!show) return;
    showNotice(
      "legacy-secrets-notice",
      "Your API keys and Morphic sign-in from the previous version can't be moved to this one. Re-enter your keys in Settings → Agent and sign in to Morphic again.",
      () => void invoke("secrets_dismiss_legacy_notice"),
    );
  })
  .catch(() => {});
