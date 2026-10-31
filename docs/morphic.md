# Morphic integration

Frontstage's desktop app talks to Morphic through Morphic's hosted MCP server,
`https://mcp.morphic.com/mcp`. This is Morphic's only documented programmatic interface: there is
no REST API for apps and there are no API keys. Everything here was verified against the live
server on 2026-10-30.

## How sign-in works

| | |
|---|---|
| Protocol | OAuth 2.1, authorization code + PKCE (S256), public client (no secret) |
| Authorization server | `https://api.morphic.com` (from `/.well-known/oauth-protected-resource`) |
| Scopes | `projects:read assets:read assets:write generations:write` |
| Client registration | **None.** Morphic doesn't offer dynamic registration. It supports *Client ID Metadata Documents*: the app's `client_id` is the URL of a public JSON file describing it |
| Our client id | `https://jdmghk.github.io/frontstage/morphic/client.json`, served from the fork's `gh-pages` branch |
| Redirect | `http://127.0.0.1:53917/morphic/callback`, a loopback listener the desktop app opens only while you sign in |

Morphic fetches the metadata file and only accepts the redirect addresses it lists. To change the
port or path, edit `morphic/client.json` on the `gh-pages` branch **and** the constants at the top
of `apps/desktop/src/main/morphic-client.mjs` together.

Tokens (access + refresh) are encrypted with the OS keychain via Electron `safeStorage` in
`<userData>/morphic-tokens.bin`. They never reach the renderer. **Settings → Generation → Morphic →
Sign out** deletes them.

The Codex or Claude MCP configuration on your machine is a *separate* sign-in. The app does not and
cannot use it.

## What the app uses

The server exposes 81 tools. The renderer may call only the ones below (`RENDERER_TOOLS`); main
handles uploads itself so the signed upload URLs stay out of the renderer.

| Purpose | Tool(s) |
|---|---|
| Shot take: reference-to-video when the cast has designs/references, otherwise text-to-video | `generate_video` (`reference_image_asset_ids`, `duration_seconds`, `aspect_ratio: 16:9`) |
| Character design: from existing designs/references | `edit_image` (`image_asset_ids`) |
| Character design: from description only | `generate_image` |
| Job status (polled by the existing GenerationService) | `wait_for_generations` with `wait_seconds: 0` |
| Which Morphic project to use | `list_projects`: the most recently updated one |
| Upload a reference image | `prepare_media_upload` → HTTPS PUT → `import_media_from_url` (main process) |
| Allowed for future use, not yet in the UI | `get_generation_status`, `list_assets`, `list_characters`, `list_models`, `get_credit_balance` |

Code:
- `apps/desktop/src/main/morphic-client.mjs`: MCP client, OAuth provider, loopback callback, upload.
- `packages/ai/src/generation/morphic-gateway.ts`: `MorphicGateway` (a `GenJobGateway`) and `RoutingGenGateway`.
- `packages/ai/src/generation/morphic-studio.ts`: shot/character → prompt, references, placeholder, job.

A Morphic job is an ordinary generation job whose endpoint is `morphic/<tool>`. The usual
placeholder → poll → download → finalize flow applies, including resuming after the project is
reopened. A take is marked *generated* only when Morphic returns a downloadable asset URL; a failed
or cancelled generation, or one without an asset, marks it *failed* with Morphic's message.

## Limits and honest caveats

- **Web editor:** works through the self-host proxy started with `MORPHIC=1`, which acts as the MCP
  client (Morphic's server sends no CORS headers, so browsers can't call it). The proxy must run on
  the same computer as the browser because sign-in returns to `127.0.0.1:53917`. Its tokens are kept
  in `~/.frontstage/morphic-proxy-tokens.json` (mode 0600; `MORPHIC_TOKEN_FILE` overrides). The cloud
  relay doesn't offer Morphic.
- **Credits.** Every generation spends your Morphic credits. Video costs much more than images.
- **Model limits.** The app sends the shot's duration rounded to whole seconds, at 16:9. If the
  default model can't do that duration, Morphic refuses with a message naming what it supports; the
  message is shown on the shot. Change the shot duration and try again.
- **Project.** Results also appear in your most recently updated Morphic project. That project's name
  is shown when a job starts.
- **Trained Morphic characters**: link one on a character card; **Generate design in Morphic** then
  uses it as `edit_image`'s `character_id`. `generate_video` doesn't accept a character id, so shots
  carry the likeness through the designs you approve. Characters are trained in Morphic Studio; its
  MCP server can't train them. No model guarantees an identical character in every clip.

## Manual live check

1. `pnpm -F @frontstage/desktop dev`
2. Settings → Generation → Morphic → **Sign in with Morphic**, approve in the browser, and check that
   it reads "Signed in".
3. Characters → a character with one reference image → **Generate design in Morphic**. A pending
   thumbnail appears, then the image lands in `Characters/<Name>`.
4. Production → a shot with a prompt and that character in the cast → **Generate in Morphic**. The
   shot reads *generating*, then *generated*, with the take in `Production/NN Scene/NN Shot`.

## Troubleshooting

- **"Port 53917 is in use"**: another app holds the callback port. Quit it and sign in again.
- **"Morphic sign-in timed out"**: the browser step wasn't finished within 5 minutes. Try again.
- **"redirect_uri is not registered for this client"**: `morphic/client.json` and the constants in
  `morphic-client.mjs` disagree, or GitHub Pages is down.
- **"Not signed in to Morphic"** on a job that had been running: the session expired and couldn't be
  refreshed. Sign in again, then generate the take again.
