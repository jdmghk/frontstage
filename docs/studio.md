# Production studio

Frontstage extensions for producing AI-generated YouTube videos: scenes and shots, reusable
characters, Morphic generation, Claude writing, a Google Flow hand-off, a voice studio and fight
choreography planning. Everything lives inside the existing editor — two new tabs on the media panel's left
rail, no separate dashboard.

## Installing the Mac app

The desktop app is now `apps/studio-tauri` (Tauri, the system WebKit and a bundled trimmed ffmpeg). The Electron
app in `apps/desktop` still builds, but it isn't the one to install. Numbers and test details are in
[tauri-migration.md](tauri-migration.md).

1. Get `Frontstage_0.3.0_x64.dmg` (built with `CI=true pnpm -F @frontstage/studio-tauri bundle`; it lands in
   `apps/studio-tauri/src-tauri/target/release/bundle/dmg/`). Open it and drag **Frontstage** to **Applications**.
2. The app is unsigned. On first open, macOS may refuse it. Go to **System Settings → Privacy & Security**,
   scroll down, click **Open Anyway** and confirm. (On macOS 13 and 14, right-click the app → **Open** also works.)
   If a downloaded copy says it's damaged, the quarantine flag is the cause:
   `xattr -dr com.apple.quarantine /Applications/Frontstage.app`.
3. Settings → Agent and Settings → Generation: re-enter your API keys and sign in to Morphic again. When you save a
   key, macOS may ask whether Frontstage can use the Keychain; choose **Always Allow**.

### Differences from the Electron app

- **Fresh start once:** API keys, Morphic sign-in, recent projects, the MCP token and window position don't carry
  over. The app has its own data folder (`~/Library/Application Support/studio.frontstage.tauri`) and Keychain
  service. Keys can't be moved, because Electron encrypted them with its own key; a notice says so if old ones exist.
  Project folders are unchanged and open with File → Open.
- **Some sources are converted on import:** HEVC, AV1, 10-bit and HDR video, 4:4:4 H.264 and H.264 with a left/top
  crop are copied to H.264 (CRF 16) in the app's cache, with a progress message. The project keeps the original;
  preview and export use the copy. The cache isn't size-limited yet.
- **Export preset choice** is the editor's own dialog, not a system message box. Captioned exports keep the
  video's full length (Electron's could end at the last caption).
- **Menus:** the app menu is separate, so File isn't under the app's name. Force Reload and Toggle DevTools are gone.
- **Morphic sign-in** sends and checks an OAuth `state` value. It hasn't been tried against the real server yet.
- **Memory doesn't improve.** The gain is download and install size.

### Known limits

- Minimum macOS 13.7. Only tested on one Intel Mac running 13.7.8 (Safari 18.6's WebKit).
- Windows and Apple Silicon are untested: nothing has been built or run for them beyond an arm64 ffmpeg.
- Formats left out of the trimmed ffmpeg (Hap, hardware decoding, rare codecs) fail to convert, with ffmpeg's error.
- Long files are untested: the longest export run so far is 10 s of 1080p.

## Feature status

| Feature | Status | Notes |
|---|---|---|
| Scenes and shots (script, synopsis, continuity, camera, framing, prompt) | **Implemented** (Phase 2) | Media panel → **Production** tab |
| Shot status tracking | **Implemented** | `draft / ready / generating / generated / approved / needs-regen / failed`; scene status is derived |
| Takes per shot, approve one, keep the rest | **Implemented** | A new take never changes the approved take or the timeline |
| Place a shot on the timeline in story order | **Implemented** | Ripple-inserts after the previous placed shot |
| Replace one shot on the timeline | **Implemented** | Swaps only that clip's media, keeping timing, effects and keyframes; refused with a message if the new take is shorter than the cut |
| Asset folders `Production/NN Scene/NN Shot`, `Characters/Name` | **Implemented** | Created on first import; renaming a scene later creates a new folder rather than moving old assets |
| Characters (description, appearance, references, approved designs, continuity) | **Implemented** | Media panel → **Characters** tab |
| Cross-project character library | **Implemented** | Desktop: `~/.frontstage/characters/<id>/`. Web: browser OPFS (per browser profile) |
| Draft/approved state for written text | **Implemented** | Editing approved text returns it to draft |
| Manual import of Google Flow / Morphic results | **Implemented** | Pick the source when importing a take; recorded per take |
| Voice profiles (reference recording + consent record) | **Implemented** (Phase 5) | Media panel → **Voice** tab → **+ Voice**; creation requires confirming it's your voice or you have permission |
| Voice profile on a character / narrator | **Implemented** | Voice tab → *Who speaks with which voice* |
| Morphic sign-in (OAuth, desktop) | **Implemented** (Phase 3) | Settings → Generation → Morphic. See [morphic.md](morphic.md) |
| Generate a shot take in Morphic | **Implemented** | Shot card → **Generate in Morphic**: reference-to-video with the cast's approved designs |
| Generate a character design in Morphic | **Implemented** | Character card → **Generate design in Morphic**; mark it **Design** to approve |
| Morphic in the web editor | **Implemented** (self-host proxy) | Run the proxy with `MORPHIC=1` on the same computer as the browser; it becomes the MCP client (Morphic's server allows no browser calls). Sign-in opens in a new tab. Not available through the cloud relay, which would have to keep every user's Morphic tokens server-side |
| Morphic trained characters | **Implemented** (desktop) | Character card → **Link Morphic character…**; design generation then sends it as `edit_image` `character_id`. Morphic's `generate_video` takes no character id, so shots get the likeness through the approved designs made this way. Training happens in Morphic Studio |
| Google Flow hand-off pack | **Implemented** (Phase 4, desktop) | Shot card → **Prepare for Flow…** writes `prompt.txt`, `shot.md` and up to 3 reference images to a folder. There is no public Flow API, so the clip comes back through **Import take…** |
| Copy a shot's full prompt | **Implemented** | Shot card → **Copy prompt** (prompt + camera, framing, cast, continuity) |
| Google Flow direct connection | Not supported | No public Flow API exists |
| Veo 3.1 direct (the model behind Flow) | **Implemented** (desktop, fal key) | Shot card → **Veo 3.1 (fal)…**: with cast designs → Veo 3.1 reference-to-video (≤3 images, 8 s, 1080p, sound, ≈$3.20); without → Veo 3.1 Fast text-to-video. Shows the plan and price before sending; takes are recorded as `fal-veo` |
| Claude: outline, logline, scenes | **Implemented** (Phase 4, desktop) | Production → Story → **Write outline**; scenes are only created when there are none |
| Claude: characters from the story | **Implemented** | Story → **Suggest characters**; details you wrote are kept |
| Claude: per-scene script, shot list, dialogue/voiceover, continuity | **Implemented** | Scene card buttons; each acts on that scene only. **Break into shots** keeps shots that have takes |
| Claude: per-shot generation prompt | **Implemented** | Shot card → **Write prompt** |
| Claude in the web editor | **Implemented** | Self-host proxy: set `ANTHROPIC_API_KEY`. Cloud relay: each user adds their own Anthropic key in Settings (kept in their browser). Choreography frames are sampled in the browser |
| Voice and Veo in the web editor | **Implemented** | Through the existing fal proxy/relay route and key |
| Generate, play, regenerate one line | **Implemented** (desktop + web with a fal key) | Voice tab → line → **Generate** / **Regenerate**; every take is kept, approve one. fal-hosted Chatterbox Multilingual, $0.025 per 1,000 characters, 23 languages, 300 characters per line |
| Place dialogue on the timeline | **Implemented** | **Place on timeline** puts the approved take on an audio track under its shot (or the scene's first shot), after the previous line; **Replace on timeline** swaps just that clip |
| Export approved dialogue | **Implemented** (desktop) | Voice tab → **Export approved…** writes one audio file per line + `lines.txt` |
| Fight choreography: reference import (permission required) | **Implemented** (Phase 5) | Media panel → **Choreo** tab → **+ Reference** |
| Fight choreography: frame sampling + Claude shot plan | **Implemented** (desktop) | **Analyze** samples ≤20 frames with the bundled ffmpeg and asks Claude for shots: positions, action, camera, framing, transitions, impact times, continuity, prompt |
| Fight choreography: edit, approve → scene shots | **Implemented** | Edit every field; **Approve → add shots** appends them to the chosen scene as draft shots |
| Motion from the reference video | **Implemented** (desktop, Morphic) | Approved choreography shots keep the reference as a *motion reference*; **Generate in Morphic** sends it as `reference_video_asset_ids` (Morphic reference-to-video). It guides movement; it isn't exact motion transfer, and models that don't take reference video are refused by Morphic with the reason |
| YouTube export presets (1080p, 4K, 16:9) | **Implemented** (Phase 6, desktop) | File → Export Video asks *Timeline size / YouTube 1080p / YouTube 4K*; YouTube presets encode H.264 High CRF 18 (preset slow), yuv420p, AAC 320 kbps 48 kHz, faststart. Disabled with a reason on non-16:9 timelines; warns when sources are smaller than the output |
| Export presets in the web editor | **Implemented** | In-app *Export size* picker; YouTube presets use H.264 High at a fitting level (12 Mbps 1080p, 45 Mbps 4K) + 320 kbps AAC. 4K depends on the browser's encoder; if it can't, the export says so. Checked: a real browser export came out 1920×1080 H.264 High |
| Per-track volume | **Implemented** | Audio track header dB field (-60…+12), on top of each clip's volume; applies to preview and export; undoable |
| Cross-dissolve | **Implemented** | Inspector → Transition → **Cross-dissolve from previous clip**: the clip moves to a track above and fades in over the previous one; nothing else moves. Needs spare footage on one side (it says how much) |
| Slide and wipe transitions | **Implemented** | Inspector → Transition → *Slide in* / *Wipe* + direction; built from position / crop keyframes on the incoming clip, same no-ripple rules as the dissolve |
| Automatic retry of generation jobs | **Implemented** | A submit refused with 429/502/503/504 is retried up to 3 times with backoff (never a network error, which may have started the job); up to 3 consecutive failed status checks are tolerated |
| Subtitles | Existing feature | Captions tab: Whisper transcription, caption clips burned into the export, SRT/VTT export (File → Captions) for YouTube upload |
| Captions as an embedded subtitle track | **Implemented** (desktop) | Export dialog checkbox *Captions as a subtitle track…*: captions are left out of the picture and muxed into the MP4 as a switchable `mov_text` track (checked with ffprobe) |

## How it's stored

A project folder gains one file, `production.json`, next to `project.json`, `media.json` and
`generation-log.json`, written on every save from the desktop or web editor. Older projects without
it open unchanged, with an empty production. The file holds scenes (with their shots and takes) and the project's characters;
takes and references point at media-library ids, so the media itself stays in `media/`.

Unlike `media.json`, an unreadable `production.json` stops the project from opening with an error
naming the file. Silently treating it as empty would erase your scripts on the next save.

Production edits mark the project unsaved, but are not on the timeline undo stack (the media
library isn't either). "Place" and "Replace" *are* timeline edits and undo normally.

Deleting an asset from the media library removes it from any shot's takes and any character's
references; if it was a shot's approved take, the shot drops back to `generated`.

## Claude writing (desktop)

1. **Settings → Agent → Anthropic (Claude writing)**: paste an Anthropic API key. It's kept in
   the OS keychain in the main process and never reaches the renderer. Pick the writing model:
   Claude Opus 5.5 (default) or Claude Sonnet 5.5.
2. **Production → Story**: write the idea, then **Write outline** (logline, outline and, on an empty
   production, a first list of scenes) and **Suggest characters**.
3. On a scene: **Write script**, **Break into shots**, **Write dialogue**, **Continuity notes**. On a
   shot: **Write prompt**.

Everything Claude writes arrives as a **draft** you edit and approve; nothing is regenerated beyond the
scene or shot you clicked. Requests use structured outputs (a JSON schema per task) and are checked
again on arrival; a reply in the wrong shape is rejected with a message, not half-applied. Server-side
refusal fallbacks are on (`fallbacks: "default"`): if Claude's safety classifiers decline a request,
Anthropic re-runs it on its recommended fallback model; if the whole chain declines, you see the reason.
Each action costs Anthropic API usage.

Code: `packages/ai/src/studio/writer.ts` (tasks, schemas, apply rules),
`apps/desktop/src/main/claude-studio.mjs` (Messages API call), `packages/ui/src/production/writer-ui.tsx`.

## Google Flow hand-off

Google Flow has no public API. **Prepare for Flow…** on a shot saves a folder named like
`02-03 Rooftop duel - Spinning kick` with `prompt.txt`, `shot.md` (camera, framing, cast, steps) and
`ref-1…ref-3` (the cast's approved designs first: Flow takes at most three ingredients). Generate in
Flow, download the clip, then on the shot choose **Google Flow (manual)** and **Import take…**.

## Voice studio

Speech comes from **Chatterbox Multilingual** (Resemble AI, MIT-licensed model) hosted on fal.ai, using
the fal key from Settings → Generation, so no ElevenLabs subscription is needed. Why not self-hosted:
running OpenVoice/Chatterbox locally needs a CUDA GPU (or slow CPU inference), several GB of model
weights and a Python service to maintain; fal costs $0.025 per 1,000 characters instead (about $0.23 for
ten minutes of continuous speech, roughly 9,000 characters, before retakes). Resemble's open models add an inaudible "Perth" watermark to output.

1. **Voice → + Voice**: name it, choose a short clean recording of one speaker, its language, and
   confirm it's your voice or you have the speaker's permission (required; the confirmation, note and
   date are saved with the voice).
2. **Who speaks with which voice**: pick a voice for the narrator and each character.
3. Lines come from each scene's dialogue (Production tab or Claude's **Write dialogue**). Per line:
   **Generate**, play (▶), **Regenerate** for another take, click a take to approve it. Optionally pick
   the shot it plays over.
4. **Place on timeline** / **Replace on timeline**, or **Export approved…** for the audio files.

A cloned voice resembles the reference but isn't identical; expressiveness and pacing vary per take.

## Fight choreography

1. **Choreo → + Reference**: pick a video you own or have permission to use and confirm that (saved
   with the plan, dated). Short clips (under ~20 s) work best.
2. **Notes for the analysis**: who is who ("fighter in red = Kai") and what to focus on.
3. **Analyze** (desktop + Anthropic key): up to 20 frames are sampled evenly with the bundled ffmpeg
   (in memory, nothing is written) and sent to Claude with the notes. The project must be saved so
   the video is on disk.
4. Edit the shot plan (duration, cast, starting positions, action, camera, framing, transition, impact
   times, continuity, prompt). Any edit returns it to draft.
5. Choose a scene and **Approve → add shots**: each planned shot becomes a draft shot in that scene,
   with matching cast linked; generate them from the Production tab like any other shot.

Approved shots also carry the reference video as a motion reference for **Generate in Morphic**
(reference-to-video). That guides the movement; it isn't an exact copy, so results will differ from
the reference footage.

## Finishing and export

1. **Mix**: name audio tracks (double-click the name) e.g. *Dialogue*, *Music*, *SFX*, and set each
   track's level in dB in its header; clip volume and fades still work per clip.
2. **Transitions**: select the second of two adjacent clips → Inspector → Transition → choose Dissolve,
   Slide in or Wipe (and a direction) → set frames → **Add transition from previous clip**. One undo removes it.
3. **Captions**: Captions tab → transcribe → style; they're burned into the video. For YouTube's own
   captions, File → **Captions (SRT)…** and upload the file next to the video.
4. **Export**: File → Export Video → pick **YouTube 1080p** or **YouTube 4K** → choose where to save.
   The timeline must be 16:9; 4K from 1080p sources is an upscale and the dialog says so.

## Using it

1. **Characters tab** → **+ Character**. Fill in appearance, **Add reference images…**, and click
   **Design** on the images that are your approved look; when shots are prepared for generation
   (Phases 3–4), a character's designs are sent ahead of its other references. **Save to library** keeps the character for other projects; **From library…** adds
   one to the current project (its images are copied in, so the project stays self-contained).
2. **Production tab** → **+ Scene**, write the script and synopsis, tick the cast, then **+ Shot**
   for each shot. New shots inherit the scene's cast.
3. Generate the shot wherever you like (Google Flow, Morphic, the Generate panel), then in the shot
   choose the source and **Import take…**. Import as many takes as you want. On desktop, once you've
   signed in to Morphic (Settings → Generation), **Generate in Morphic** does this in one step: the
   shot shows *generating* until the take lands, or *failed* with Morphic's message.
4. **Approve** the take you want, then **Place on timeline**. To redo a shot later, set its status
   to *Needs regeneration*, import the new take, approve it, and **Replace on timeline**: only that
   clip changes.

Character references improve consistency, but no current video model guarantees an identical
character in every clip.

## Testing

- Core: `packages/core/test/production.test.ts`, `shot-placement.test.ts`, `project-io.test.ts`,
  `src/project/project-session.test.ts`
- UI: `packages/ui/test/production-store.test.ts`, `character-library.test.ts`, `production-tab.test.tsx`
- Desktop fs: `apps/desktop/test/characters-fs.test.ts`
- Voice: `packages/core/test/voice.test.ts`, `dialogue-placement.test.ts`, `packages/ai/test/voice-studio.test.ts`,
  `packages/ui/test/voice-tab.test.tsx`
- Choreography: `packages/core/test/choreography.test.ts`, `packages/ai/test/choreography-task.test.ts`,
  `apps/desktop/test/frame-sampler.test.ts`, `packages/ui/test/choreo-tab.test.tsx`
- Finishing: `packages/core/test/track-gain.test.ts`, `cross-dissolve.test.ts`, `packages/ui/test/export-presets.test.ts`,
  `apps/desktop/test/export-codecs.test.ts`; generation retries in `packages/ai/test/generation-service.test.ts`.
  The YouTube encoder settings were also checked against real output with ffprobe (H.264 High, yuv420p,
  AAC 48 kHz, moov before mdat).
- Claude + Flow: `packages/ai/test/studio-writer.test.ts` (schemas, apply rules, refusal, wrong-shape
  replies, Flow pack), `apps/desktop/test/claude-studio.test.ts` (request checks, fallbacks, error
  mapping), Claude/Flow cases in `packages/ui/test/production-tab.test.tsx`
- Morphic: `packages/ai/test/morphic-gateway.test.ts` (fake Morphic: success, tool error, expired
  sign-in, no-asset result, references, project choice), `apps/desktop/test/morphic-client.test.ts`
  (upload sequence, allowlist, loopback callback, sign-in gating). The live check is manual; see
  [morphic.md](morphic.md#manual-live-check).
- End to end: `apps/web/e2e/production.spec.ts`, `apps/desktop/e2e/production.spec.ts`

The web e2e imports a PNG as the shot's take because Playwright's bundled Chromium has no H.264
decoder, so `.mp4` imports never finish probing there. Real Chrome and the desktop app are unaffected.

## Troubleshooting

- **"production.json is unreadable"** when opening: the file was hand-edited or truncated. Fix the
  JSON or move the file aside; the project then opens with no scenes.
- **Place on timeline is disabled**: approve a take first; if one is approved, it's still importing.
- **"Replacement media is too short…"**: the new take is shorter than the clip as cut. Trim the clip
  on the timeline first, or delete it and use **Place on timeline**.
- **Web: library characters missing in another browser**: the web library lives in that browser's
  storage. Use the desktop app for a library on disk.
