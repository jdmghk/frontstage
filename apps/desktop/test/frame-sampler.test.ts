import { describe, expect, test } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { frameArgs, sampleFrames, splitJpegs, validateRequest } from "../src/main/frame-sampler.mjs";

const jpeg = (n: number) => Buffer.from([0xff, 0xd8, n, n, 0xff, 0xd9]);

function fakeSpawn(stdout: Buffer, code = 0, stderr = "") {
  const seen: string[][] = [];
  const impl = (_bin: string, args: string[]) => {
    seen.push(args);
    const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    setTimeout(() => {
      proc.stdout.emit("data", stdout);
      if (stderr) proc.stderr.emit("data", Buffer.from(stderr));
      proc.emit("close", code);
    }, 0);
    return proc;
  };
  return { impl, seen };
}

const tmpVideo = () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "frames-")), "ref.mp4");
  fs.writeFileSync(f, "x");
  return f;
};

describe("frame sampler", () => {
  test("ffmpeg args sample at fps, scale, cap frames, pipe MJPEG", () => {
    expect(frameArgs("/v.mp4", 2, 768, 12)).toEqual([
      "-hide_banner", "-loglevel", "error", "-i", "/v.mp4", "-vf", "fps=2,scale=768:-2", "-frames:v", "12", "-f", "image2pipe", "-vcodec", "mjpeg", "-q:v", "4", "pipe:1",
    ]);
  });

  test("splits a concatenated JPEG stream", () => {
    expect(splitJpegs(Buffer.concat([jpeg(1), jpeg(2), jpeg(3)])).map((b: Buffer) => b[2])).toEqual([1, 2, 3]);
  });

  test("rejects non-video paths and out-of-range settings before running ffmpeg", () => {
    const f = tmpVideo();
    expect(() => validateRequest({ path: "/etc/passwd", fps: 1, width: 768, maxFrames: 5 })).toThrow("not a video");
    expect(() => validateRequest({ path: f, fps: 50, width: 768, maxFrames: 5 })).toThrow("fps");
    expect(() => validateRequest({ path: f, fps: 1, width: 768, maxFrames: 99 })).toThrow("maxFrames");
  });

  test("returns base64 frames with their times", async () => {
    const { impl } = fakeSpawn(Buffer.concat([jpeg(1), jpeg(2)]));
    const frames = await sampleFrames("ffmpeg", { path: tmpVideo(), fps: 2, width: 768, maxFrames: 5 }, impl);
    expect(frames.map((f: { timeSec: number }) => f.timeSec)).toEqual([0, 0.5]);
    expect(Buffer.from(frames[0].base64, "base64")[2]).toBe(1);
  });

  test("an ffmpeg failure surfaces its last error line", async () => {
    const { impl } = fakeSpawn(Buffer.alloc(0), 1, "first\nInvalid data found when processing input\n");
    await expect(sampleFrames("ffmpeg", { path: tmpVideo(), fps: 1, width: 768, maxFrames: 5 }, impl)).rejects.toThrow("Invalid data found");
  });
});
