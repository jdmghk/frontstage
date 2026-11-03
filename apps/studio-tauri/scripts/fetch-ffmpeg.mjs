// Fetches a stock ffmpeg for a target that has no trimmed build, from the same releases the
// ffmpeg-static npm package installs, and checks it against a pinned SHA-256.
// Usage: node scripts/fetch-ffmpeg.mjs <target-triple>
// Output: src-tauri/binaries/ffmpeg-<triple>[.exe], which Tauri bundles through externalBin.
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const RELEASE = "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1";
const PINS = {
  "x86_64-apple-darwin": ["ffmpeg-darwin-x64.gz", "929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106"],
  "aarch64-apple-darwin": ["ffmpeg-darwin-arm64.gz", "8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa"],
  "x86_64-pc-windows-msvc": ["ffmpeg-win32-x64.gz", "8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77"],
};

const triple = process.argv[2];
const pin = PINS[triple];
if (!pin) {
  console.error(`usage: fetch-ffmpeg.mjs <${Object.keys(PINS).join("|")}>`);
  process.exit(2);
}
const [asset, sha256] = pin;
const res = await fetch(`${RELEASE}/${asset}`);
if (!res.ok) throw new Error(`${asset}: HTTP ${res.status}`);
const gz = Buffer.from(await res.arrayBuffer());
const actual = createHash("sha256").update(gz).digest("hex");
if (actual !== sha256) throw new Error(`${asset}: checksum mismatch, got ${actual}`);

const dir = join(dirname(fileURLToPath(import.meta.url)), "../src-tauri/binaries");
const out = join(dir, `ffmpeg-${triple}${triple.includes("windows") ? ".exe" : ""}`);
mkdirSync(dir, { recursive: true });
writeFileSync(out, gunzipSync(gz));
chmodSync(out, 0o755);
console.log(out);
