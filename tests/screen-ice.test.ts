import { expect, test } from "bun:test";
import { ScreenSignaling, type SignalingPeer } from "../packages/screen/signaling";

test("async peer creation receives offer after credentials resolve", async () => {
  // Given a peer that cannot exist until its credentials are available.
  const credentials = Promise.withResolvers<SignalingPeer>();
  const applied = Promise.withResolvers<string>();
  const failures: unknown[] = [];
  const session = new ScreenSignaling(() => credentials.promise, (error) => failures.push(error));
  // When an offer arrives before credential resolution.
  session.receive({ type: "offer", sdp: "offer" });
  credentials.resolve({ signal: async (value) => { if (value.type === "offer") applied.resolve(value.sdp); }, releaseInputs: async () => {}, close: async () => {} });
  // Then negotiation waits rather than treating a promise as a peer.
  try {
    expect(await Promise.race([applied.promise, Bun.sleep(100).then(() => "not-applied")])).toBe("offer");
    expect(failures).toEqual([]);
  } finally { await session.close(); }
});

test("departure aborts pending credentials and closes a late peer without signaling it", async () => {
  // Given unresolved peer creation.
  const entered = Promise.withResolvers<AbortSignal>();
  const credentials = Promise.withResolvers<SignalingPeer>();
  const closed = Promise.withResolvers<void>();
  let applied = false;
  const session = new ScreenSignaling((_current, signal) => { entered.resolve(signal); return credentials.promise; }, () => {});
  session.receive({ type: "offer", sdp: "obsolete" });
  const signal = await entered.promise;
  // When the viewer leaves before credentials resolve.
  await session.close();
  credentials.resolve({ signal: async () => { applied = true; }, releaseInputs: async () => {}, close: async () => { closed.resolve(); } });
  // Then pending I/O is cancelled and its late resource is released.
  expect(signal.aborted).toBe(true);
  expect(await Promise.race([closed.promise.then(() => true), Bun.sleep(100).then(() => false)])).toBe(true);
  expect(applied).toBe(false);
});
