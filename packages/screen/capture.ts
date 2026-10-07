import { execFile, spawn } from "node:child_process";
import { createSocket } from "node:dgram";
import { once } from "node:events";
import { promisify } from "node:util";
import type { MediaStreamTrack } from "werift";
import { z } from "zod";
import { Dimensions, ScreenError } from "./protocol";

const execute = promisify(execFile);
export async function inspectDisplay(display: string): Promise<Dimensions> {
  z.string()
    .regex(/^:\d+(?:\.\d+)?$/)
    .parse(display);
  const { stdout } = await execute("xdpyinfo", ["-display", display], {
    timeout: 5000,
    maxBuffer: 1048576,
  });
  const match = /dimensions:\s+(\d+)x(\d+)\s+pixels/.exec(stdout);
  if (!match) throw new ScreenError("display_dimensions_unavailable");
  return Dimensions.parse({ width: Number(match[1]), height: Number(match[2]) });
}
export type CaptureSource = { readonly display: string; readonly dimensions: Dimensions };
export async function captureScreen(
  track: MediaStreamTrack,
  source: CaptureSource,
  onFailure: () => void,
): Promise<() => Promise<void>> {
  const udp = createSocket("udp4");
  udp.bind(0, "127.0.0.1");
  await once(udp, "listening");
  const port = udp.address().port;
  udp.on("message", (packet) => {
    if (packet.length >= 12 && packet[0] !== undefined && packet[0] >> 6 === 2)
      track.writeRtp(packet);
  });
  const { width, height } = source.dimensions;
  const process = spawn(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-f",
      "x11grab",
      "-video_size",
      `${width}x${height}`,
      "-framerate",
      "15",
      "-i",
      source.display,
      "-an",
      "-c:v",
      "libvpx",
      "-deadline",
      "realtime",
      "-cpu-used",
      "8",
      "-b:v",
      "1500k",
      "-g",
      "15",
      "-pix_fmt",
      "yuv420p",
      "-f",
      "rtp",
      "-payload_type",
      "96",
      `rtp://127.0.0.1:${port}?pkt_size=1200`,
    ],
    { stdio: "ignore" },
  );
  let stopped = false;
  process.once("error", () => {
    if (!stopped) onFailure();
  });
  process.once("exit", () => {
    if (!stopped) onFailure();
  });
  return async () => {
    if (stopped) return;
    stopped = true;
    udp.close();
    if (process.exitCode === null && process.signalCode === null) {
      const exited = once(process, "exit");
      process.kill("SIGTERM");
      const force = setTimeout(() => process.kill("SIGKILL"), 2000);
      try {
        await exited;
      } finally {
        clearTimeout(force);
      }
    }
  };
}
