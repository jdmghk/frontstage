// Every preload method has a counterpart on the Tauri bridge, and every command the bridge invokes
// is registered in Rust and isn't a typo. Keeps the bridge from silently drifting from the preload.
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(__dirname, "../../..");
const preload = readFileSync(path.join(root, "apps/desktop/src/preload/index.cjs"), "utf8");
const bridge = readFileSync(path.join(root, "apps/studio-tauri/src/tauri-bridge.ts"), "utf8");
const main = readFileSync(path.join(root, "apps/studio-tauri/src-tauri/src/main.rs"), "utf8");
const proxy = readFileSync(path.join(root, "apps/studio-tauri/src/video-proxy.ts"), "utf8");

function preloadShape(e2e: boolean): Record<string, string[]> {
  const shape: Record<string, string[]> = {};
  const electron = {
    contextBridge: { exposeInMainWorld: (name: string, api: object) => void (shape[name] = Object.keys(api)) },
    ipcRenderer: {},
  };
  vm.runInNewContext(preload, { require: () => electron, process: { env: e2e ? { FRONTSTAGE_E2E: "1" } : {}, platform: "darwin" } });
  return shape;
}

// Keys of each `const desktopX = { ... };` in the bridge source: the object's top-level properties.
function bridgeShape(): Record<string, string[]> {
  const shape: Record<string, string[]> = {};
  const re = /^const (desktop\w+) = \{$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bridge))) {
    const body = bridge.slice(m.index + m[0].length, bridge.indexOf("\n};", m.index));
    const keys: string[] = [];
    for (const line of body.split("\n")) {
      const k = /^ {2}(?:\.\.\.\(testBuild \? \{ )?(\w+)\b[:(]/.exec(line);
      if (k) keys.push(k[1]!);
    }
    shape[m[1]!] = keys;
  }
  return shape;
}

describe("bridge against preload", () => {
  const want = preloadShape(true);
  const got = bridgeShape();

  test("every window object exists, apart from the E2E-only menu hook", () => {
    const names = Object.keys(want).filter((n) => n !== "__e2eMenuTrigger");
    for (const n of names) expect(got[n], n).toBeDefined();
    expect(bridge).toContain("__e2eMenuTrigger");
  });

  for (const [name, methods] of Object.entries(preloadShape(true))) {
    if (name === "__e2eMenuTrigger") continue;
    test(`${name} has every preload method`, () => {
      // Export abort has no Electron channel; a failed export there keeps its existing behaviour.
      const tauriOnly = new Set(["abort"]);
      expect(new Set((got[name] ?? []).filter((m: string) => !tauriOnly.has(m)))).toEqual(new Set(methods));
    });
  }

  test("all the objects are assigned to window", () => {
    const assigned = bridge.slice(bridge.indexOf("Object.assign(window"));
    for (const n of Object.keys(want).filter((x) => x !== "__e2eMenuTrigger")) expect(assigned).toContain(n);
  });
});

describe("bridge against Rust", () => {
  const registered = new Set([...main.matchAll(/\b(\w+)::(\w+)\s*[,\n]/g)].map((m) => m[2]!).concat([...main.matchAll(/^\s+(app_tools_status|secrets_legacy_notice|secrets_dismiss_legacy_notice),/gm)].map((m) => m[1]!)));
  const invoked = [...`${bridge}\n${proxy}`.matchAll(/invoke(?:<[^>]*(?:<[^>]*>)?[^>]*>)?\(\s*"(\w+)"/g)].map((m) => m[1]!);

  test("the regex found the commands", () => expect(invoked.length).toBeGreaterThan(60));

  test("every invoked command is registered", () => {
    const missing = [...new Set(invoked)].filter((c) => !registered.has(c));
    expect(missing).toEqual([]);
  });
});

describe("what can't ship", () => {
  test("spike_file and the test commands sit behind the cargo feature", () => {
    const shipped = main.slice(main.indexOf("macro_rules! handlers_with"), main.indexOf('#[cfg(feature = "webkit-tests")]\nfn handlers'));
    for (const c of ["spike_file", "clip_bytes", "decode_pcm", "sink_frame", "smoke_"]) expect(shipped).not.toContain(c);
    const spike = readFileSync(path.join(root, "apps/studio-tauri/src-tauri/src/spike.rs"), "utf8");
    expect(spike).toContain('#![cfg(feature = "webkit-tests")]');
  });

  test("the release capability has no remote URLs", () => {
    const cap = JSON.parse(readFileSync(path.join(root, "apps/studio-tauri/src-tauri/capabilities/default.json"), "utf8"));
    expect(cap.remote).toBeUndefined();
  });
});
