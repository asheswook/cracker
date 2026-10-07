import { test, expect } from "bun:test";
import { ToolScheduler, scheduledBatch } from "../services/daemon/tool-scheduler.ts";

test("independent reads overlap while an exclusive action is an ordered barrier", async () => {
  // Given two reads that cannot finish until both started.
  const scheduler = new ToolScheduler(3),
    events: string[] = [],
    gate = Promise.withResolvers<void>();
  let active = 0,
    peak = 0;
  const read = (id: string) =>
    scheduler.run("read", AbortSignal.timeout(1000), async () => {
      events.push(id);
      peak = Math.max(peak, ++active);
      if (active === 2) gate.resolve();
      await gate.promise;
      active--;
      return id;
    });
  // When the write and later read are queued behind them.
  const first = read("a"),
    second = read("b");
  const write = scheduler.run("exclusive", AbortSignal.timeout(1000), async () => {
    expect(active).toBe(0);
    events.push("write");
  });
  const last = scheduler.run("read", AbortSignal.timeout(1000), async () => events.push("last"));
  await Promise.all([first, second, write, last]);
  // Then
  expect(peak).toBe(2);
  expect(events).toEqual(["a", "b", "write", "last"]);
});

test("a failed batch cancels later exclusive mutations before they start", async () => {
  const scheduler = new ToolScheduler(3);
  let mutated = false;
  const result = scheduledBatch(
    ["read", "write"],
    (item, signal) =>
      scheduler.run(item === "read" ? "read" : "exclusive", signal, async () => {
        if (item === "read") throw new TypeError("failed read");
        mutated = true;
      }),
    AbortSignal.timeout(1000),
  );
  await expect(result).rejects.toThrow("failed read");
  expect(mutated).toBe(false);
});

test("read concurrency never exceeds configured capacity", async () => {
  const scheduler = new ToolScheduler(3),
    three = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let active = 0,
    peak = 0,
    started = 0;
  const work = scheduledBatch(
    [1, 2, 3, 4, 5],
    (_item, signal) =>
      scheduler.run("read", signal, async () => {
        started++;
        peak = Math.max(peak, ++active);
        if (started === 3) three.resolve();
        await release.promise;
        active--;
      }),
    AbortSignal.timeout(1000),
  );
  await three.promise;
  expect(started).toBe(3);
  release.resolve();
  await work;
  expect(peak).toBe(3);
  expect(started).toBe(5);
});

test("aborted queued operation never executes after the owner drains", async () => {
  // Given an exclusive owner and queued operation.
  const scheduler = new ToolScheduler(3),
    gate = Promise.withResolvers<void>(),
    abort = new AbortController();
  let executed = false;
  const owner = scheduler.run("exclusive", AbortSignal.timeout(1000), () => gate.promise);
  const queued = scheduler.run("read", abort.signal, async () => {
    executed = true;
  });
  // When cancelled before release.
  abort.abort();
  gate.resolve();
  await owner;
  // Then
  await expect(queued).rejects.toThrow();
  expect(executed).toBe(false);
});
