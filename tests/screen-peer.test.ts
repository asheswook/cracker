import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createSocket } from "node:dgram";
import { once } from "node:events";
import { RTCPeerConnection, useVP8 } from "werift";
import { ScreenPeer } from "../packages/screen/peer";

test("concurrent close waits for capture initialization and the same cleanup barrier", async () => {
  const started = Promise.withResolvers<void>();
  const captured = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  let stops = 0;
  const sender = new ScreenPeer({
    owner: { control: () => "agent" },
    dimensions: { width: 160, height: 120 },
    iceServers: [],
    execute: async () => {},
    signal: () => {},
    capture: async () => {
      started.resolve();
      await captured.promise;
      return async () => {
        stops++;
        await released.promise;
      };
    },
  });
  sender.pc.connectionStateChange.execute("connected");
  await started.promise;
  const first = sender.close(),
    second = sender.close();
  let completed = false;
  void second.then(() => {
    completed = true;
  });
  try {
    expect(first).toBe(second);
    await Bun.sleep(0);
    expect(completed).toBe(false);
    captured.resolve();
    await Bun.sleep(0);
    expect(completed).toBe(false);
    expect(stops).toBe(1);
  } finally {
    captured.resolve();
    released.resolve();
    await Promise.all([first, second]);
  }
});

test("transports real ffmpeg VP8 RTP and gated user input over negotiated WebRTC", async () => {
  // Given two actual werift peers and an ffmpeg lavfi source (not an X11 capture claim).
  const viewer = new RTCPeerConnection({
    iceServers: [],
    iceAdditionalHostAddresses: ["127.0.0.1"],
    codecs: { video: [useVP8()] },
  });
  viewer.addTransceiver("video", { direction: "recvonly" });
  const channel = viewer.createDataChannel("input");
  const receivedVideo = new Promise<number>((resolve) => {
    viewer.onTrack.subscribe((track) => {
      track.onReceiveRtp.subscribe((packet) => resolve(packet.payload.length));
    });
  });
  const accepted = new Promise<void>((resolve) =>
    channel.onMessage.subscribe((value) => {
      if (typeof value === "string" && JSON.parse(value).accepted === true) resolve();
    }),
  );
  let captureStopped = false;
  const calls: string[][] = [];
  const sender = new ScreenPeer({
    owner: { control: () => "user" },
    dimensions: { width: 160, height: 120 },
    iceServers: [],
    execute: async (args) => {
      calls.push([...args]);
    },
    signal: (answer) => {
      void viewer.setRemoteDescription(answer);
    },
    capture: async (track) => {
      const udp = createSocket("udp4");
      udp.bind(0, "127.0.0.1");
      await once(udp, "listening");
      udp.on("message", (packet) => track.writeRtp(packet));
      const encoder = spawn(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-re",
          "-f",
          "lavfi",
          "-i",
          "testsrc=size=160x120:rate=10",
          "-an",
          "-c:v",
          "libvpx",
          "-deadline",
          "realtime",
          "-g",
          "10",
          "-pix_fmt",
          "yuv420p",
          "-f",
          "rtp",
          "-payload_type",
          "96",
          `rtp://127.0.0.1:${udp.address().port}?pkt_size=1200`,
        ],
        { stdio: "ignore" },
      );
      return async () => {
        udp.close();
        const exited = once(encoder, "exit");
        encoder.kill("SIGKILL");
        await exited;
        captureStopped = true;
      };
    },
  });
  try {
    // When offer/answer negotiates the transport and user sends datachannel input.
    await viewer.setLocalDescription(await viewer.createOffer());
    const offer = viewer.localDescription;
    if (!offer) throw new Error("missing offer");
    await sender.signal({ type: "offer", sdp: offer.sdp });
    if (channel.readyState !== "open")
      await channel.stateChanged.watch((state) => state === "open");
    channel.send(JSON.stringify({ type: "pointer", x: 1, y: 1, action: "move" }));
    const bytes = await receivedVideo;
    await accepted;
    // Then encrypted WebRTC media arrives and input reaches the executor exactly once.
    expect(bytes).toBeGreaterThan(0);
    expect(calls).toEqual([["mousemove", "159", "119"]]);
  } finally {
    await sender.close();
    await viewer.close();
  }
  expect(captureStopped).toBe(true);
}, 30000);
