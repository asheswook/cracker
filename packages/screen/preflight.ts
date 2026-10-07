import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { inspectDisplay } from "./capture";
import { ScreenError } from "./protocol";

const execute = promisify(execFile);
export async function preflightScreen(display: string): Promise<void> {
  if (process.platform !== "linux") throw new ScreenError("screen_requires_linux_x11");
  const release = await readFile("/etc/os-release", "utf8");
  if (!/^ID=ubuntu$/m.test(release) || !/^VERSION_ID="24\.04"$/m.test(release))
    throw new ScreenError("screen_requires_ubuntu_24_04");
  for (const program of ["ffmpeg", "xdotool", "xclip", "xdpyinfo", "xprop", "python3", "scrot"]) {
    if (!Bun.which(program)) throw new ScreenError(`screen_missing_${program}`);
  }
  const devices = await execute("ffmpeg", ["-hide_banner", "-devices"], {
    timeout: 10000,
    maxBuffer: 1048576,
  });
  if (!/\bx11grab\b/.test(devices.stdout)) throw new ScreenError("ffmpeg_missing_x11grab");
  const encoders = await execute("ffmpeg", ["-hide_banner", "-encoders"], {
    timeout: 10000,
    maxBuffer: 1048576,
  });
  if (!/\blibvpx\b/.test(encoders.stdout)) throw new ScreenError("ffmpeg_missing_libvpx");
  await inspectDisplay(display);
}
