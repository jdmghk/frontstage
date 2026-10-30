import { describe, expect, test } from "vitest";
import { youtubeVideoPlan } from "../src/export/webcodecs-sink.js";

describe("youtubeVideoPlan", () => {
  test("1080p30 → High 4.0 first, 12 Mbps; 1080p60 → High 4.2, 15 Mbps", () => {
    expect(youtubeVideoPlan(1920, 1080, 30)).toEqual({ codecs: ["avc1.640028", "avc1.64002a", "avc1.4d0028"], bitrate: 12_000_000 });
    expect(youtubeVideoPlan(1920, 1080, 60).codecs[0]).toBe("avc1.64002a");
  });
  test("4K → High 5.1/5.2, 45 Mbps at 30 fps, 68 at 60", () => {
    expect(youtubeVideoPlan(3840, 2160, 30)).toEqual({ codecs: ["avc1.640033", "avc1.640034", "avc1.4d0033"], bitrate: 45_000_000 });
    expect(youtubeVideoPlan(3840, 2160, 60).bitrate).toBe(68_000_000);
  });
});
