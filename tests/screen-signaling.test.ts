import { expect, test } from "bun:test";
import { ScreenSignaling, type SignalingPeer } from "../packages/screen/signaling";

test("a later offer retries failed retired-peer cleanup before creating its replacement", async () => {
  let created = 0, closed = 0;
  const first = Promise.withResolvers<void>(), replacement = Promise.withResolvers<void>();
  const session = new ScreenSignaling(() => {
    const index = ++created;
    return { signal: async () => { if (index === 1) first.resolve(); else replacement.resolve(); },
      releaseInputs: async () => {}, close: async () => { if (++closed === 1) throw new Error("synthetic_close_cleanup_failure"); } };
  }, () => {});
  session.receive({ type: "offer", sdp: "first" });
  await first.promise;
  await expect(session.close()).rejects.toThrow("synthetic_close_cleanup_failure");
  session.receive({ type: "offer", sdp: "replacement" });
  await replacement.promise;
  expect(created).toBe(2); expect(closed).toBe(2);
  await session.close();
});

test("viewer departure closes capture while ICE resolution is pending", async () => {
  const entered = Promise.withResolvers<void>();
  const lookup = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const peer: SignalingPeer = {
    signal: async (signal) => {
      if (signal.type === "ice") {
        entered.resolve();
        await lookup.promise;
      }
    },
    releaseInputs: async () => {},
    close: async () => {
      closed.resolve();
    },
  };
  const failures: unknown[] = [];
  const session = new ScreenSignaling(
    () => peer,
    (error) => failures.push(error),
  );
  session.receive({ type: "offer", sdp: "test" });
  session.receive({ type: "ice", candidate: null });
  await entered.promise;
  session.receive({ type: "peer_left" });
  try {
    expect(
      await Promise.race([closed.promise.then(() => true), Bun.sleep(50).then(() => false)]),
    ).toBe(true);
    expect(failures).toEqual([]);
  } finally {
    lookup.resolve();
    await session.close();
  }
});

test("replacement viewer progresses before an obsolete ICE lookup and survives its failure", async () => {
  const entered = Promise.withResolvers<void>();
  const lookup = Promise.withResolvers<void>();
  const replacement = Promise.withResolvers<void>();
  let count = 0;
  const closed: number[] = [];
  const failures: unknown[] = [];
  const session = new ScreenSignaling(
    (current) => {
      const id = ++count;
      return {
        signal: async (signal) => {
          if (id === 1 && signal.type === "ice") {
            entered.resolve();
            await lookup.promise;
            throw new Error("obsolete ICE failed");
          }
          if (id === 2 && signal.type === "offer" && current()) replacement.resolve();
        },
        close: async () => {
          closed.push(id);
        },
        releaseInputs: async () => {},
      };
    },
    (error) => failures.push(error),
  );
  session.receive({ type: "offer", sdp: "first" });
  session.receive({ type: "ice", candidate: null });
  await entered.promise;
  session.receive({ type: "peer_left" });
  session.receive({ type: "offer", sdp: "second" });
  try {
    expect(
      await Promise.race([replacement.promise.then(() => true), Bun.sleep(50).then(() => false)]),
    ).toBe(true);
    lookup.resolve();
    await Bun.sleep(0);
    expect(closed).toEqual([1]);
    expect(failures).toEqual([]);
  } finally {
    lookup.resolve();
    await session.close();
  }
});
