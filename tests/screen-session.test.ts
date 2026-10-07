import { expect, test } from "bun:test";
import { MediaStreamTrack, RtpPacket, RtpHeader } from "werift";
import { InputLease } from "../packages/screen/input-lease";
import { CaptureHub } from "../packages/screen/capture-hub";
import { ScreenPeer } from "../packages/screen/peer";

test("preconnected hidden peer starts no capture", async () => {
  let captures = 0;
  const peer = new ScreenPeer({
    owner: { control: () => "user" }, dimensions: { width: 160, height: 120 }, iceServers: [],
    execute: async () => {}, signal: () => {}, visible: false,
    capture: async () => { captures++; return async () => {}; },
  });
  try {
    peer.pc.connectionStateChange.execute("connected");
    await Bun.sleep(0);
    expect(captures).toBe(0);
  } finally { await peer.close(); }
});

test("input handoff fences queued old input before awaiting held-key release", async () => {
  let now = 1000;
  const lease = new InputLease({ control: () => "user" }, () => now);
  const release = Promise.withResolvers<void>();
  const events: string[] = [];
  lease.register("a", { visible: () => true, release: async () => { events.push("release_a"); await release.promise; }, changed: (epoch, held) => events.push(`a:${epoch}:${held}`) });
  lease.register("b", { visible: () => true, release: async () => {}, changed: (epoch, held) => events.push(`b:${epoch}:${held}`) });
  const first = await lease.claim("a");
  expect(lease.permits("a", first)).toBe(true);
  const next = lease.claim("b");
  expect(lease.permits("a", first)).toBe(false);
  expect(lease.permits("b", lease.epoch)).toBe(false);
  release.resolve();
  const second = await next;
  expect(lease.permits("b", second)).toBe(true);
  expect(events.indexOf("release_a")).toBeLessThan(events.indexOf(`b:${second}:true`));
  now += 30001;
  expect(lease.permits("b", second)).toBe(false);
  await lease.expire();
  expect(lease.epoch).toBeGreaterThan(second);
});

test("hide then reveal during a pending handoff cannot resurrect its claim", async () => {
  const lease = new InputLease({ control: () => "user" });
  const release = Promise.withResolvers<void>();
  lease.register("a", { visible: () => true, release: () => release.promise, changed: () => {} });
  lease.register("b", { visible: () => true, release: async () => {}, changed: () => {} });
  await lease.claim("a");
  const next = lease.claim("b");
  const cancelled = lease.release("b");
  release.resolve();
  await expect(next).rejects.toThrow("input_claim_superseded");
  await cancelled;
  expect(lease.permits("b", lease.epoch)).toBe(false);
});

test("failed key cleanup stays fenced and is retried before a later explicit claim", async () => {
  const lease = new InputLease({ control: () => "user" });
  let attempts = 0;
  lease.register("a", { visible: () => true, release: async () => { attempts++; if (attempts === 1) throw new Error("synthetic_release_timeout"); }, changed: () => {} });
  lease.register("b", { visible: () => true, release: async () => {}, changed: () => {} });
  const original = await lease.claim("a");
  await expect(lease.claim("b")).rejects.toThrow("synthetic_release_timeout");
  expect(lease.permits("a", original)).toBe(false);
  expect(lease.permits("b", lease.epoch)).toBe(false);
  const retried = await lease.claim("b");
  expect(attempts).toBe(2);
  expect(lease.permits("b", retried)).toBe(true);
});

test("legacy cleanup retry remains gated and never steals an existing viewer lease", async () => {
  const lease = new InputLease({ control: () => "user" });
  let attempts = 0;
  lease.register("a", { visible: () => true, release: async () => { if (++attempts === 1) throw new Error("synthetic_release_timeout"); }, changed: () => {} });
  lease.register("b", { visible: () => true, release: async () => {}, changed: () => {} });
  await lease.claim("a");
  await expect(lease.claimLegacy("b")).rejects.toThrow("input_lease_required");
  expect(attempts).toBe(0);
  await expect(lease.revoke()).rejects.toThrow("synthetic_release_timeout");
  const epoch = await lease.claimLegacy("b");
  expect(attempts).toBe(2);
  expect(lease.permits("b", epoch)).toBe(true);
});

test("two visible subscribers share one encoder; hidden subscribers receive no packets", async () => {
  let starts = 0, stops = 0;
  let source: MediaStreamTrack | undefined;
  const hub = new CaptureHub(async track => { source = track; starts++; return async () => { stops++; }; });
  const a = new MediaStreamTrack({ kind: "video" }), b = new MediaStreamTrack({ kind: "video" });
  let packetsA = 0, packetsB = 0;
  a.onReceiveRtp.subscribe(() => packetsA++);
  b.onReceiveRtp.subscribe(() => packetsB++);
  const first = await hub.subscribe(a, () => {}), second = await hub.subscribe(b, () => {});
  expect(starts).toBe(1);
  const packet = () => new RtpPacket(new RtpHeader({ payloadType: 96 }), Buffer.from([0x10, 0, 0, 0]));
  source?.writeRtp(packet());
  expect([packetsA, packetsB]).toEqual([1, 1]);
  await first();
  source?.writeRtp(packet());
  expect([packetsA, packetsB]).toEqual([1, 2]);
  expect(stops).toBe(0);
  await second();
  expect(stops).toBe(1);
  await hub.close();
  a.stop(); b.stop();
});

test("warm subscriptions keep RTP sequence and VP8 time continuous across encoder resets", async () => {
  let source: MediaStreamTrack | undefined, now = 0;
  const hub = new CaptureHub(async track => { source = track; return async () => {}; }, () => now);
  const target = new MediaStreamTrack({ kind: "video" });
  const received: Array<[number, number]> = [];
  target.onReceiveRtp.subscribe(packet => received.push([packet.header.sequenceNumber, packet.header.timestamp]));
  const first = await hub.subscribe(target, () => {});
  source?.writeRtp(new RtpPacket(new RtpHeader({ sequenceNumber: 65535, timestamp: 0xfffffff0 }), Buffer.from([0x10, 0, 0, 0])));
  await first(); now = 2000;
  const second = await hub.subscribe(target, () => {});
  source?.writeRtp(new RtpPacket(new RtpHeader({ sequenceNumber: 12345, timestamp: 456789 }), Buffer.from([0x10, 0, 0, 0])));
  source?.writeRtp(new RtpPacket(new RtpHeader({ sequenceNumber: 12347, timestamp: 462789 }), Buffer.from([1])));
  expect(received).toEqual([[65535, 0xfffffff0], [0, (0xfffffff0 + 180000) >>> 0], [2, (0xfffffff0 + 186000) >>> 0]]);
  await second(); await hub.close(); target.stop();
});

test("new and resumed subscriptions wait for a keyframe while existing viewers continue", async () => {
  let source: MediaStreamTrack | undefined;
  const hub = new CaptureHub(async track => { source = track; return async () => {}; });
  const a = new MediaStreamTrack({ kind: "video" }), b = new MediaStreamTrack({ kind: "video" });
  let countA = 0, countB = 0;
  a.onReceiveRtp.subscribe(() => countA++); b.onReceiveRtp.subscribe(() => countB++);
  const send = (payload: number[]) => source?.writeRtp(new RtpPacket(new RtpHeader({ payloadType: 96 }), Buffer.from(payload)));
  const offA = await hub.subscribe(a, () => {});
  send([0x10, 1, 0, 0]); expect(countA).toBe(0);
  send([0x10, 0, 0, 0]); expect(countA).toBe(1);
  const offB = await hub.subscribe(b, () => {});
  send([0x00, 0, 0, 0]); expect([countA, countB]).toEqual([2, 0]);
  send([0x10, 1, 0, 0]); expect([countA, countB]).toEqual([3, 0]);
  send([0x10, 0, 0, 0]); expect([countA, countB]).toEqual([4, 1]);
  await offA(); const resumed = await hub.subscribe(a, () => {});
  send([0x10, 1, 0, 0]); expect([countA, countB]).toEqual([4, 2]);
  send([0x10, 0, 0, 0]); expect([countA, countB]).toEqual([5, 3]);
  await resumed(); await offB(); await hub.close(); a.stop(); b.stop();
});
