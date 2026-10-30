import { describe, expect, test, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  charactersRootPath,
  isValidCharacterId,
  isValidCharacterFile,
  listCharacterIds,
  readCharacterFile,
  writeCharacterFile,
  removeCharacter,
} from "../src/main/characters-fs.mjs";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "frontstage-characters-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("characters-fs", () => {
  test("root lives under ~/.frontstage/characters", () => {
    expect(charactersRootPath("/home/u")).toBe(path.join("/home/u", ".frontstage", "characters"));
  });

  test("rejects traversal in ids and file names", () => {
    for (const bad of ["", ".", "..", "a/b", "a\\b", "../x"]) expect(isValidCharacterId(bad)).toBe(false);
    expect(isValidCharacterFile("..")).toBe(false);
    expect(isValidCharacterFile("../character.json")).toBe(false);
    expect(() => writeCharacterFile(root, "../escape", "x.png", new Uint8Array([1]))).toThrow(/invalid character id/);
    expect(() => readCharacterFile(root, "kai", "../../etc")).toThrow(/invalid file name/);
  });

  test("write, list, read, remove round-trip", () => {
    writeCharacterFile(root, "kai", "character.json", new TextEncoder().encode("{}"));
    writeCharacterFile(root, "kai", "ref-1.png", new Uint8Array([137, 80]));
    fs.mkdirSync(path.join(root, "not valid!"));
    expect(listCharacterIds(root)).toEqual(["kai"]);
    expect([...readCharacterFile(root, "kai", "ref-1.png")!]).toEqual([137, 80]);
    expect(readCharacterFile(root, "kai", "missing.png")).toBeNull();
    removeCharacter(root, "kai");
    expect(listCharacterIds(root)).toEqual([]);
  });

  test("a missing root lists nothing", () => {
    expect(listCharacterIds(path.join(root, "nope"))).toEqual([]);
  });
});
