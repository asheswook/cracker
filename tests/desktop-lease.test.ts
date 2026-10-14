import { expect, test } from "bun:test";
import { DesktopLease, desktopBusy } from "../services/daemon/desktop-lease.ts";

const never = () => new AbortController().signal;

test("one run holds the desktop across actions; another run is told who holds it", () => {
  const lease = new DesktopLease();
  expect(lease.acquire("a", "background").granted).toBe(true);
  expect(lease.acquire("a", "background").granted).toBe(true);
  const busy = lease.acquire("b", "background");
  expect(busy).toMatchObject({ granted: false, holder: { runId: "a", lane: "background" } });
  if (busy.granted) throw new Error("expected busy");
  expect(JSON.parse(desktopBusy(busy).text)).toMatchObject({ status: "desktop_busy", executed: false, holder: "a background task" });
});

test("a waiting foreground run takes over from background at the next action boundary, never mid-action", async () => {
  const lease = new DesktopLease();
  lease.acquire("bg", "background");
  lease.begin("bg");
  let granted = false;
  const waiting = lease.wait("fg", "foreground", 5000, never()).then(grant => { granted = grant.granted; return grant; });
  await Bun.sleep(5);
  expect(granted).toBe(false);
  lease.end("bg");
  expect((await waiting).granted).toBe(true);
  expect(lease.current()?.runId).toBe("fg");
  expect(lease.acquire("bg", "background").granted).toBe(false);
});

test("an idle background holder yields immediately when foreground starts waiting", async () => {
  const lease = new DesktopLease();
  lease.acquire("bg", "background");
  expect((await lease.wait("fg", "foreground", 1000, never())).granted).toBe(true);
});

test("foreground is not preempted by background; background waits and is handed the lease on release", async () => {
  const lease = new DesktopLease();
  lease.acquire("fg", "foreground");
  const waiting = lease.wait("bg", "background", 5000, never());
  lease.end("fg");
  expect(lease.current()?.runId).toBe("fg");
  lease.release("fg");
  expect(await waiting).toMatchObject({ granted: true });
  expect(lease.current()?.runId).toBe("bg");
});

test("wait times out with a busy result and abort stops waiting promptly", async () => {
  const lease = new DesktopLease();
  lease.acquire("a", "foreground");
  expect((await lease.wait("b", "background", 20, never())).granted).toBe(false);
  const controller = new AbortController();
  const waiting = lease.wait("c", "background", 60_000, controller.signal);
  controller.abort();
  expect((await waiting).granted).toBe(false);
});

test("an idle holder expires so a crashed or forgetful run cannot keep the desktop forever", () => {
  let now = 0;
  const lease = new DesktopLease(1000, () => now);
  lease.acquire("a", "background");
  now = 500; expect(lease.acquire("b", "background").granted).toBe(false);
  now = 1600; expect(lease.acquire("b", "background").granted).toBe(true);
});

test("an in-flight action never expires and release during an action is deferred", () => {
  let now = 0;
  const lease = new DesktopLease(1000, () => now);
  lease.acquire("a", "background");
  lease.begin("a");
  now = 10_000;
  expect(lease.acquire("b", "background").granted).toBe(false);
  lease.release("a");
  expect(lease.current()?.runId).toBe("a");
});

test("generation changes on every grant so stale observations can be detected", () => {
  const lease = new DesktopLease();
  const first = lease.acquire("a", "foreground");
  lease.release("a");
  const second = lease.acquire("b", "foreground");
  if (!first.granted || !second.granted) throw new Error("expected grants");
  expect(second.generation).toBeGreaterThan(first.generation);
});
