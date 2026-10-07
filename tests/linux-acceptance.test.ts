import { expect, test } from "bun:test";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { RTCPeerConnection, useVP8 } from "werift";
import { z } from "zod";
import { captureScreen, inspectDisplay } from "../packages/screen/capture";
import { x11Executor } from "../packages/screen/input";
import { ScreenPeer } from "../packages/screen/peer";
import { execute } from "../services/daemon/shell";

const command = promisify(execFile);
const enabled = process.platform === "linux" && process.env["RUN_LINUX_ACCEPTANCE"] === "1";
async function bounded<T>(promise: Promise<T>, milliseconds = 15000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Linux acceptance timeout")), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function children() {
  const { stdout } = await command("ps", ["-o", "comm=", "--ppid", String(process.pid)]);
  return stdout.split("\n").filter((name) => name.trim() === "ffmpeg").length;
}
test.skipIf(!enabled)(
  "Linux X11 screen reaches WebRTC and real pointer obeys ownership",
  async () => {
    const desktop = spawn(
      "Xvfb",
      ["-displayfd", "1", "-screen", "0", "640x480x24", "-nolisten", "tcp", "-ac"],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    const display = `:${String((await bounded(once(desktop.stdout, "data")))[0]).trim()}`;
    const dimensions = await inspectDisplay(display);
    const baseline = await children();
    const viewer = new RTCPeerConnection({
      iceServers: [],
      iceAdditionalHostAddresses: ["127.0.0.1"],
      codecs: { video: [useVP8()] },
    });
    viewer.addTransceiver("video", { direction: "recvonly" });
    const channel = viewer.createDataChannel("input");
    const received = Promise.withResolvers<number>();
    viewer.onTrack.subscribe((track) =>
      track.onReceiveRtp.subscribe((packet) => received.resolve(packet.payload.length)),
    );
    let owner: "agent" | "user" = "agent";
    let response = Promise.withResolvers<boolean>();
    channel.onMessage.subscribe((value) => {
      const parsed = z
        .object({ type: z.string(), accepted: z.boolean().optional() })
        .safeParse(JSON.parse(typeof value === "string" ? value : value.toString("utf8")));
      if (
        parsed.success &&
        parsed.data.type === "input_result" &&
        parsed.data.accepted !== undefined
      )
        response.resolve(parsed.data.accepted);
    });
    const sender = new ScreenPeer({
      owner: { control: () => owner },
      dimensions,
      iceServers: [],
      execute: x11Executor(display),
      signal: (answer) => {
        void viewer.setRemoteDescription(answer);
      },
      capture: (track, failed) => captureScreen(track, { display, dimensions }, failed),
    });
    const position = async () =>
      (
        await command("xdotool", ["getmouselocation", "--shell"], {
          env: { ...process.env, DISPLAY: display },
        })
      ).stdout;
    const move = async (x: number, y: number, action: "move" | "down" | "up" = "move") => {
      response = Promise.withResolvers<boolean>();
      channel.send(JSON.stringify({ type: "pointer", x, y, action }));
      return bounded(response.promise);
    };
    try {
      await viewer.setLocalDescription(await viewer.createOffer());
      const offer = viewer.localDescription;
      if (!offer) throw new Error("Missing offer");
      await sender.signal({ type: "offer", sdp: offer.sdp });
      if (channel.readyState !== "open")
        await bounded(channel.stateChanged.watch((state) => state === "open"));
      expect(await bounded(received.promise)).toBeGreaterThan(0);
      expect(await children()).toBe(baseline + 1);
      const before = await position();
      expect(await move(1, 1)).toBe(false);
      expect(await position()).toBe(before);
      owner = "user";
      expect(await move(1, 1)).toBe(true);
      expect(await position()).toContain("X=639\nY=479");
      for (const action of ["move", "down", "up"] as const) {
        expect(await move(1, 1, action)).toBe(true);
      }

      owner = "agent";
      await sender.releaseInputs();
      expect(await move(0, 0)).toBe(false);
      expect(await position()).toContain("X=639\nY=479");
      console.log(
        JSON.stringify({
          scenario: "linux_x11_webrtc",
          dimensions,
          rtp: true,
          ownership: "agent-denied/user-accepted/returned-denied",
        }),
      );
    } finally {
      await sender.close();
      await viewer.close();
      const exited = once(desktop, "exit");
      desktop.kill("SIGTERM");
      await bounded(exited);
    }
    expect(await children()).toBe(baseline);
  },
  45000,
);

test.skipIf(!enabled)(
  "Linux cancellation terminates a real spawned process group",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "assistant-linux-cancel-"));
    const controller = new AbortController();
    const running = execute(
      ["bash", "-c", "sleep 60 & child=$!; printf '%s' \"$child\" > child.pid; wait"],
      controller.signal,
      directory,
    );
    const outcome = running.then(
      () => "unexpected-success",
      (error) => (error instanceof Error ? error.message : "unknown-error"),
    );
    try {
      const start = Date.now();
      while (!(await Bun.file(join(directory, "child.pid")).exists())) {
        if (Date.now() - start > 3000) throw new Error("Child did not start");
        await Bun.sleep(10);
      }
      const pid = z.coerce
        .number()
        .int()
        .positive()
        .parse(await readFile(join(directory, "child.pid"), "utf8"));
      controller.abort();
      expect(await bounded(outcome, 5000)).toBe("aborted");
      const proc = Bun.file(`/proc/${pid}/stat`);
      if (await proc.exists())
        expect((await proc.text()).split(") ")[1]?.startsWith("Z ")).toBe(true);
      console.log(JSON.stringify({ scenario: "linux_process_group_cancel", child_running: false }));
    } finally {
      controller.abort();
      await bounded(outcome, 5000);
      await rm(directory, { recursive: true, force: true });
    }
  },
  10000,
);
