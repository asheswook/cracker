import type { Tool } from "../../packages/provider";

export type Lane = "foreground" | "background";
export type LeaseHolder = { readonly runId: string; readonly lane: Lane; readonly since: number };
export type LeaseGrant = { readonly granted: true; readonly generation: number } | { readonly granted: false; readonly holder: LeaseHolder; readonly waitHintSeconds: number };
type Waiter = { readonly runId: string; readonly lane: Lane; readonly resolve: (grant: LeaseGrant) => void; readonly cleanup: () => void };

export const waitForDesktopTool: Tool = {
  type: "function", name: "wait_for_desktop", strict: true,
  description: "Wait until the shared desktop (computer use) is free for this task, up to max_seconds. Call only after a desktop tool returned desktop_busy and you have no other useful non-desktop work. When it returns granted, inspect the screen again before acting; earlier element indexes and coordinates are stale.",
  parameters: { type: "object", properties: { max_seconds: { type: "integer", minimum: 1, maximum: 600 } }, required: ["max_seconds"], additionalProperties: false },
};

/**
 * One run at a time may drive the physical desktop. The holder keeps the lease across observe→act→verify;
 * it is released when the run ends, yields to a waiting foreground run between actions, or idles out.
 */
export class DesktopLease {
  private holder: (LeaseHolder & { lastUse: number; inFlight: number }) | undefined;
  private generation = 0;
  private readonly waiters: Waiter[] = [];
  constructor(private readonly idleMs = 90_000, private readonly now = () => Date.now()) {}

  current(): LeaseHolder | undefined { this.expireIdle(); return this.holder && { runId: this.holder.runId, lane: this.holder.lane, since: this.holder.since }; }

  acquire(runId: string, lane: Lane): LeaseGrant {
    this.expireIdle();
    if (this.holder?.runId === runId) { this.holder.lastUse = this.now(); return { granted: true, generation: this.generation }; }
    if (!this.holder && !this.waiters.some(waiter => waiter.lane === "foreground" && waiter.runId !== runId)) return this.grant(runId, lane);
    const holder = this.holder ?? { runId: this.waiters[0]!.runId, lane: this.waiters[0]!.lane, since: this.now() };
    return { granted: false, holder: { runId: holder.runId, lane: holder.lane, since: holder.since }, waitHintSeconds: holder.lane === "foreground" ? 60 : 20 };
  }

  begin(runId: string): void { if (this.holder?.runId === runId) { this.holder.inFlight++; this.holder.lastUse = this.now(); } }
  end(runId: string): void {
    if (this.holder?.runId !== runId) return;
    this.holder.inFlight = Math.max(0, this.holder.inFlight - 1);
    this.holder.lastUse = this.now();
    if (this.holder.inFlight === 0 && this.holder.lane === "background" && this.waiters.some(waiter => waiter.lane === "foreground")) this.release(runId);
  }

  release(runId: string): void {
    if (this.holder?.runId !== runId || this.holder.inFlight > 0) return;
    this.holder = undefined;
    this.handOff();
  }

  wait(runId: string, lane: Lane, maxMs: number, signal: AbortSignal): Promise<LeaseGrant> {
    const immediate = this.acquire(runId, lane);
    if (immediate.granted || maxMs <= 0) return Promise.resolve(immediate);
    return new Promise(resolve => {
      const timer = setTimeout(() => finish(this.acquire(runId, lane)), maxMs);
      const abort = () => finish(this.acquire(runId, lane));
      const finish = (grant: LeaseGrant) => { waiter.cleanup(); resolve(grant); };
      const waiter: Waiter = { runId, lane, resolve: finish, cleanup: () => {
        clearTimeout(timer); signal.removeEventListener("abort", abort);
        const index = this.waiters.indexOf(waiter); if (index >= 0) this.waiters.splice(index, 1);
      } };
      signal.addEventListener("abort", abort, { once: true });
      if (lane === "foreground") this.waiters.unshift(waiter); else this.waiters.push(waiter);
      if (this.holder && this.holder.lane === "background" && lane === "foreground" && this.holder.inFlight === 0) this.release(this.holder.runId);
    });
  }

  revokeAll(): void { this.holder = undefined; this.generation++; }

  private grant(runId: string, lane: Lane): LeaseGrant {
    this.generation++;
    this.holder = { runId, lane, since: this.now(), lastUse: this.now(), inFlight: 0 };
    return { granted: true, generation: this.generation };
  }
  private handOff(): void {
    const next = this.waiters[0];
    if (!next) return;
    const grant = this.grant(next.runId, next.lane);
    next.resolve(grant);
  }
  private expireIdle(): void {
    if (this.holder && this.holder.inFlight === 0 && this.now() - this.holder.lastUse > this.idleMs) { this.holder = undefined; this.handOff(); }
  }
}

export function desktopBusy(grant: Extract<LeaseGrant, { granted: false }>) {
  return { text: JSON.stringify({
    status: "desktop_busy", executed: false,
    holder: grant.holder.lane === "foreground" ? "the user's current conversation task" : "a background task",
    wait_hint_seconds: grant.waitHintSeconds,
    instruction: "The shared desktop is in use by another task. Do non-desktop work first (research, shell, files, browser tabs via browser_* tools are separate), then call wait_for_desktop if you still need the desktop. Do not bypass with shell, xdotool or Python.",
  }) };
}
