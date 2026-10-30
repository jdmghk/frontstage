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

/**
 * Combines the encoded video with the raw audio (optional) and an SRT file (optional) as a soft
 * subtitle track (mov_text: the MP4/MOV text format players and YouTube read).
 */
export function muxArgs(spec, audio, videoPath, audioPath, outPath, srtPath = null) {
  const args = ["-y", "-i", videoPath];
  if (audioPath) args.push("-f", "f32le", "-ar", String(audio.sampleRate), "-ac", String(audio.channels), "-i", audioPath);
  if (srtPath) args.push("-f", "srt", "-i", srtPath);
  args.push("-map", "0:v");
  if (audioPath) args.push("-map", "1:a");
  if (srtPath) args.push("-map", `${audioPath ? 2 : 1}:s`);
  args.push("-c:v", "copy");
  if (audioPath) args.push(...spec.aargs);
  if (srtPath) args.push("-c:s", "mov_text", "-metadata:s:s:0", "language=eng");
  args.push(...spec.muxFlags);
  if (audioPath) args.push("-shortest");
  args.push(outPath);
  return args;
}
