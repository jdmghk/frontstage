import { describe, expect, test } from "vitest";
import { CODECS, muxArgs, videoArgs } from "../src/main/export-codecs.mjs";

describe("export codecs", () => {
  test("youtube: H.264 High CRF 18 slow, yuv420p, faststart; AAC 320k 48 kHz on mux", () => {
    const v = videoArgs(CODECS.libx264_youtube, { width: 3840, height: 2160, fps: 30 }, "/o.mp4");
    expect(v).toEqual(expect.arrayContaining(["-s", "3840x2160", "-r", "30", "-profile:v", "high", "-crf", "18", "-preset", "slow", "+faststart"]));
    expect(v.at(-1)).toBe("/o.mp4");
    const m = muxArgs(CODECS.libx264_youtube, { sampleRate: 44100, channels: 2 }, "/v.mp4", "/a.f32le", "/o.mp4");
    expect(m.join(" ")).toContain("-c:v copy -c:a aac -b:a 320k -ar 48000 -movflags +faststart -shortest /o.mp4");
  });

  test("the default codecs keep their previous behaviour", () => {
    expect(videoArgs(CODECS.libx264, { width: 1280, height: 720, fps: 24 }, "/o.mp4")).toEqual([
      "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", "1280x720", "-r", "24", "-i", "pipe:0", "-c:v", "libx264", "-pix_fmt", "yuv420p", "/o.mp4",
    ]);
    expect(muxArgs(CODECS.libx264, { sampleRate: 48000, channels: 2 }, "/v", "/a", "/o").join(" ")).toBe(
      "-y -i /v -f f32le -ar 48000 -ac 2 -i /a -map 0:v -map 1:a -c:v copy -c:a aac -shortest /o",
    );
  });
});
