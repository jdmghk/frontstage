// Samples still frames from a local video with the bundled ffmpeg, for choreography analysis.
// Frames come back as JPEG bytes over a pipe (nothing is written to disk). No `electron` import.

import fs from "node:fs";
import { spawn } from "node:child_process";

const VIDEO_EXT = /\.(mp4|mov|m4v|mkv|webm|avi|mpg|mpeg)$/i;
export const MAX_FRAMES = 20;

export function frameArgs(input, fps, width, maxFrames) {
  return [
    "-hide_banner", "-loglevel", "error",
    "-i", input,
    "-vf", `fps=${fps},scale=${width}:-2`,
    "-frames:v", String(maxFrames),
    "-f", "image2pipe", "-vcodec", "mjpeg", "-q:v", "4",
    "pipe:1",
  ];
}

/** Splits a concatenated MJPEG stream into individual JPEGs (SOI ff d8 … EOI ff d9). */
export function splitJpegs(buf) {
  const out = [];
  let start = -1;
  for (let i = 0; i + 1 < buf.length; i++) {
    if (buf[i] !== 0xff) continue;
    if (buf[i + 1] === 0xd8 && start === -1) start = i;
    else if (buf[i + 1] === 0xd9 && start !== -1) {
      out.push(buf.subarray(start, i + 2));
      start = -1;
      i++;
    }
  }
  return out;
}

export function validateRequest({ path: p, fps, width, maxFrames }) {
  if (typeof p !== "string" || !VIDEO_EXT.test(p)) throw new Error("not a video file");
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw new Error("video file not found");
  if (!(fps > 0 && fps <= 8)) throw new Error("fps out of range");
  if (!Number.isInteger(width) || width < 160 || width > 1280) throw new Error("width out of range");
  if (!Number.isInteger(maxFrames) || maxFrames < 1 || maxFrames > MAX_FRAMES) throw new Error("maxFrames out of range");
}

/** Returns [{ timeSec, base64 }] (JPEG), frame i at i / fps seconds. */
export function sampleFrames(ffmpegPath, req, spawnImpl = spawn) {
  validateRequest(req);
  return new Promise((resolve, reject) => {
    const proc = spawnImpl(ffmpegPath, frameArgs(req.path, req.fps, req.width, req.maxFrames), { stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    let stderr = "";
    proc.stdout.on("data", (c) => chunks.push(c));
    proc.stderr.on("data", (c) => (stderr += c.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg failed: ${stderr.trim().split("\n").pop() || `exit ${code}`}`));
      const frames = splitJpegs(Buffer.concat(chunks)).slice(0, req.maxFrames);
      if (frames.length === 0) return reject(new Error("no frames could be read from this video"));
      resolve(frames.map((f, i) => ({ timeSec: i / req.fps, base64: Buffer.from(f).toString("base64") })));
    });
  });
}
