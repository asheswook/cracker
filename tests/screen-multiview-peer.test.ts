import { expect, test } from "bun:test";
import { createSocket } from "node:dgram";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { RTCPeerConnection, useVP8 } from "werift";
import { CaptureHub } from "../packages/screen/capture-hub";
import { InputLease } from "../packages/screen/input-lease";
import { ScreenPeer } from "../packages/screen/peer";
import { ViewerEvent } from "../packages/screen/session-protocol";

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("local_peer_deadline");
    await Bun.sleep(10);
  }
}

test("two real WebRTC viewers share capture only while visible and hand off one input lease", async () => {
  let owner: "agent" | "user" = "user";
  let encoders = 0, encoderStops = 0;
  const lease = new InputLease({ control: () => owner });
  const calls: string[][] = [];
  const hub = new CaptureHub(async track => {
    encoders++;
    const udp = createSocket("udp4");
    udp.bind(0, "127.0.0.1");
    await once(udp, "listening");
    udp.on("message", packet => track.writeRtp(packet));
    const encoder = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-re", "-f", "lavfi", "-i", "testsrc=size=160x120:rate=10", "-an", "-c:v", "libvpx", "-deadline", "realtime", "-g", "10", "-pix_fmt", "yuv420p", "-f", "rtp", "-payload_type", "96", `rtp://127.0.0.1:${udp.address().port}?pkt_size=1200`], { stdio: "ignore" });
    return async () => {
      encoderStops++;
      udp.close();
      if (encoder.exitCode === null && encoder.signalCode === null) {
        const exited = once(encoder, "exit"); encoder.kill("SIGTERM"); await exited;
      }
    };
  });
  const peers: Array<{ sender: ScreenPeer; browser: RTCPeerConnection }> = [];
  const connect = async () => {
    const browser = new RTCPeerConnection({ iceServers: [], iceAdditionalHostAddresses: ["127.0.0.1"], codecs: { video: [useVP8()] } });
    browser.addTransceiver("video", { direction: "recvonly" });
    const channel = browser.createDataChannel("input", { ordered: true });
    const events: Array<ReturnType<typeof ViewerEvent.parse>> = [];
    let packets = 0;
    browser.onTrack.subscribe(track => track.onReceiveRtp.subscribe(() => packets++));
    channel.onMessage.subscribe(data => {
      const parsed = ViewerEvent.safeParse(JSON.parse(String(data)));
      if (parsed.success) events.push(parsed.data);
    });
    const answer = Promise.withResolvers<{ type: "answer"; sdp: string }>();
    const sender = new ScreenPeer({
      owner: { control: () => owner }, dimensions: { width: 160, height: 120 }, iceServers: [], visible: false,
      viewer: { id: crypto.randomUUID(), version: 2, lease }, execute: async args => { calls.push([...args]); },
      signal: value => answer.resolve(value), capture: (track, failed) => hub.subscribe(track, failed),
    });
    peers.push({ sender, browser });
    await browser.setLocalDescription(await browser.createOffer());
    await sender.signal({ type: "offer", sdp: browser.localDescription?.sdp ?? "" });
    await browser.setRemoteDescription(await answer.promise);
    await until(() => channel.readyState === "open");
    return { channel, events, packets: () => packets, send: (value: unknown) => channel.send(JSON.stringify(value)) };
  };
  try {
    const a = await connect(), b = await connect();
    await Bun.sleep(200);
    expect(encoders).toBe(0);
    expect([a.packets(), b.packets()]).toEqual([0, 0]);
    a.send({ type: "screen_visibility", visible: true });
    b.send({ type: "screen_visibility", visible: true });
    await until(() => a.packets() > 0 && b.packets() > 0);
    expect(encoders).toBe(1);
    expect(calls).toEqual([]);
    const claimA = crypto.randomUUID();
    a.send({ type: "input_claim", command_id: claimA });
    await until(() => a.events.some(event => event.type === "input_lease" && event.command_id === claimA && event.held));
    const epochA = lease.epoch;
    a.send({ type: "input", epoch: epochA, input: { type: "key", key: "Enter", action: "down" } });
    await until(() => calls.length === 1);
    const claimB = crypto.randomUUID();
    b.send({ type: "input_claim", command_id: claimB });
    await until(() => b.events.some(event => event.type === "input_lease" && event.command_id === claimB && event.held));
    expect(calls).toEqual([["keydown", "Return"], ["keyup", "Return"]]);
    a.send({ type: "input", epoch: epochA, input: { type: "key", key: "A", action: "down" } });
    await until(() => a.events.some(event => event.type === "input_result" && !event.accepted && event.code === "input_lease_required"));
    expect(calls).toHaveLength(2);
    b.send({ type: "input", epoch: lease.epoch, input: { type: "key", key: "B", action: "down" } });
    await until(() => calls.length === 3);
    owner = "agent";
    await lease.revoke();
    expect(calls.at(-1)).toEqual(["keyup", "B"]);
    a.send({ type: "screen_visibility", visible: false });
    b.send({ type: "screen_visibility", visible: false });
    await until(() => encoderStops === 1);
    await Bun.sleep(100);
    const idlePackets = [a.packets(), b.packets()];
    await Bun.sleep(250);
    expect([a.packets(), b.packets()]).toEqual(idlePackets);
    expect(a.channel.readyState).toBe("open"); expect(b.channel.readyState).toBe("open");
    console.log(JSON.stringify({ scenario: "two_local_webrtc_viewers", encoders, encoderStops, idlePacketsStable: true, inputs: calls.length, authority: owner }));
  } finally {
    await Promise.all(peers.map(async ({ sender, browser }) => { await sender.close(); await browser.close(); }));
    await hub.close();
  }
}, 30000);
