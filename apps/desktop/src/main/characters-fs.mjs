// fs helpers backing the characters:* IPC — the desktop half of CharacterLibraryStorage, over
// ~/.frontstage/characters/<id>/<file>. No `electron` import, same convention as skills-fs.mjs.

import fs from "node:fs";
import path from "node:path";

// Mirrors isValidCharacterId / file-name rules in @frontstage/ui's character-library.ts.
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const FILE_RE = /^[A-Za-z0-9_.-]{1,128}$/;
const MAX_FILE_BYTES = 50 * 1024 * 1024;

export function charactersRootPath(homeDir) {
  return path.join(homeDir, ".frontstage", "characters");
}

export function isValidCharacterId(id) {
  return typeof id === "string" && ID_RE.test(id);
}

export function isValidCharacterFile(name) {
  return typeof name === "string" && FILE_RE.test(name) && name !== "." && name !== "..";
}

function filePath(root, id, name) {
  if (!isValidCharacterId(id)) throw new Error(`invalid character id: ${id}`);
  if (name !== undefined && !isValidCharacterFile(name)) throw new Error(`invalid file name: ${name}`);
  return name === undefined ? path.join(root, id) : path.join(root, id, name);
}

export function listCharacterIds(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && isValidCharacterId(d.name)).map((d) => d.name);
  } catch {
    return [];
  }
}

export function readCharacterFile(root, id, name) {
  try {
    return new Uint8Array(fs.readFileSync(filePath(root, id, name)));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

export function writeCharacterFile(root, id, name, bytes) {
  const f = filePath(root, id, name);
  const buf = Buffer.from(bytes);
  if (buf.byteLength > MAX_FILE_BYTES) throw new Error(`file too large: ${name}`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, buf);
}

export function removeCharacter(root, id) {
  fs.rmSync(filePath(root, id), { recursive: true, force: true });
}
