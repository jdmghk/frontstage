import { useRef, useState, useSyncExternalStore } from "react";
import type { ChoreoShot, Choreography, Production } from "@frontstage/core";
import {
  ChoreoShotSchema,
  addChoreography,
  approveChoreographyToScene,
  removeChoreography,
  setChoreoShots,
  updateChoreoShot,
  updateChoreography,
} from "@frontstage/core";
import type { SampledFrame } from "@frontstage/ai";
import { choreographyTask, choreoSampleFps, MAX_CHOREO_FRAMES } from "@frontstage/ai";
import { theme } from "../theme/theme.js";
import { Button, Checkbox, Icon, IconButton, Select, TextInput } from "../primitives/index.js";
import { ensureFolderPath, numbered, type ProductionStore } from "./production-store.js";
import type { ProductionLibrary } from "./ProductionTab.js";
import { Field, FieldLabel, StatusChip, TextArea, Thumb, cardStyle, rowStyle, scrollColumnStyle } from "./fields.js";
import { ActionNote, WriteButton, useWriterAction, type StudioWriter } from "./writer-ui.js";

/** Samples JPEG frames from a library video (desktop: bundled ffmpeg). */
export type FrameSampler = (mediaId: string, fps: number, maxFrames: number) => Promise<{ frames: SampledFrame[] } | { error: string }>;

export interface ChoreoTabProps {
  production: ProductionStore;
  library: ProductionLibrary;
  writer?: StudioWriter;
  sampleFrames?: FrameSampler;
}

const note = (error = false): React.CSSProperties => ({ fontSize: theme.fontSize.xs, color: error ? theme.status.error : theme.text.secondary });

function NewReferenceForm({ production, library, onDone }: { production: ProductionStore; library: ProductionLibrary; onDone: () => void }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [permission, setPermission] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const [entry] = await library.importFiles([file], ensureFolderPath(library, ["Choreography"]));
      if (!entry || entry.type !== "video") return setError("Choose a video file.");
      let failed: string | null = null;
      production.update((cur) => {
        const r = addChoreography(cur, { title: title.trim() || file.name, referenceMediaId: entry.id, permission: { attested: permission } });
        if ("error" in r) {
          failed = r.error;
          return cur;
        }
        return r.production;
      });
      if (failed) setError(failed);
      else onDone();
    } catch (e) {
      setError(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ ...cardStyle, background: theme.bg.raised }} data-testid="choreo-new">
      <Field label="Title">
        <TextInput value={title} placeholder="e.g. Rooftop exchange" onChange={setTitle} testid="choreo-new-title" />
      </Field>
      <div style={rowStyle}>
        <input ref={fileInput} type="file" accept="video/*" style={{ display: "none" }} data-testid="choreo-new-file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <Button size="small" onClick={() => fileInput.current?.click()} testid="choreo-new-pick">
          {file ? "Change video…" : "Reference video…"}
        </Button>
        <span style={{ ...note(), flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{file?.name ?? "Short clips (under ~20 s) analyze best"}</span>
      </div>
      <Checkbox label="I own this video or have permission to use it as a reference." checked={permission} onChange={setPermission} testid="choreo-new-permission" />
      <div style={rowStyle}>
        <Button size="small" variant="accent" disabled={busy || !file || !permission} onClick={() => void create()} testid="choreo-new-create">
          {busy ? "Adding…" : "Add reference"}
        </Button>
        <Button size="small" onClick={onDone}>
          Cancel
        </Button>
      </div>
      {error && (
        <div style={note(true)} data-testid="choreo-new-error">
          {error}
        </div>
      )}
    </div>
  );
}

const SHOT_TEXT_FIELDS: { key: keyof ChoreoShot & ("startPositions" | "action" | "camera" | "framing" | "transitions" | "continuity" | "prompt"); label: string; rows: number }[] = [
  { key: "startPositions", label: "Starting positions", rows: 1 },
  { key: "action", label: "Action", rows: 2 },
  { key: "camera", label: "Camera", rows: 1 },
  { key: "framing", label: "Framing", rows: 1 },
  { key: "transitions", label: "Transition to next", rows: 1 },
  { key: "continuity", label: "Continuity", rows: 1 },
  { key: "prompt", label: "Generation prompt", rows: 3 },
];

const numberList = (s: string) =>
  s
    .split(/[,\s]+/)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n >= 0);

function ChoreoCard({ p, c, index, production, library, writer, sampleFrames }: {
  p: Production;
  c: Choreography;
  index: number;
  production: ProductionStore;
  library: ProductionLibrary;
  writer?: StudioWriter;
  sampleFrames?: FrameSampler;
}) {
  const tid = `choreo-${index}`;
  const { busy, message, setMessage, run } = useWriterAction(production, writer);
  const [sceneId, setSceneId] = useState<string>(c.sceneId ?? p.scenes[0]?.id ?? "");
  const ref = library.entry(c.referenceMediaId);
  const setShot = (shotId: string, patch: Partial<Omit<ChoreoShot, "id">>) => production.update((cur) => updateChoreoShot(cur, c.id, shotId, patch));

  const analyze = async () => {
    if (!sampleFrames || !ref) return;
    setMessage({ text: "Sampling frames…", error: false });
    const fps = choreoSampleFps(ref.duration);
    const sampled = await sampleFrames(c.referenceMediaId, fps, MAX_CHOREO_FRAMES);
    if ("error" in sampled) return setMessage({ text: `Couldn't read frames: ${sampled.error}`, error: true });
    await run("Analyze", (cur, model) => choreographyTask(cur, cur.choreographies.find((x) => x.id === c.id) ?? c, sampled.frames, model));
  };

  const approve = () => {
    let outcome: string | null = null;
    production.update((cur) => {
      const r = approveChoreographyToScene(cur, c.id, sceneId);
      if ("error" in r) {
        outcome = r.error;
        return cur;
      }
      return r.production;
    });
    setMessage(outcome ? { text: outcome, error: true } : { text: `Added ${c.shots.length} shots to the scene. Generate them from the Production tab.`, error: false });
  };

  return (
    <div style={cardStyle} data-testid={tid}>
      <div style={rowStyle}>
        <TextInput value={c.title} onChange={(title) => production.update((cur) => updateChoreography(cur, c.id, { title }))} style={{ flex: 1, minWidth: 0 }} testid={`${tid}-title`} />
        <StatusChip status={c.state} testid={`${tid}-state`} />
        <IconButton frame="sm" title="Delete plan (the reference video stays in the library)" testid={`${tid}-delete`} onClick={() => production.update((cur) => removeChoreography(cur, c.id))}>
          <Icon name="trash" size={10} />
        </IconButton>
      </div>
      <div style={rowStyle}>
        <Thumb src={library.thumbnail(c.referenceMediaId)} label={ref?.name ?? "reference missing"} />
        <div style={{ ...note(), flex: 1 }}>Permission confirmed {c.permission.date.slice(0, 10)}</div>
      </div>
      <Field label="Notes for the analysis">
        <TextArea
          value={c.notes}
          onChange={(notes) => production.update((cur) => updateChoreography(cur, c.id, { notes }))}
          rows={2}
          placeholder="Who is who (fighter in red = Kai) and what to focus on"
          testid={`${tid}-notes`}
        />
      </Field>
      <div style={{ ...rowStyle, flexWrap: "wrap" }}>
        {writer && sampleFrames ? (
          <WriteButton label="Analyze" busy={busy} testid={`${tid}-analyze`} onClick={() => void analyze()} title={`Samples up to ${MAX_CHOREO_FRAMES} frames and asks Claude for a shot plan`} />
        ) : (
          <span style={note()}>Analysis needs the desktop app and an Anthropic key. You can still write the plan by hand.</span>
        )}
        <Button size="small" testid={`${tid}-add-shot`} onClick={() => production.update((cur) => setChoreoShots(cur, c.id, [...c.shots, ChoreoShotSchema.parse({})]))}>
          + Shot
        </Button>
      </div>
      <ActionNote message={message} testid={`${tid}-message`} />

      {c.shots.map((s, si) => (
        <div key={s.id} style={{ ...cardStyle, background: theme.bg.raised }} data-testid={`${tid}-shot-${si}`}>
          <div style={rowStyle}>
            <span style={{ fontSize: theme.fontSize.xs, fontWeight: theme.fontWeight.medium, color: theme.text.primary }}>Shot {si + 1}</span>
            <div style={{ flex: 1 }} />
            <IconButton frame="xs" title="Remove shot" onClick={() => production.update((cur) => setChoreoShots(cur, c.id, c.shots.filter((x) => x.id !== s.id)))}>
              <Icon name="x" size={8} />
            </IconButton>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: theme.spacing.xs }}>
            <Field label="Seconds">
              <TextInput value={String(s.durationSec)} onChange={(v) => Number(v) > 0 && setShot(s.id, { durationSec: Number(v) })} testid={`${tid}-shot-${si}-duration`} />
            </Field>
            <Field label="Characters">
              <TextInput value={s.characters.join(", ")} onChange={(v) => setShot(s.id, { characters: v.split(",").map((x) => x.trim()).filter(Boolean) })} />
            </Field>
            <Field label="Impacts (s)">
              <TextInput value={s.impactTimesSec.join(", ")} onChange={(v) => setShot(s.id, { impactTimesSec: numberList(v) })} />
            </Field>
          </div>
          {SHOT_TEXT_FIELDS.map((f) => (
            <Field key={f.key} label={f.label}>
              <TextArea value={s[f.key]} onChange={(v) => setShot(s.id, { [f.key]: v })} rows={f.rows} testid={`${tid}-shot-${si}-${f.key}`} />
            </Field>
          ))}
        </div>
      ))}

      {c.shots.length > 0 && (
        <div style={{ ...rowStyle, flexWrap: "wrap" }}>
          <FieldLabel>Add to scene</FieldLabel>
          <Select
            value={sceneId || null}
            placeholder="Choose…"
            options={p.scenes.map((s, i) => ({ value: s.id, label: numbered(i, s.title, "Scene") }))}
            onChange={setSceneId}
            testid={`${tid}-scene`}
          />
          <Button size="small" variant="accent" disabled={!sceneId} testid={`${tid}-approve`} onClick={approve} title="Approves the plan and appends its shots to the scene">
            Approve → add shots
          </Button>
        </div>
      )}
    </div>
  );
}

export function ChoreoTab({ production, library, writer, sampleFrames }: ChoreoTabProps) {
  const p = useSyncExternalStore(production.subscribe.bind(production), () => production.getSnapshot());
  useSyncExternalStore(library.subscribe.bind(library), () => library.getSnapshot().entries);
  const [adding, setAdding] = useState(false);
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }} data-testid="choreo-tab">
      <div style={{ ...rowStyle, height: theme.size.panelHeader, padding: `0 ${theme.spacing.sm}`, flexShrink: 0 }}>
        <Button testid="choreo-add" disabled={adding} onClick={() => setAdding(true)}>
          <span style={rowStyle}>
            <Icon name="plus" size={10} />
            Reference
          </span>
        </Button>
      </div>
      <div style={scrollColumnStyle}>
        <div style={note()} data-testid="choreo-disclaimer">
          This analyzes a reference fight into a shot plan: positions, moves, camera and hit timing. Approved shots also
          keep the reference as a motion reference, which Generate in Morphic sends to models that accept reference
          video. That guides movement; it isn't an exact copy, and results will differ from the reference.
        </div>
        {adding && <NewReferenceForm production={production} library={library} onDone={() => setAdding(false)} />}
        {p.choreographies.map((c, i) => (
          <ChoreoCard key={c.id} p={p} c={c} index={i} production={production} library={library} writer={writer} sampleFrames={sampleFrames} />
        ))}
      </div>
    </div>
  );
}
