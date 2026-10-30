import { useRef, useState, useSyncExternalStore } from "react";
import type { EditorStore, MediaFolder, MediaManifestEntry, Production, Scene, Shot, ShotProvider, ShotStatus } from "@frontstage/core";
import {
  addScene,
  addShot,
  approveTake,
  attachTake,
  isShotPlaced,
  linkShotClip,
  markNeedsRegen,
  moveScene,
  moveShot,
  placeShotCommand,
  removeScene,
  removeShot,
  replaceShotClip,
  sceneStatus,
  setShotStatus,
  updateScene,
  updateShot,
} from "@frontstage/core";
import { parseGenerationStatus } from "@frontstage/core";
import { theme } from "../theme/theme.js";
import { generatingLabel } from "../media/GeneratingOverlay.js";
import { Button, Checkbox, Icon, IconButton, Select, TextInput } from "../primitives/index.js";
import { ensureFolderPath, numbered, type ProductionStore } from "./production-store.js";
import { ApprovalToggle, Field, FieldLabel, StatusChip, TextArea, Thumb, cardStyle, rowStyle, scrollColumnStyle } from "./fields.js";
import type { StudioMorphic } from "./morphic.js";
import { buildFlowPack, continuityTask, dialogueTask, sceneScriptTask, shotListTask, shotPromptTask, shotPrompt } from "@frontstage/ai";
import { ActionNote, DialogueEditor, StoryCard, WriteButton, useWriterAction, type FlowExport, type StudioWriter } from "./writer-ui.js";

export interface ProductionLibrary {
  getSnapshot(): { entries: MediaManifestEntry[]; folders: MediaFolder[] };
  subscribe(cb: () => void): () => void;
  thumbnail(id: string): string | undefined;
  entry(id: string): MediaManifestEntry | undefined;
  importFiles(files: File[] | FileList, folderId?: string): Promise<MediaManifestEntry[]>;
  createFolder(name: string, parentFolderId?: string): MediaFolder;
  /** Needed for the Google Flow hand-off's reference images. */
  readEntryBytes?(id: string): Promise<Uint8Array>;
}

export interface ProductionTabProps {
  production: ProductionStore;
  library: ProductionLibrary;
  store?: EditorStore;
  morphic?: StudioMorphic;
  writer?: StudioWriter;
  flowExport?: FlowExport;
}

const noopSubscribe = () => () => {};

const IMPORT_SOURCES: { value: ShotProvider; label: string }[] = [
  { value: "import", label: "Imported file" },
  { value: "flow-manual", label: "Google Flow (manual)" },
  { value: "morphic", label: "Morphic (manual)" },
];

// Statuses a user sets by hand; generating/generated/approved follow from real actions only.
const MANUAL_STATUSES: { value: ShotStatus; label: string }[] = [
  { value: "draft", label: "Draft" },
  { value: "ready", label: "Ready to generate" },
  { value: "needs-regen", label: "Needs regeneration" },
];

export function ProductionTab({ production, library, store, morphic, writer, flowExport }: ProductionTabProps) {
  const p = useSyncExternalStore(production.subscribe.bind(production), () => production.getSnapshot());
  useSyncExternalStore(library.subscribe.bind(library), () => library.getSnapshot().entries);
  // Re-render on timeline edits so "Place" flips to "Replace" (and back if the clip is deleted).
  useSyncExternalStore(store ? store.subscribe.bind(store) : noopSubscribe, () => store?.getSnapshot());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (id: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const handleAddScene = () => {
    let id = "";
    production.update((cur) => {
      const r = addScene(cur, { title: `Scene ${cur.scenes.length + 1}` });
      id = r.sceneId;
      return r.production;
    });
    setExpanded((s) => new Set(s).add(id));
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }} data-testid="production-tab">
      <div style={{ ...rowStyle, height: theme.size.panelHeader, padding: `0 ${theme.spacing.sm}`, flexShrink: 0 }}>
        <Button testid="production-add-scene" onClick={handleAddScene}>
          <span style={rowStyle}>
            <Icon name="plus" size={10} />
            Scene
          </span>
        </Button>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: theme.fontSize.xs, color: theme.text.tertiary }}>
          {p.scenes.length} scenes · {p.scenes.reduce((n, s) => n + s.shots.length, 0)} shots
        </span>
      </div>
      <div style={scrollColumnStyle}>
        <StoryCard p={p} production={production} writer={writer} />
        {p.scenes.length === 0 && (
          <div style={{ fontSize: theme.fontSize.sm, color: theme.text.tertiary }} data-testid="production-empty">
            Break your video into scenes and shots. Each shot keeps its prompt, references and every take, so
            you can regenerate one shot without touching the rest.
          </div>
        )}
        {p.scenes.map((scene, si) => (
          <SceneCard
            key={scene.id}
            p={p}
            scene={scene}
            index={si}
            open={expanded.has(scene.id)}
            onToggle={() => toggle(scene.id)}
            expanded={expanded}
            onToggleShot={toggle}
            production={production}
            library={library}
            store={store}
            morphic={morphic}
            writer={writer}
            flowExport={flowExport}
          />
        ))}
      </div>
    </div>
  );
}

interface SceneCardProps {
  p: Production;
  scene: Scene;
  index: number;
  open: boolean;
  onToggle: () => void;
  expanded: Set<string>;
  onToggleShot: (id: string) => void;
  production: ProductionStore;
  library: ProductionLibrary;
  store?: EditorStore;
  morphic?: StudioMorphic;
  writer?: StudioWriter;
  flowExport?: FlowExport;
}

function SceneCard({ p, scene, index, open, onToggle, expanded, onToggleShot, production, library, store, morphic, writer, flowExport }: SceneCardProps) {
  const set = (patch: Partial<Omit<Scene, "id" | "shots">>) => production.update((cur) => updateScene(cur, scene.id, patch));
  const tid = `scene-${index}`;
  const { busy, message, run } = useWriterAction(production, writer);
  // Re-read the scene at click time so a task never works from a stale render.
  const latest = (cur: Production) => cur.scenes.find((s) => s.id === scene.id) ?? scene;
  const handleShotList = () => {
    const drafts = scene.shots.filter((s) => s.takes.length === 0);
    if (drafts.length > 0 && !globalThis.confirm?.(`Replace ${drafts.length} shot(s) that have no takes yet? Shots with takes are kept.`)) return;
    void run("Break into shots", (cur, model) => shotListTask(cur, latest(cur), model));
  };
  return (
    <div style={cardStyle} data-testid={tid}>
      <div style={rowStyle}>
        <IconButton frame="sm" title={open ? "Collapse" : "Expand"} onClick={onToggle} testid={`${tid}-toggle`}>
          <Icon name={open ? "chevron-down" : "chevron-right"} size={10} />
        </IconButton>
        <TextInput value={scene.title} onChange={(title) => set({ title })} testid={`${tid}-title`} style={{ flex: 1, minWidth: 0 }} />
        <StatusChip status={sceneStatus(scene)} testid={`${tid}-status`} />
        <IconButton frame="sm" title="Move up" disabled={index === 0} onClick={() => production.update((cur) => moveScene(cur, scene.id, index - 1))}>
          <Icon name="chevron-up" size={10} />
        </IconButton>
        <IconButton frame="sm" title="Delete scene" testid={`${tid}-delete`} onClick={() => production.update((cur) => removeScene(cur, scene.id))}>
          <Icon name="trash" size={10} />
        </IconButton>
      </div>
      {open && (
        <>
          <Field label="Synopsis">
            <TextArea value={scene.synopsis} onChange={(synopsis) => set({ synopsis })} rows={2} testid={`${tid}-synopsis`} />
          </Field>
          <div style={rowStyle}>
            <FieldLabel>Script</FieldLabel>
            <div style={{ flex: 1 }} />
            <ApprovalToggle state={scene.scriptState} onChange={(scriptState) => set({ scriptState })} testid={`${tid}-script-approval`} />
          </div>
          <TextArea value={scene.script} onChange={(script) => set({ script, scriptState: "draft" })} rows={5} testid={`${tid}-script`} />
          <Field label="Continuity notes">
            <TextArea value={scene.continuityNotes} onChange={(continuityNotes) => set({ continuityNotes })} rows={2} />
          </Field>
          {p.characters.length > 0 && (
            <div style={{ ...rowStyle, flexWrap: "wrap" }}>
              <FieldLabel>Cast</FieldLabel>
              {p.characters.map((c) => (
                <Checkbox
                  key={c.id}
                  label={c.name}
                  checked={scene.characterIds.includes(c.id)}
                  onChange={(on) =>
                    set({ characterIds: on ? [...scene.characterIds, c.id] : scene.characterIds.filter((id) => id !== c.id) })
                  }
                />
              ))}
            </div>
          )}
          <DialogueEditor p={p} scene={scene} production={production} tid={tid} />
          {writer && (
            <div style={{ ...rowStyle, flexWrap: "wrap" }}>
              <WriteButton label="Write script" busy={busy} testid={`${tid}-write-script`} onClick={() => void run("Write script", (cur, model) => sceneScriptTask(cur, latest(cur), model))} />
              <WriteButton label="Break into shots" busy={busy} testid={`${tid}-write-shots`} onClick={handleShotList} title="Writes this scene's shot list; shots that already have takes are kept" />
              <WriteButton label="Write dialogue" busy={busy} testid={`${tid}-write-dialogue`} onClick={() => void run("Write dialogue", (cur, model) => dialogueTask(cur, latest(cur), model))} />
              <WriteButton label="Continuity notes" busy={busy} testid={`${tid}-write-continuity`} onClick={() => void run("Continuity notes", (cur, model) => continuityTask(cur, latest(cur), model))} />
            </div>
          )}
          <ActionNote message={message} testid={`${tid}-write-message`} />
          {scene.shots.map((shot, shi) => (
            <ShotCard
              key={shot.id}
              p={p}
              scene={scene}
              sceneIndex={index}
              shot={shot}
              index={shi}
              open={expanded.has(shot.id)}
              onToggle={() => onToggleShot(shot.id)}
              production={production}
              library={library}
              store={store}
              morphic={morphic}
              writer={writer}
              flowExport={flowExport}
            />
          ))}
          <div>
            <Button
              size="small"
              testid={`${tid}-add-shot`}
              onClick={() =>
                production.update((cur) => addShot(cur, scene.id, { title: `Shot ${scene.shots.length + 1}`, characterIds: scene.characterIds }).production)
              }
            >
              + Shot
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

interface ShotCardProps {
  p: Production;
  scene: Scene;
  sceneIndex: number;
  shot: Shot;
  index: number;
  open: boolean;
  onToggle: () => void;
  production: ProductionStore;
  library: ProductionLibrary;
  store?: EditorStore;
  morphic?: StudioMorphic;
  writer?: StudioWriter;
  flowExport?: FlowExport;
}

function ShotCard({ p, scene, sceneIndex, shot, index, open, onToggle, production, library, store, morphic, writer, flowExport }: ShotCardProps) {
  const writing = useWriterAction(production, writer);
  const fileInput = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState<ShotProvider>("import");
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const set = (patch: Partial<Omit<Shot, "id" | "takes">>) => production.update((cur) => updateShot(cur, shot.id, patch));
  const tid = `shot-${sceneIndex}-${index}`;
  const timeline = store?.getSnapshot().timeline;
  const placed = timeline ? isShotPlaced(timeline, shot.timelineClipId) : false;
  const approvedRaw = shot.approvedTakeId ? library.entry(shot.approvedTakeId) : undefined;
  // Imports are placeholder-first: until the bytes land, duration is 0 and the media can't be cut.
  const approvedEntry = approvedRaw && !approvedRaw.generationStatus ? approvedRaw : undefined;
  const approvedPending = approvedRaw !== undefined && approvedEntry === undefined;

  const shotFolder = () =>
    ensureFolderPath(library, ["Production", numbered(sceneIndex, scene.title, "Scene"), numbered(index, shot.title, "Shot")]);

  // Starts one Morphic take; the shot reads "generating" until the media lands (or fails) in the library.
  const handleMorphic = async () => {
    if (!morphic) return;
    setGenerating(true);
    setMessage(null);
    try {
      const name = `${numbered(index, shot.title, "Shot")} · Morphic take ${shot.takes.length + 1}`;
      const r = await morphic.generateShotTake(production.getSnapshot(), scene, shot, { name, folderId: shotFolder() });
      if ("error" in r) {
        setMessage({ text: r.error, error: true });
        return;
      }
      production.update((cur) => setShotStatus(attachTake(cur, shot.id, { mediaId: r.placeholderId, provider: "morphic" }), shot.id, "generating"));
      setMessage({ text: r.projectName ? `Sent to Morphic (project "${r.projectName}"). The take appears here when it's ready.` : "Sent to Morphic.", error: false });
    } finally {
      setGenerating(false);
    }
  };

  const handleImport = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    setMessage(null);
    try {
      const entries = await library.importFiles(files, shotFolder());
      production.update((cur) => entries.reduce((acc, e) => attachTake(acc, shot.id, { mediaId: e.id, provider: source }), cur));
    } catch (e) {
      setMessage({ text: `Import failed: ${e instanceof Error ? e.message : String(e)}`, error: true });
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const handleCopyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(shotPrompt(production.getSnapshot(), scene, shot));
      setMessage({ text: "Prompt copied (with camera, cast and continuity).", error: false });
    } catch {
      setMessage({ text: "Couldn't copy to the clipboard.", error: true });
    }
  };

  // Google Flow has no API: write prompt.txt, shot.md and up to three reference images to a folder.
  const handleFlow = async () => {
    if (!flowExport) return;
    setBusy(true);
    setMessage(null);
    try {
      const entries = library.getSnapshot().entries;
      const imageIds = new Set(entries.filter((e) => e.type === "image" && !e.generationStatus).map((e) => e.id));
      const pack = buildFlowPack(production.getSnapshot(), scene, shot, imageIds);
      const images: { name: string; bytes: Uint8Array }[] = [];
      for (const [i, id] of pack.referenceIds.entries()) {
        if (!library.readEntryBytes) break;
        const entry = entries.find((e) => e.id === id)!;
        const path = entry.source.kind === "project" ? entry.source.relativePath : entry.source.absolutePath;
        const ext = (path.split(".").pop() ?? "png").toLowerCase().slice(0, 5);
        images.push({ name: `ref-${i + 1}.${ext}`, bytes: await library.readEntryBytes(id) });
      }
      const r = await flowExport(pack, images);
      if ("error" in r) setMessage({ text: `Couldn't save the hand-off: ${r.error}`, error: true });
      else if ("path" in r) {
        set({ provider: "flow-manual" });
        setSource("flow-manual");
        setMessage({ text: `Saved to ${r.path}. Generate in Google Flow, then Import take… here.`, error: false });
      }
    } catch (e) {
      setMessage({ text: `Couldn't prepare the hand-off: ${e instanceof Error ? e.message : String(e)}`, error: true });
    } finally {
      setBusy(false);
    }
  };

  const handlePlace = () => {
    if (!store || !approvedEntry) return;
    let clipId: string | null = null;
    store.dispatch(placeShotCommand(production.getSnapshot(), shot.id, approvedEntry, (id) => (clipId = id)));
    if (clipId) production.update((cur) => linkShotClip(cur, shot.id, clipId!));
    else setMessage({ text: "Could not place this take on the timeline.", error: true });
  };

  const handleReplace = () => {
    if (!store || !approvedEntry || !shot.timelineClipId) return;
    const r = replaceShotClip(store.getSnapshot().timeline, shot.timelineClipId, approvedEntry);
    if (!r.ok) {
      setMessage({ text: r.message, error: true });
      return;
    }
    store.dispatch(r.command);
    setMessage(null);
  };

  return (
    <div style={{ ...cardStyle, background: theme.bg.raised }} data-testid={tid}>
      <div style={rowStyle}>
        <IconButton frame="sm" title={open ? "Collapse" : "Expand"} onClick={onToggle} testid={`${tid}-toggle`}>
          <Icon name={open ? "chevron-down" : "chevron-right"} size={10} />
        </IconButton>
        <TextInput value={shot.title} onChange={(title) => set({ title })} testid={`${tid}-title`} style={{ flex: 1, minWidth: 0 }} />
        <StatusChip status={shot.status} testid={`${tid}-status`} />
        <IconButton frame="sm" title="Move up" disabled={index === 0} onClick={() => production.update((cur) => moveShot(cur, shot.id, index - 1))}>
          <Icon name="chevron-up" size={10} />
        </IconButton>
        <IconButton frame="sm" title="Delete shot" testid={`${tid}-delete`} onClick={() => production.update((cur) => removeShot(cur, shot.id))}>
          <Icon name="trash" size={10} />
        </IconButton>
      </div>
      {open && (
        <>
          <Field label="Action / description">
            <TextArea value={shot.description} onChange={(description) => set({ description })} rows={2} testid={`${tid}-description`} />
          </Field>
          <div style={rowStyle}>
            <Field label="Seconds">
              <TextInput
                type="number"
                min={0.5}
                step={0.5}
                value={String(shot.durationSec)}
                onChange={(v) => {
                  const n = Number(v);
                  if (Number.isFinite(n) && n > 0) set({ durationSec: n });
                }}
                style={{ width: "4em" }}
              />
            </Field>
            <Field label="Camera">
              <TextInput value={shot.camera} onChange={(camera) => set({ camera })} placeholder="e.g. low-angle dolly in" />
            </Field>
            <Field label="Framing">
              <TextInput value={shot.framing} onChange={(framing) => set({ framing })} placeholder="e.g. medium close-up" />
            </Field>
          </div>
          {p.characters.length > 0 && (
            <div style={{ ...rowStyle, flexWrap: "wrap" }}>
              <FieldLabel>In shot</FieldLabel>
              {p.characters.map((c) => (
                <Checkbox
                  key={c.id}
                  label={c.name}
                  checked={shot.characterIds.includes(c.id)}
                  onChange={(on) => set({ characterIds: on ? [...shot.characterIds, c.id] : shot.characterIds.filter((id) => id !== c.id) })}
                />
              ))}
            </div>
          )}
          <div style={rowStyle}>
            <FieldLabel>Generation prompt</FieldLabel>
            <div style={{ flex: 1 }} />
            <ApprovalToggle state={shot.promptState} onChange={(promptState) => set({ promptState })} testid={`${tid}-prompt-approval`} />
          </div>
          <TextArea value={shot.prompt} onChange={(prompt) => set({ prompt, promptState: "draft" })} rows={3} testid={`${tid}-prompt`} />
          <div style={{ ...rowStyle, flexWrap: "wrap" }}>
            {writer && (
              <WriteButton
                label="Write prompt"
                busy={writing.busy}
                testid={`${tid}-write-prompt`}
                title="Writes a video prompt from the action, camera, framing and the cast's looks"
                onClick={() =>
                  void writing.run("Write prompt", (cur, model) => {
                    const sc = cur.scenes.find((s) => s.id === scene.id) ?? scene;
                    return shotPromptTask(cur, sc, sc.shots.find((s) => s.id === shot.id) ?? shot, model);
                  })
                }
              />
            )}
            <Button size="small" testid={`${tid}-copy-prompt`} onClick={() => void handleCopyPrompt()} title="Copies the prompt plus camera, framing, cast and continuity">
              Copy prompt
            </Button>
            {flowExport && (
              <Button size="small" disabled={busy} testid={`${tid}-flow`} onClick={() => void handleFlow()} title="Saves prompt.txt, a shot sheet and up to 3 reference images to a folder for Google Flow">
                Prepare for Flow…
              </Button>
            )}
          </div>
          <ActionNote message={writing.message} testid={`${tid}-write-message`} />
          <div style={rowStyle}>
            <FieldLabel>Status</FieldLabel>
            <Select
              value={MANUAL_STATUSES.some((s) => s.value === shot.status) ? shot.status : null}
              placeholder="Set…"
              options={MANUAL_STATUSES}
              onChange={(status) => production.update((cur) => (status === "needs-regen" ? markNeedsRegen(cur, shot.id) : setShotStatus(cur, shot.id, status)))}
              testid={`${tid}-status-select`}
            />
          </div>
          {shot.lastError && (
            <div style={{ fontSize: theme.fontSize.xs, color: theme.status.error }} data-testid={`${tid}-error`}>
              {shot.lastError}
            </div>
          )}

          <FieldLabel>Takes ({shot.takes.length})</FieldLabel>
          <div style={{ ...rowStyle, flexWrap: "wrap" }} data-testid={`${tid}-takes`}>
            {shot.takes.map((take, ti) => {
              const entry = library.entry(take.mediaId);
              const approved = shot.approvedTakeId === take.mediaId;
              return (
                <div key={take.mediaId} style={{ display: "flex", flexDirection: "column", gap: theme.spacing.xxs, alignItems: "center" }}>
                  <Thumb src={library.thumbnail(take.mediaId)} label={entry?.name ?? "missing"} selected={approved} testid={`${tid}-take-${ti}`} />
                  {entry?.generationStatus && (
                    <span style={{ fontSize: theme.fontSize.xxs, color: theme.text.tertiary }} data-testid={`${tid}-take-${ti}-pending`}>
                      {generatingLabel(parseGenerationStatus(entry.generationStatus))}
                    </span>
                  )}
                  <Button
                    size="small"
                    variant={approved ? "accent" : "default"}
                    disabled={approved}
                    testid={`${tid}-take-${ti}-approve`}
                    onClick={() => production.update((cur) => approveTake(cur, shot.id, take.mediaId))}
                  >
                    {approved ? "Approved" : "Approve"}
                  </Button>
                </div>
              );
            })}
          </div>
          <div style={{ ...rowStyle, flexWrap: "wrap" }}>
            <input
              ref={fileInput}
              type="file"
              accept="video/*,image/*"
              multiple
              style={{ display: "none" }}
              data-testid={`${tid}-import-input`}
              onChange={(e) => void handleImport(e.target.files)}
            />
            <Select value={source} options={IMPORT_SOURCES} onChange={setSource} testid={`${tid}-import-source`} />
            <Button size="small" disabled={busy} testid={`${tid}-import`} onClick={() => fileInput.current?.click()}>
              {busy ? "Importing…" : "Import take…"}
            </Button>
            {morphic && (
              <Button
                size="small"
                disabled={generating || shot.status === "generating"}
                testid={`${tid}-morphic`}
                onClick={() => void handleMorphic()}
                title="Generate a new take in Morphic from this shot's prompt, using the cast's approved designs as references"
              >
                {generating ? "Sending…" : "Generate in Morphic"}
              </Button>
            )}
            {store && (
              placed ? (
                <Button size="small" disabled={!approvedEntry} testid={`${tid}-replace`} onClick={handleReplace} title="Swap the approved take into this shot's clip; timing and effects are kept">
                  Replace on timeline
                </Button>
              ) : (
                <Button size="small" disabled={!approvedEntry} testid={`${tid}-place`} onClick={handlePlace} title="Insert the approved take at this shot's place in the story">
                  Place on timeline
                </Button>
              )
            )}
          </div>
          {approvedPending && (
            <div style={{ fontSize: theme.fontSize.xs, color: theme.text.tertiary }} data-testid={`${tid}-pending`}>
              The approved take is still importing — it can be placed once it's ready.
            </div>
          )}
          {message && (
            <div style={{ fontSize: theme.fontSize.xs, color: message.error ? theme.status.error : theme.text.secondary }} data-testid={`${tid}-message`}>
              {message.text}
            </div>
          )}
        </>
      )}
    </div>
  );
}
