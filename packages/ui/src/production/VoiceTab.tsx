import { useRef, useState, useSyncExternalStore } from "react";
import type { DialogueLine, EditorStore, Production, Scene, VoiceLanguage } from "@frontstage/core";
import {
  VOICE_LANGUAGES,
  addVoiceProfile,
  approveLineTake,
  attachLineTake,
  isShotPlaced,
  linkLineClip,
  parseGenerationStatus,
  placeLineCommand,
  removeVoiceProfile,
  replaceShotClip,
  setCharacterVoice,
  setLineShot,
  setNarratorVoice,
  speakerName,
  updateVoiceProfile,
  voiceForLine,
} from "@frontstage/core";
import { theme } from "../theme/theme.js";
import { generatingLabel } from "../media/GeneratingOverlay.js";
import { Button, Checkbox, Icon, IconButton, Select, TextInput } from "../primitives/index.js";
import { ensureFolderPath, numbered, type ProductionStore } from "./production-store.js";
import type { ProductionLibrary } from "./ProductionTab.js";
import { Field, FieldLabel, StatusChip, cardStyle, rowStyle, scrollColumnStyle } from "./fields.js";
import type { FlowExport } from "./writer-ui.js";

/** Speech generation for one line (host: fal-hosted Chatterbox). */
export interface StudioVoice {
  generateLine(p: Production, lineId: string, opts: { name: string; folderId?: string }): Promise<{ placeholderId: string } | { error: string }>;
}

export interface VoiceTabProps {
  production: ProductionStore;
  library: ProductionLibrary;
  store?: EditorStore;
  voice?: StudioVoice;
  /** Saves approved dialogue to a folder; omitted -> hidden. */
  exportFolder?: FlowExport;
}

const noopSubscribe = () => () => {};
const LANGUAGE_OPTIONS = VOICE_LANGUAGES.map((l) => ({ value: l, label: l[0]!.toUpperCase() + l.slice(1) }));
const note = (error: boolean): React.CSSProperties => ({ fontSize: theme.fontSize.xs, color: error ? theme.status.error : theme.text.secondary });

let currentAudio: HTMLAudioElement | null = null;

/** Plays a library audio entry from its bytes; one clip at a time. */
function PlayButton({ library, mediaId, testid }: { library: ProductionLibrary; mediaId: string; testid: string }) {
  const entry = library.entry(mediaId);
  const ready = !!entry && !entry.generationStatus && !!library.readEntryBytes;
  return (
    <IconButton
      frame="sm"
      title="Play"
      disabled={!ready}
      testid={testid}
      onClick={async () => {
        if (!library.readEntryBytes) return;
        const bytes = await library.readEntryBytes(mediaId);
        currentAudio?.pause();
        const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
        currentAudio = new Audio(url);
        currentAudio.onended = () => URL.revokeObjectURL(url);
        void currentAudio.play();
      }}
    >
      <Icon name="play" size={10} />
    </IconButton>
  );
}

function NewVoiceForm({ production, library, onDone }: { production: ProductionStore; library: ProductionLibrary; onDone: () => void }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [language, setLanguage] = useState<VoiceLanguage>("english");
  const [file, setFile] = useState<File | null>(null);
  const [consent, setConsent] = useState(false);
  const [consentNote, setConsentNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const [entry] = await library.importFiles([file], ensureFolderPath(library, ["Voices"]));
      if (!entry || entry.type !== "audio") {
        setError("Choose an audio recording (WAV, MP3, M4A…).");
        return;
      }
      let failed: string | null = null;
      production.update((cur) => {
        const r = addVoiceProfile(cur, { name, referenceMediaId: entry.id, language, consent: { attested: consent, note: consentNote } });
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
    <div style={{ ...cardStyle, background: theme.bg.raised }} data-testid="voice-new">
      <Field label="Name">
        <TextInput value={name} placeholder="e.g. Kai (my voice)" onChange={setName} testid="voice-new-name" />
      </Field>
      <div style={rowStyle}>
        <input ref={fileInput} type="file" accept="audio/*" style={{ display: "none" }} data-testid="voice-new-file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <Button size="small" onClick={() => fileInput.current?.click()} testid="voice-new-pick">
          {file ? "Change recording…" : "Reference recording…"}
        </Button>
        <span style={{ ...note(false), flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{file?.name ?? "A short, clean recording of one speaker"}</span>
      </div>
      <div style={rowStyle}>
        <FieldLabel>Language</FieldLabel>
        <Select value={language} options={LANGUAGE_OPTIONS} onChange={setLanguage} testid="voice-new-language" />
      </div>
      <Checkbox
        label="This is my own voice, or I have the speaker's permission to clone it for this project."
        checked={consent}
        onChange={setConsent}
        testid="voice-new-consent"
      />
      <TextInput value={consentNote} placeholder="Permission note (who, when) — optional" onChange={setConsentNote} testid="voice-new-consent-note" />
      <div style={rowStyle}>
        <Button size="small" variant="accent" disabled={busy || !name.trim() || !file || !consent} onClick={() => void create()} testid="voice-new-create">
          {busy ? "Adding…" : "Create voice"}
        </Button>
        <Button size="small" onClick={onDone}>
          Cancel
        </Button>
      </div>
      {error && (
        <div style={note(true)} data-testid="voice-new-error">
          {error}
        </div>
      )}
    </div>
  );
}

function LineRow({ p, scene, sceneIndex, line, index, production, library, store, voice }: {
  p: Production;
  scene: Scene;
  sceneIndex: number;
  line: DialogueLine;
  index: number;
  production: ProductionStore;
  library: ProductionLibrary;
  store?: EditorStore;
  voice?: StudioVoice;
}) {
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [sending, setSending] = useState(false);
  const tid = `voice-line-${sceneIndex}-${index}`;
  const v = voiceForLine(p, line);
  const approvedRaw = line.approvedTakeId ? library.entry(line.approvedTakeId) : undefined;
  const approved = approvedRaw && !approvedRaw.generationStatus ? approvedRaw : undefined;
  const timeline = store?.getSnapshot().timeline;
  const placed = timeline ? isShotPlaced(timeline, line.timelineClipId) : false;
  const shotOptions = [{ value: "", label: "Scene start" }, ...scene.shots.map((s, i) => ({ value: s.id, label: numbered(i, s.title, "Shot") }))];

  const generate = async () => {
    if (!voice) return;
    setSending(true);
    setMessage(null);
    try {
      const cur = production.getSnapshot();
      const name = `S${String(sceneIndex + 1).padStart(2, "0")} L${String(index + 1).padStart(2, "0")} ${speakerName(cur, line)}`;
      const folderId = ensureFolderPath(library, ["Production", numbered(sceneIndex, scene.title, "Scene"), "Dialogue"]);
      const r = await voice.generateLine(cur, line.id, { name, folderId });
      if ("error" in r) setMessage({ text: r.error, error: true });
      else production.update((c) => attachLineTake(c, line.id, r.placeholderId));
    } finally {
      setSending(false);
    }
  };

  const place = () => {
    if (!store || !approved) return;
    let clipId: string | null = null;
    const r = placeLineCommand(production.getSnapshot(), store.getSnapshot().timeline, line.id, approved, (id) => (clipId = id));
    if (!r.ok) return setMessage({ text: r.message, error: true });
    store.dispatch(r.command);
    if (clipId) production.update((c) => linkLineClip(c, line.id, clipId!));
  };

  const replace = () => {
    if (!store || !approved || !line.timelineClipId) return;
    const r = replaceShotClip(store.getSnapshot().timeline, line.timelineClipId, approved);
    if (!r.ok) return setMessage({ text: r.message, error: true });
    store.dispatch(r.command);
  };

  return (
    <div style={{ ...cardStyle, background: theme.bg.raised }} data-testid={tid}>
      <div style={rowStyle}>
        <span style={{ fontSize: theme.fontSize.xs, fontWeight: theme.fontWeight.medium, color: theme.text.primary }}>{speakerName(p, line)}</span>
        <span style={{ ...note(false), flex: 1, color: v ? theme.text.tertiary : theme.status.error }}>{v ? v.name : "no voice"}</span>
        <StatusChip status={line.status} testid={`${tid}-status`} />
      </div>
      <div style={{ fontSize: theme.fontSize.sm, color: theme.text.primary }}>{line.text || <em>empty line</em>}</div>
      {line.direction && <div style={note(false)}>({line.direction})</div>}
      {line.lastError && line.status === "failed" && (
        <div style={note(true)} data-testid={`${tid}-error`}>
          {line.lastError}
        </div>
      )}
      <div style={{ ...rowStyle, flexWrap: "wrap" }}>
        {line.takes.map((id, ti) => {
          const e = library.entry(id);
          const isApproved = line.approvedTakeId === id;
          return (
            <div key={id} style={{ ...rowStyle, gap: theme.spacing.xxs }}>
              <PlayButton library={library} mediaId={id} testid={`${tid}-take-${ti}-play`} />
              {e?.generationStatus ? (
                <span style={note(false)} data-testid={`${tid}-take-${ti}-pending`}>{generatingLabel(parseGenerationStatus(e.generationStatus))}</span>
              ) : (
                <Button size="small" variant={isApproved ? "accent" : "default"} disabled={isApproved} testid={`${tid}-take-${ti}-approve`} onClick={() => production.update((c) => approveLineTake(c, line.id, id))}>
                  {isApproved ? `Take ${ti + 1} ✓` : `Take ${ti + 1}`}
                </Button>
              )}
            </div>
          );
        })}
      </div>
      <div style={{ ...rowStyle, flexWrap: "wrap" }}>
        {voice && (
          <Button size="small" disabled={sending || line.status === "generating"} testid={`${tid}-generate`} onClick={() => void generate()}>
            {sending ? "Sending…" : line.takes.length ? "Regenerate" : "Generate"}
          </Button>
        )}
        <Select value={line.shotId ?? ""} options={shotOptions} onChange={(id) => production.update((c) => setLineShot(c, line.id, id || undefined))} testid={`${tid}-shot`} />
        {store &&
          (placed ? (
            <Button size="small" disabled={!approved} testid={`${tid}-replace`} onClick={replace} title="Swap the approved take into this line's clip">
              Replace on timeline
            </Button>
          ) : (
            <Button size="small" disabled={!approved} testid={`${tid}-place`} onClick={place} title="Add the approved take under its shot, after the previous line">
              Place on timeline
            </Button>
          ))}
      </div>
      {message && (
        <div style={note(message.error)} data-testid={`${tid}-message`}>
          {message.text}
        </div>
      )}
    </div>
  );
}

export function VoiceTab({ production, library, store, voice, exportFolder }: VoiceTabProps) {
  const p = useSyncExternalStore(production.subscribe.bind(production), () => production.getSnapshot());
  useSyncExternalStore(library.subscribe.bind(library), () => library.getSnapshot().entries);
  useSyncExternalStore(store ? store.subscribe.bind(store) : noopSubscribe, () => store?.getSnapshot());
  const [adding, setAdding] = useState(false);
  const [exportMsg, setExportMsg] = useState<{ text: string; error: boolean } | null>(null);
  const voiceOptions = [{ value: "", label: "No voice" }, ...p.voices.map((v) => ({ value: v.id, label: v.name }))];
  const scenesWithLines = p.scenes.map((s, i) => ({ s, i })).filter(({ s }) => s.dialogue.length > 0);

  const exportApproved = async () => {
    if (!exportFolder || !library.readEntryBytes) return;
    const files: { name: string; bytes: Uint8Array }[] = [];
    const transcript: string[] = [];
    for (const { s, i } of scenesWithLines) {
      for (const [li, line] of s.dialogue.entries()) {
        const id = line.approvedTakeId;
        const entry = id ? library.entry(id) : undefined;
        if (!entry || entry.generationStatus) continue;
        const path = entry.source.kind === "project" ? entry.source.relativePath : entry.source.absolutePath;
        const ext = (path.split(".").pop() ?? "wav").toLowerCase().slice(0, 5);
        const base = `S${String(i + 1).padStart(2, "0")}-L${String(li + 1).padStart(2, "0")} ${speakerName(p, line).replace(/[\\/:*?"<>|]/g, " ")}`;
        files.push({ name: `${base}.${ext}`, bytes: await library.readEntryBytes(id!) });
        transcript.push(`${base}: ${line.text}`);
      }
    }
    if (files.length === 0) return setExportMsg({ text: "Approve at least one take first.", error: true });
    const r = await exportFolder({ folderName: "Dialogue", files: [{ name: "lines.txt", text: transcript.join("\n") + "\n" }], referenceIds: [] }, files);
    if ("error" in r) setExportMsg({ text: r.error, error: true });
    else if ("path" in r) setExportMsg({ text: `Saved ${files.length} lines to ${r.path}.`, error: false });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }} data-testid="voice-tab">
      <div style={{ ...rowStyle, height: theme.size.panelHeader, padding: `0 ${theme.spacing.sm}`, flexShrink: 0 }}>
        <Button testid="voice-add" onClick={() => setAdding(true)} disabled={adding}>
          <span style={rowStyle}>
            <Icon name="plus" size={10} />
            Voice
          </span>
        </Button>
        <div style={{ flex: 1 }} />
        {exportFolder && library.readEntryBytes && (
          <Button testid="voice-export" onClick={() => void exportApproved()}>
            Export approved…
          </Button>
        )}
      </div>
      <div style={scrollColumnStyle}>
        {adding && <NewVoiceForm production={production} library={library} onDone={() => setAdding(false)} />}
        {exportMsg && (
          <div style={note(exportMsg.error)} data-testid="voice-export-message">
            {exportMsg.text}
          </div>
        )}
        {!voice && (
          <div style={note(false)}>Add a fal.ai key in Settings → Generation to generate speech. Voices and lines can still be set up.</div>
        )}

        <FieldLabel>Voices</FieldLabel>
        {p.voices.length === 0 && !adding && (
          <div style={{ fontSize: theme.fontSize.sm, color: theme.text.tertiary }}>
            A voice is made from a short reference recording you're allowed to use. Lines are spoken with fal.ai's
            Chatterbox model (no ElevenLabs account needed).
          </div>
        )}
        {p.voices.map((v, vi) => (
          <div key={v.id} style={{ ...rowStyle, flexWrap: "wrap" }} data-testid={`voice-${vi}`}>
            <PlayButton library={library} mediaId={v.referenceMediaId} testid={`voice-${vi}-play`} />
            <TextInput value={v.name} onChange={(name) => name.trim() && production.update((c) => updateVoiceProfile(c, v.id, { name }))} style={{ flex: 1, minWidth: 0 }} />
            <Select value={v.language} options={LANGUAGE_OPTIONS} onChange={(language) => production.update((c) => updateVoiceProfile(c, v.id, { language }))} />
            <IconButton frame="sm" title="Delete voice (recorded lines are kept)" testid={`voice-${vi}-delete`} onClick={() => production.update((c) => removeVoiceProfile(c, v.id))}>
              <Icon name="trash" size={10} />
            </IconButton>
          </div>
        ))}

        <FieldLabel>Who speaks with which voice</FieldLabel>
        <div style={rowStyle}>
          <span style={{ flex: 1, fontSize: theme.fontSize.sm, color: theme.text.primary }}>Narrator</span>
          <Select value={p.narratorVoiceId ?? ""} options={voiceOptions} onChange={(id) => production.update((c) => setNarratorVoice(c, id || undefined))} testid="voice-cast-narrator" />
        </div>
        {p.characters.map((c, ci) => (
          <div key={c.id} style={rowStyle}>
            <span style={{ flex: 1, fontSize: theme.fontSize.sm, color: theme.text.primary }}>{c.name}</span>
            <Select value={c.voiceProfileId ?? ""} options={voiceOptions} onChange={(id) => production.update((cur) => setCharacterVoice(cur, c.id, id || undefined))} testid={`voice-cast-${ci}`} />
          </div>
        ))}

        <FieldLabel>Lines</FieldLabel>
        {scenesWithLines.length === 0 && (
          <div style={{ fontSize: theme.fontSize.sm, color: theme.text.tertiary }}>
            Write dialogue on a scene in the Production tab (or with Claude's Write dialogue); the lines show up here.
          </div>
        )}
        {scenesWithLines.map(({ s, i }) => (
          <div key={s.id} style={{ display: "flex", flexDirection: "column", gap: theme.spacing.xs }}>
            <div style={{ fontSize: theme.fontSize.sm, fontWeight: theme.fontWeight.medium, color: theme.text.primary }}>{numbered(i, s.title, "Scene")}</div>
            {s.dialogue.map((line, li) => (
              <LineRow key={line.id} p={p} scene={s} sceneIndex={i} line={line} index={li} production={production} library={library} store={store} voice={voice} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
