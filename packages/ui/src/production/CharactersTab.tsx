import { useRef, useState, useSyncExternalStore } from "react";
import type { Character, CharacterAppearance, LibraryCharacter, Production } from "@frontstage/core";
import { parseGenerationStatus, removeCharacter, upsertCharacter } from "@frontstage/core";
import { generatingLabel } from "../media/GeneratingOverlay.js";
import type { StudioMorphic } from "./morphic.js";
import { theme } from "../theme/theme.js";
import { Button, Icon, IconButton, TextInput } from "../primitives/index.js";
import { ensureFolderPath, type ProductionStore } from "./production-store.js";
import type { CharacterLibrary, ProjectMediaAccess } from "./character-library.js";
import type { ProductionLibrary } from "./ProductionTab.js";
import { Field, FieldLabel, TextArea, Thumb, cardStyle, rowStyle, scrollColumnStyle } from "./fields.js";

export type CharactersLibrary = ProductionLibrary & ProjectMediaAccess;

export interface CharactersTabProps {
  production: ProductionStore;
  library: CharactersLibrary;
  /** Cross-project library; omitted -> the save/add-from-library actions are hidden. */
  characterLibrary?: CharacterLibrary;
  /** Morphic design generation; omitted -> the action is hidden. */
  morphic?: StudioMorphic;
}

const APPEARANCE_FIELDS: { key: keyof CharacterAppearance; label: string; placeholder: string }[] = [
  { key: "ageRange", label: "Age range", placeholder: "e.g. late 20s" },
  { key: "hair", label: "Hair", placeholder: "e.g. black topknot" },
  { key: "clothing", label: "Clothing", placeholder: "e.g. worn indigo gi, red sash" },
  { key: "build", label: "Build", placeholder: "e.g. lean, athletic" },
  { key: "other", label: "Other", placeholder: "scars, tattoos, props…" },
];

function shotCount(p: Production, id: string): number {
  return p.scenes.reduce((n, s) => n + s.shots.filter((sh) => sh.characterIds.includes(id)).length, 0);
}

export function CharactersTab({ production, library, characterLibrary, morphic }: CharactersTabProps) {
  const p = useSyncExternalStore(production.subscribe.bind(production), () => production.getSnapshot());
  useSyncExternalStore(library.subscribe.bind(library), () => library.getSnapshot().entries);
  const [libraryItems, setLibraryItems] = useState<LibraryCharacter[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const openLibrary = async () => {
    if (!characterLibrary) return;
    try {
      setLibraryItems(await characterLibrary.list());
    } catch (e) {
      setMessage(`Could not read the character library: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const addFromLibrary = async (record: LibraryCharacter) => {
    if (!characterLibrary) return;
    if (p.characters.some((c) => c.libraryId === record.id)) {
      setMessage(`${record.name} is already in this project.`);
      return;
    }
    try {
      const folderId = ensureFolderPath(library, ["Characters", record.name]);
      const init = await characterLibrary.importIntoProject(record, library, folderId);
      production.update((cur) => upsertCharacter(cur, init).production);
      setLibraryItems(null);
      setMessage(null);
    } catch (e) {
      setMessage(`Could not add ${record.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }} data-testid="characters-tab">
      <div style={{ ...rowStyle, height: theme.size.panelHeader, padding: `0 ${theme.spacing.sm}`, flexShrink: 0 }}>
        <Button
          testid="characters-add"
          onClick={() => production.update((cur) => upsertCharacter(cur, { name: `Character ${cur.characters.length + 1}` }).production)}
        >
          <span style={rowStyle}>
            <Icon name="plus" size={10} />
            Character
          </span>
        </Button>
        {characterLibrary && (
          <Button testid="characters-open-library" onClick={() => void openLibrary()}>
            From library…
          </Button>
        )}
      </div>
      <div style={scrollColumnStyle}>
        {message && (
          <div style={{ fontSize: theme.fontSize.xs, color: theme.status.error }} data-testid="characters-message">
            {message}
          </div>
        )}
        {libraryItems && (
          <div style={cardStyle} data-testid="characters-library-list">
            <div style={rowStyle}>
              <FieldLabel>Character library</FieldLabel>
              <div style={{ flex: 1 }} />
              <IconButton frame="sm" title="Close" onClick={() => setLibraryItems(null)}>
                <Icon name="x" size={10} />
              </IconButton>
            </div>
            {libraryItems.length === 0 && (
              <div style={{ fontSize: theme.fontSize.xs, color: theme.text.tertiary }}>
                No saved characters yet. Use "Save to library" on a character to reuse it in other projects.
              </div>
            )}
            {libraryItems.map((rec) => (
              <div key={rec.id} style={rowStyle}>
                <span style={{ flex: 1, fontSize: theme.fontSize.sm, color: theme.text.primary }}>{rec.name}</span>
                <span style={{ fontSize: theme.fontSize.xs, color: theme.text.tertiary }}>{rec.images.length} images</span>
                <Button size="small" testid={`characters-library-add-${rec.id}`} onClick={() => void addFromLibrary(rec)}>
                  Add
                </Button>
              </div>
            ))}
          </div>
        )}
        {p.characters.length === 0 && !libraryItems && (
          <div style={{ fontSize: theme.fontSize.sm, color: theme.text.tertiary }}>
            Characters keep their reference images, approved designs and continuity notes together, and every shot
            they appear in carries those references into generation. References improve consistency but don't guarantee
            an identical look in every generated clip.
          </div>
        )}
        {p.characters.map((c, i) => (
          <CharacterCard
            key={c.id}
            p={p}
            character={c}
            index={i}
            production={production}
            library={library}
            characterLibrary={characterLibrary}
            morphic={morphic}
          />
        ))}
      </div>
    </div>
  );
}

interface CharacterCardProps {
  p: Production;
  character: Character;
  index: number;
  production: ProductionStore;
  library: CharactersLibrary;
  characterLibrary?: CharacterLibrary;
  morphic?: StudioMorphic;
}

function CharacterCard({ p, character: c, index, production, library, characterLibrary, morphic }: CharacterCardProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const tid = `character-${index}`;
  const set = (patch: Partial<Character>) => production.update((cur) => upsertCharacter(cur, { ...c, ...patch }).production);

  const handleAddRefs = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    try {
      const folderId = ensureFolderPath(library, ["Characters", c.name]);
      const entries = await library.importFiles(files, folderId);
      const ids = entries.filter((e) => e.type === "image").map((e) => e.id);
      if (ids.length < entries.length) setMessage("Only images are kept as character references.");
      set({ referenceMediaIds: [...c.referenceMediaIds, ...ids] });
    } catch (e) {
      setMessage(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const handleSave = async () => {
    if (!characterLibrary) return;
    setBusy(true);
    try {
      const rec = await characterLibrary.saveFromProject(c, library);
      set({ libraryId: rec.id });
      setMessage(`Saved to library with ${rec.images.length} images.`);
    } catch (e) {
      setMessage(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  // The new design lands as a reference; the user marks it "Design" once they like it.
  const handleMorphicDesign = async () => {
    if (!morphic) return;
    setBusy(true);
    setMessage(null);
    try {
      const r = await morphic.generateCharacterDesign(c, {
        name: `${c.name} design ${c.referenceMediaIds.length + 1}`,
        folderId: ensureFolderPath(library, ["Characters", c.name]),
      });
      if ("error" in r) {
        setMessage(r.error);
        return;
      }
      production.update((cur) => {
        const latest = cur.characters.find((x) => x.id === c.id) ?? c;
        return upsertCharacter(cur, { ...latest, referenceMediaIds: [...latest.referenceMediaIds, r.placeholderId] }).production;
      });
      setMessage(`Generating in Morphic${r.projectName ? ` (project "${r.projectName}")` : ""}. Click "Design" on it once you like it.`);
    } finally {
      setBusy(false);
    }
  };

  const toggleDesign = (id: string) =>
    set({
      approvedDesignIds: c.approvedDesignIds.includes(id) ? c.approvedDesignIds.filter((x) => x !== id) : [...c.approvedDesignIds, id],
    });

  const removeRef = (id: string) =>
    set({
      referenceMediaIds: c.referenceMediaIds.filter((x) => x !== id),
      approvedDesignIds: c.approvedDesignIds.filter((x) => x !== id),
    });

  return (
    <div style={cardStyle} data-testid={tid}>
      <div style={rowStyle}>
        <TextInput value={c.name} onChange={(name) => name.trim() && set({ name })} testid={`${tid}-name`} style={{ flex: 1, minWidth: 0 }} />
        <span style={{ fontSize: theme.fontSize.xs, color: theme.text.tertiary }}>{shotCount(p, c.id)} shots</span>
        <IconButton frame="sm" title="Remove from project" testid={`${tid}-delete`} onClick={() => production.update((cur) => removeCharacter(cur, c.id))}>
          <Icon name="trash" size={10} />
        </IconButton>
      </div>
      <Field label="Description">
        <TextArea value={c.description} onChange={(description) => set({ description })} rows={2} testid={`${tid}-description`} />
      </Field>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: theme.spacing.xs }}>
        {APPEARANCE_FIELDS.map((f) => (
          <Field key={f.key} label={f.label}>
            <TextInput
              value={c.appearance[f.key]}
              placeholder={f.placeholder}
              onChange={(v) => set({ appearance: { ...c.appearance, [f.key]: v } })}
              testid={`${tid}-${f.key}`}
            />
          </Field>
        ))}
      </div>
      <Field label="Continuity notes">
        <TextArea value={c.continuityNotes} onChange={(continuityNotes) => set({ continuityNotes })} rows={2} />
      </Field>
      <FieldLabel>References — click "Design" to mark approved designs (used first in generation)</FieldLabel>
      <div style={{ ...rowStyle, flexWrap: "wrap" }} data-testid={`${tid}-refs`}>
        {c.referenceMediaIds.map((id, ri) => {
          const approved = c.approvedDesignIds.includes(id);
          return (
            <div key={id} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: theme.spacing.xxs }}>
              <Thumb src={library.thumbnail(id)} label={library.entry(id)?.name ?? "missing"} selected={approved} testid={`${tid}-ref-${ri}`} />
              {library.entry(id)?.generationStatus && (
                <span style={{ fontSize: theme.fontSize.xxs, color: theme.text.tertiary }} data-testid={`${tid}-ref-${ri}-pending`}>
                  {generatingLabel(parseGenerationStatus(library.entry(id)!.generationStatus))}
                </span>
              )}
              <div style={rowStyle}>
                <Button size="small" variant={approved ? "accent" : "default"} testid={`${tid}-ref-${ri}-design`} onClick={() => toggleDesign(id)}>
                  Design
                </Button>
                <IconButton frame="xs" title="Remove reference" onClick={() => removeRef(id)}>
                  <Icon name="x" size={8} />
                </IconButton>
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ ...rowStyle, flexWrap: "wrap" }}>
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          multiple
          style={{ display: "none" }}
          data-testid={`${tid}-refs-input`}
          onChange={(e) => void handleAddRefs(e.target.files)}
        />
        <Button size="small" disabled={busy} testid={`${tid}-add-refs`} onClick={() => fileInput.current?.click()}>
          Add reference images…
        </Button>
        {morphic && (
          <Button
            size="small"
            disabled={busy}
            testid={`${tid}-morphic`}
            onClick={() => void handleMorphicDesign()}
            title="Generate a new design image in Morphic from this character's description, using its current designs and references"
          >
            Generate design in Morphic
          </Button>
        )}
        {characterLibrary && (
          <Button size="small" disabled={busy} testid={`${tid}-save-library`} onClick={() => void handleSave()}>
            {c.libraryId ? "Update library copy" : "Save to library"}
          </Button>
        )}
      </div>
      {message && (
        <div style={{ fontSize: theme.fontSize.xs, color: theme.text.secondary }} data-testid={`${tid}-message`}>
          {message}
        </div>
      )}
    </div>
  );
}
