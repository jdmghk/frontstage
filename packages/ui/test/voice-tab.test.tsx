import { describe, expect, test } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { addScene, updateScene, upsertCharacter, DialogueLineSchema } from "@frontstage/core";
import { VoiceTab, type StudioVoice } from "../src/production/VoiceTab.js";
import { ProductionStore } from "../src/production/production-store.js";
import { fakeProductionLibrary } from "./production-fakes.js";

function setup(voice?: StudioVoice) {
  const production = new ProductionStore();
  const library = fakeProductionLibrary();
  production.attachLibrary(library);
  production.update((p) => {
    const kai = upsertCharacter(p, { name: "Kai" });
    const s = addScene(kai.production, { title: "Duel" });
    return updateScene(s.production, s.sceneId, { dialogue: [DialogueLineSchema.parse({ speaker: kai.characterId, text: "You owe me." })] });
  });
  render(<VoiceTab production={production} library={library} voice={voice} />);
  return { production, library };
}

async function createVoice(consent: boolean) {
  fireEvent.click(screen.getByTestId("voice-add"));
  fireEvent.change(screen.getByTestId("voice-new-name"), { target: { value: "Kai (me)" } });
  await act(async () => {
    fireEvent.change(screen.getByTestId("voice-new-file"), { target: { files: [new File(["x"], "me.wav", { type: "audio/wav" })] } });
  });
  if (consent) fireEvent.click(screen.getByTestId("voice-new-consent"));
}

describe("VoiceTab", () => {
  test("Create voice stays disabled until consent is confirmed", async () => {
    const { production } = setup();
    await createVoice(false);
    expect((screen.getByTestId("voice-new-create") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("voice-new-consent"));
    await act(async () => fireEvent.click(screen.getByTestId("voice-new-create")));
    expect(production.getSnapshot().voices[0]).toMatchObject({ name: "Kai (me)", consent: { attested: true } });
  });

  test("generate one line: the take is attached, the line reads generating, then generated", async () => {
    const calls: string[] = [];
    let lib!: ReturnType<typeof fakeProductionLibrary>;
    const voice: StudioVoice = {
      generateLine: async (_p, lineId, opts) => (calls.push(`${lineId}:${opts.name}`), { placeholderId: lib.addPlaceholder("take", "audio").id }),
    };
    const { production, library } = setup(voice);
    lib = library;
    await createVoice(true);
    await act(async () => fireEvent.click(screen.getByTestId("voice-new-create")));
    const voiceId = production.getSnapshot().voices[0]!.id;
    fireEvent.change(screen.getByTestId("voice-cast-0"), { target: { value: voiceId } });
    await act(async () => fireEvent.click(screen.getByTestId("voice-line-0-0-generate")));
    const line = () => production.getSnapshot().scenes[0]!.dialogue[0]!;
    expect(calls[0]).toMatch(/:S01 L01 Kai$/);
    expect(line()).toMatchObject({ status: "generating" });
    act(() => library.finishImports());
    expect(line().status).toBe("generated");
    fireEvent.click(screen.getByTestId("voice-line-0-0-take-0-approve"));
    expect(line().status).toBe("approved");
  });

  test("a refused generation shows the reason and changes nothing", async () => {
    const { production } = setup({ generateLine: async () => ({ error: "Kai has no voice yet. Assign one in the Voice tab." }) });
    const before = production.getSnapshot();
    await act(async () => fireEvent.click(screen.getByTestId("voice-line-0-0-generate")));
    expect(production.getSnapshot()).toBe(before);
    expect(screen.getByTestId("voice-line-0-0-message").textContent).toContain("no voice yet");
  });
});
