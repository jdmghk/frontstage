// ffmpeg argument sets for desktop export. No `electron` import (unit-tested).
// youtube: H.264 High, CRF 18 / preset slow (visually lossless at a sane size), yuv420p, AAC 48 kHz
// 320 kbps and +faststart (moov atom first) — in line with YouTube's recommended upload settings.

export const CODECS = {
  prores_ks: { ext: ".mov", vargs: ["-c:v", "prores_ks", "-profile:v", "3"], aargs: ["-c:a", "aac"], muxFlags: [] },
  libx264: { ext: ".mp4", vargs: ["-c:v", "libx264", "-pix_fmt", "yuv420p"], aargs: ["-c:a", "aac"], muxFlags: [] },
  libx264_youtube: {
    ext: ".mp4",
    vargs: ["-c:v", "libx264", "-preset", "slow", "-crf", "18", "-profile:v", "high", "-pix_fmt", "yuv420p", "-movflags", "+faststart"],
    aargs: ["-c:a", "aac", "-b:a", "320k", "-ar", "48000"],
    muxFlags: ["-movflags", "+faststart"],
  },
};

export function videoArgs(spec, { width, height, fps }, outPath) {
  return ["-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${width}x${height}`, "-r", String(fps), "-i", "pipe:0", ...spec.vargs, outPath];
}

export function muxArgs(spec, { sampleRate, channels }, videoPath, audioPath, outPath) {
  return [
    "-y",
    "-i", videoPath,
    "-f", "f32le", "-ar", String(sampleRate), "-ac", String(channels), "-i", audioPath,
    "-map", "0:v", "-map", "1:a",
    "-c:v", "copy",
    ...spec.aargs,
    ...spec.muxFlags,
    "-shortest",
    outPath,
  ];
}
