# Production studio

Frontstage extensions for producing AI-generated YouTube videos: scenes and shots, reusable
characters, Morphic generation (desktop), and (in later phases) a Google Flow handoff, Claude scriptwriting, voice and
choreography. Everything lives inside the existing editor — two new tabs on the media panel's left
rail, no separate dashboard.

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
| Voice profile on a character | Not yet | Phase 5 |
| Morphic sign-in (OAuth, desktop) | **Implemented** (Phase 3) | Settings → Generation → Morphic. See [morphic.md](morphic.md) |
| Generate a shot take in Morphic | **Implemented** | Shot card → **Generate in Morphic**: reference-to-video with the cast's approved designs |
| Generate a character design in Morphic | **Implemented** | Character card → **Generate design in Morphic**; mark it **Design** to approve |
| Morphic in the web editor | Not supported | No loopback sign-in on the web; use **Import take…** with source *Morphic (manual)* |
| Morphic trained characters (`character_id`) | Not yet | Listed by Morphic's server, not wired into the UI |
| Google Flow handoff pack | Not yet | Phase 4. There is no public Flow API, so this will stay a manual handoff |
| Claude scriptwriting | Not yet | Phase 4 |
| Voice generation | Not yet | Phase 5 (fal-hosted Chatterbox) |
| Fight choreography | Not yet | Phase 5 |
| YouTube export presets | Not yet | Phase 6 |

## How it's stored

A project folder gains one file, `production.json`, next to `project.json`, `media.json` and
`generation-log.json`. Projects that never use the Production tab don't get one, and older projects
open unchanged. The file holds scenes (with their shots and takes) and the project's characters;
takes and references point at media-library ids, so the media itself stays in `media/`.

Unlike `media.json`, an unreadable `production.json` stops the project from opening with an error
naming the file. Silently treating it as empty would erase your scripts on the next save.

Production edits mark the project unsaved, but are not on the timeline undo stack (the media
library isn't either). "Place" and "Replace" *are* timeline edits and undo normally.

Deleting an asset from the media library removes it from any shot's takes and any character's
references; if it was a shot's approved take, the shot drops back to `generated`.

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
