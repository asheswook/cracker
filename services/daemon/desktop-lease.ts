import type { Tool } from "../../packages/provider";

export type Lane = "foreground" | "background";
export type LeaseHolder = { readonly runId: string; readonly lane: Lane; readonly since: number };
export type LeaseGrant = { readonly granted: true; readonly generation: number } | { readonly granted: false; readonly holder: LeaseHolder; readonly waitHintSeconds: number };
const USER_HOLDER = "user";
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
  private blocked = false;
  private idleTimer:ReturnType<typeof setTimeout>|undefined;
  private readonly waiters: Waiter[] = [];
  constructor(private readonly idleMs = 90_000, private readonly now = () => Date.now()) {}

  current(): LeaseHolder | undefined { this.expireIdle(); return this.holder && { runId: this.holder.runId, lane: this.holder.lane, since: this.holder.since }; }

  acquire(runId: string, lane: Lane): LeaseGrant {
    if(this.blocked)return this.busy();
    this.expireIdle();
    if (this.holder?.runId === runId) { this.holder.lastUse = this.now();this.armIdle(); return { granted: true, generation: this.generation }; }
    if (!this.holder && !this.waiters.some(waiter => waiter.lane === "foreground" && waiter.runId !== runId)) return this.grant(runId, lane);
    const holder = this.holder ?? { runId: this.waiters[0]!.runId, lane: this.waiters[0]!.lane, since: this.now() };
    return { granted: false, holder: { runId: holder.runId, lane: holder.lane, since: holder.since }, waitHintSeconds: holder.lane === "foreground" ? 60 : 20 };
  }

  owns(runId:string,generation:number):boolean{return !this.blocked&&this.holder?.runId===runId&&this.generation===generation;}
  begin(runId: string): void { if (this.holder?.runId === runId) { this.holder.inFlight++; this.holder.lastUse = this.now();this.armIdle(); } }
  end(runId: string): void {
    if (this.holder?.runId !== runId) return;
    this.holder.inFlight = Math.max(0, this.holder.inFlight - 1);
    this.holder.lastUse = this.now();
    if (this.holder.inFlight === 0 && this.holder.lane === "background" && this.waiters.some(waiter => waiter.lane === "foreground")) this.release(runId);
    else this.armIdle();
  }

  release(runId: string): void {
    if (this.holder?.runId !== runId || this.holder.inFlight > 0) return;
    this.holder = undefined;
    this.armIdle();
    this.handOff();
  }

  wait(runId: string, lane: Lane, maxMs: number, signal: AbortSignal): Promise<LeaseGrant> {
    if(signal.aborted)return Promise.resolve(this.busy());
    const immediate = this.acquire(runId, lane);
    if (immediate.granted || maxMs <= 0) return Promise.resolve(immediate);
    return new Promise(resolve => {
      let settled=false;
      const timer = setTimeout(() => finish(this.busy()), maxMs);
      const abort = () => finish(this.busy());
      const finish = (grant: LeaseGrant) => {if(settled)return;settled=true;waiter.cleanup(); resolve(grant); };
      const waiter: Waiter = { runId, lane, resolve: finish, cleanup: () => {
        clearTimeout(timer); signal.removeEventListener("abort", abort);
        const index = this.waiters.indexOf(waiter); if (index >= 0) this.waiters.splice(index, 1);
        this.armIdle();
      } };
      signal.addEventListener("abort", abort, { once: true });
      if (lane === "foreground") {const firstBackground=this.waiters.findIndex(next=>next.lane==='background');this.waiters.splice(firstBackground<0?this.waiters.length:firstBackground,0,waiter);} else this.waiters.push(waiter);
      if (this.holder && this.holder.lane === "background" && lane === "foreground" && this.holder.inFlight === 0) this.release(this.holder.runId);
      else this.armIdle();
    });
  }

  revokeAll(): void { this.blocked=true;this.holder = undefined; this.generation++;this.armIdle();for(const waiter of [...this.waiters])waiter.resolve(this.busy()); }
  allowGrants():void {this.blocked=false;this.handOff();}
  private busy():Extract<LeaseGrant,{granted:false}>{return {granted:false,holder:this.blocked?{runId:USER_HOLDER,lane:'foreground',since:this.now()}:this.holder??{runId:'queue',lane:this.waiters[0]?.lane??'foreground',since:this.now()},waitHintSeconds:20};}

  private grant(runId: string, lane: Lane): LeaseGrant {
    this.generation++;
    this.holder = { runId, lane, since: this.now(), lastUse: this.now(), inFlight: 0 };
    this.armIdle();
    return { granted: true, generation: this.generation };
  }
  private handOff(): void {
    if(this.blocked||this.holder)return;
    const next = this.waiters[0];
    if (!next) return;
    const grant = this.grant(next.runId, next.lane);
    next.resolve(grant);
  }
  private expireIdle(): void {
    if (!this.blocked&&this.holder && this.holder.inFlight === 0 && this.now() - this.holder.lastUse >= this.idleMs) { this.holder = undefined; this.handOff(); }
  }
  private armIdle():void{
    clearTimeout(this.idleTimer);this.idleTimer=undefined;
    if(this.blocked||!this.holder||this.holder.inFlight||!this.waiters.length)return;
    this.idleTimer=setTimeout(()=>{this.idleTimer=undefined;this.expireIdle();this.armIdle();},Math.max(1,this.idleMs-(this.now()-this.holder.lastUse)));
  }
}

export function desktopBusy(grant: Extract<LeaseGrant, { granted: false }>) {
  // A user takeover revokes every lease; the model must ask for control, not wait.
  if (grant.holder.runId === USER_HOLDER) return { text: JSON.stringify({
    status: "computer_control_required", executed: false,
    instruction: "The user controls mouse, keyboard and the shared browser. Continue non-desktop work, or call request_computer_control with a reason before desktop input.",
  }) };
  return { text: JSON.stringify({
    status: "desktop_busy", executed: false,
    holder: grant.holder.lane === "foreground" ? "the user's current conversation task" : "a background task",
    wait_hint_seconds: grant.waitHintSeconds,
    instruction: "The shared desktop, including every browser_* tool, is in use. Do non-desktop work first (research, shell, files), then call wait_for_desktop if needed. After a grant, make a fresh observation. Do not bypass with shell, xdotool or Python.",
  }) };
}
