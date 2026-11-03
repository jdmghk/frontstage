import { demuxMp4, buildAudioChunks, AudioDecodeManager, AudioGraph } from "@frontstage/engine";

interface AudioGraphRunResult {
  isolated: boolean;
  t0: number;
  t1: number;
  ringDrained: boolean;
  initialAvail: number;
}

declare global {
  interface Window {
    __audioGraphReady: boolean;
    __audioGraphRun: () => Promise<AudioGraphRunResult>;
    __ringDrained: boolean;
  }
}

async function main(): Promise<void> {
  const status = document.getElementById("status")!;
  try {
    status.textContent = "fetch";
    const resp = await fetch("/test/fixtures/clip.mp4");
    const fileBytes = await resp.arrayBuffer();
    const blob = new Blob([fileBytes], { type: "video/mp4" });
    const result = await demuxMp4(blob);
    if (!result.audio) throw new Error("no audio track");

    status.textContent = "decoder";
    const chunks = buildAudioChunks(result.audio, fileBytes);
    const mgr = await AudioDecodeManager.create(result.audio, chunks);

    status.textContent = "graph";
    const transport = new URLSearchParams(location.search).get("transport") === "port" ? "port" : undefined;
    const graph = await AudioGraph.create(result.audio.channels, result.audio.sampleRate, transport);

    // Push ~0.5s of PCM into the ring before starting
    status.textContent = "decode";
    const halfSecFrames = Math.ceil(result.audio.sampleRate * 0.5);
    let framesBuffered = 0;
    await mgr.decodeAll((pcm) => {
      if (framesBuffered < halfSecFrames) {
        graph.pushPcm(pcm);
        framesBuffered += pcm.data.length / pcm.channels;
      }
    });

    status.textContent = "start";
    const initialAvail = graph.availableRead;
    await graph.start();

    window.__audioGraphRun = async (): Promise<AudioGraphRunResult> => {
      const isolated = self.crossOriginIsolated;
      const t0 = graph.currentTime;
      // Output devices can take seconds to start on a busy machine, so wait for the clock, not a fixed time.
      const deadline = performance.now() + 15_000;
      while (graph.currentTime - t0 <= 0.25 && performance.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
      const t1 = graph.currentTime;
      const ringDrained = graph.availableRead < initialAvail;
      window.__ringDrained = ringDrained;
      return { isolated, t0, t1, ringDrained, initialAvail };
    };

    status.textContent = "ok";
    window.__audioGraphReady = true;
  } catch (e) {
    const msg = "error: " + (e as Error).message;
    status.textContent = msg;
    console.error(e);
  }
}

void main();
