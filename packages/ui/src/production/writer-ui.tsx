import { useState } from "react";
import type { DialogueLine, Production, Scene } from "@frontstage/core";
import { DialogueLineSchema, updateScene, updateStory } from "@frontstage/core";
import type { ClaudeGateway, FlowPack, WriterTask } from "@frontstage/ai";
import { charactersTask, outlineTask, runWriterTask } from "@frontstage/ai";
import { theme } from "../theme/theme.js";
import { Button, Icon, IconButton, Select, TextInput } from "../primitives/index.js";
import type { ProductionStore } from "./production-store.js";
import { ApprovalToggle, Field, FieldLabel, TextArea, cardStyle, rowStyle } from "./fields.js";

/** Claude writing, offered by the host (key + model live in Settings). */
export interface StudioWriter {
  gateway: ClaudeGateway;
  model(): string;
}

/** Saves a Google Flow hand-off folder (desktop: folder picker). Omitted -> the action is hidden. */
export type FlowExport = (
  pack: FlowPack,
  images: { name: string; bytes: Uint8Array }[],
) => Promise<{ path: string } | { canceled: true } | { error: string }>;

export type ActionMessage = { text: string; error: boolean } | null;

/** One writing action at a time per card; the result is applied to the latest production as a draft. */
export function useWriterAction(production: ProductionStore, writer: StudioWriter | undefined) {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<ActionMessage>(null);
  const run = async <T,>(label: string, make: (p: Production, model: string) => WriterTask<T>) => {
    if (!writer || busy) return;
    setBusy(label);
    setMessage(null);
    try {
      const r = await runWriterTask(writer.gateway, make(production.getSnapshot(), writer.model()), () => production.getSnapshot());
      if ("error" in r) {
        setMessage({ text: r.error, error: true });
        return;
      }
      production.update(() => r.production);
      setMessage({ text: r.summary, error: false });
    } finally {
      setBusy(null);
    }
  };
  return { busy, message, setMessage, run };
}

export function ActionNote({ message, testid }: { message: ActionMessage; testid: string }) {
  if (!message) return null;
  return (
    <div style={{ fontSize: theme.fontSize.xs, color: message.error ? theme.status.error : theme.text.secondary }} data-testid={testid}>
      {message.text}
    </div>
  );
}

/** A Claude action button: shows "Writing…" while its own task runs, disabled while any runs. */
export function WriteButton(props: { label: string; busy: string | null; onClick: () => void; testid: string; title?: string }) {
  return (
    <Button size="small" disabled={props.busy !== null} testid={props.testid} onClick={props.onClick} title={props.title}>
      {props.busy === props.label ? "Writing…" : props.label}
    </Button>
  );
}

/** Top of the Production tab: the idea, Claude's logline/outline, and story-wide actions. */
export function StoryCard({ p, production, writer }: { p: Production; production: ProductionStore; writer?: StudioWriter }) {
  const [open, setOpen] = useState(p.scenes.length === 0);
  const { busy, message, run } = useWriterAction(production, writer);
  const set = (patch: Partial<Production["story"]>) => production.update((cur) => updateStory(cur, patch));
  return (
    <div style={cardStyle} data-testid="story-card">
      <div style={rowStyle}>
        <IconButton frame="sm" title={open ? "Collapse" : "Expand"} onClick={() => setOpen(!open)} testid="story-toggle">
          <Icon name={open ? "chevron-down" : "chevron-right"} size={10} />
        </IconButton>
        <span style={{ flex: 1, fontSize: theme.fontSize.sm, fontWeight: theme.fontWeight.medium, color: theme.text.primary }}>Story</span>
        {p.story.logline && !open && (
          <span style={{ fontSize: theme.fontSize.xs, color: theme.text.tertiary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "60%" }}>
            {p.story.logline}
          </span>
        )}
      </div>
      {open && (
        <>
          <Field label="Idea">
            <TextArea value={p.story.idea} onChange={(idea) => set({ idea })} rows={2} placeholder="What's the video about? A premise, a mood, a fight you want to see…" testid="story-idea" />
          </Field>
          <Field label="Logline">
            <TextInput value={p.story.logline} onChange={(logline) => set({ logline, outlineState: "draft" })} testid="story-logline" />
          </Field>
          <div style={rowStyle}>
            <FieldLabel>Outline</FieldLabel>
            <div style={{ flex: 1 }} />
            <ApprovalToggle state={p.story.outlineState} onChange={(outlineState) => set({ outlineState })} testid="story-outline-approval" />
          </div>
          <TextArea value={p.story.outline} onChange={(outline) => set({ outline, outlineState: "draft" })} rows={4} testid="story-outline" />
          {writer ? (
            <div style={{ ...rowStyle, flexWrap: "wrap" }}>
              <WriteButton
                label="Write outline"
                busy={busy}
                testid="story-write-outline"
                title={p.scenes.length ? "Rewrites the logline and outline; existing scenes are kept" : "Writes the logline, outline and a first list of scenes"}
                onClick={() => void run("Write outline", (cur, model) => outlineTask(cur, model))}
              />
              <WriteButton
                label="Suggest characters"
                busy={busy}
                testid="story-write-characters"
                title="Adds characters from the story; details you already wrote are kept"
                onClick={() => void run("Suggest characters", (cur, model) => charactersTask(cur, model))}
              />
            </div>
          ) : (
            <div style={{ fontSize: theme.fontSize.xs, color: theme.text.tertiary }}>Add an Anthropic key in Settings → Agent to write with Claude.</div>
          )}
          <ActionNote message={message} testid="story-message" />
        </>
      )}
    </div>
  );
}

/** A scene's spoken lines: speaker, line and delivery, editable; Claude's lines arrive as a draft. */
export function DialogueEditor({ p, scene, production, tid }: { p: Production; scene: Scene; production: ProductionStore; tid: string }) {
  const setLines = (dialogue: DialogueLine[]) => production.update((cur) => updateScene(cur, scene.id, { dialogue, dialogueState: "draft" }));
  const speakers = [{ value: "narrator", label: "Narrator" }, ...p.characters.map((c) => ({ value: c.id, label: c.name }))];
  const edit = (i: number, patch: Partial<DialogueLine>) => setLines(scene.dialogue.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: theme.spacing.xs }} data-testid={`${tid}-dialogue`}>
      <div style={rowStyle}>
        <FieldLabel>Dialogue and voiceover ({scene.dialogue.length})</FieldLabel>
        <div style={{ flex: 1 }} />
        {scene.dialogue.length > 0 && (
          <ApprovalToggle
            state={scene.dialogueState}
            onChange={(dialogueState) => production.update((cur) => updateScene(cur, scene.id, { dialogueState }))}
            testid={`${tid}-dialogue-approval`}
          />
        )}
      </div>
      {scene.dialogue.map((line, i) => {
        const known = speakers.some((s) => s.value === line.speaker);
        return (
          <div key={line.id} style={{ display: "flex", flexDirection: "column", gap: theme.spacing.xxs }} data-testid={`${tid}-line-${i}`}>
            <div style={rowStyle}>
              <div style={{ flex: "0 0 40%", minWidth: 0 }}>
                <Select
                  value={known ? line.speaker : null}
                  placeholder={known ? "Speaker" : line.speaker}
                  options={speakers}
                  onChange={(speaker) => edit(i, { speaker })}
                  testid={`${tid}-line-${i}-speaker`}
                />
              </div>
              <TextInput value={line.direction} placeholder="delivery, e.g. cold, quiet" onChange={(direction) => edit(i, { direction })} style={{ flex: 1, minWidth: 0 }} testid={`${tid}-line-${i}-direction`} />
              <IconButton frame="xs" title="Remove line" onClick={() => setLines(scene.dialogue.filter((_, j) => j !== i))}>
                <Icon name="x" size={8} />
              </IconButton>
            </div>
            <TextArea value={line.text} onChange={(text) => edit(i, { text })} rows={2} testid={`${tid}-line-${i}-text`} />
          </div>
        );
      })}
      <div>
        <Button
          size="small"
          testid={`${tid}-add-line`}
          onClick={() => setLines([...scene.dialogue, DialogueLineSchema.parse({})])}
        >
          + Line
        </Button>
      </div>
    </div>
  );
}
