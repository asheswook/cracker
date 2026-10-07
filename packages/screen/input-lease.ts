import { INPUT_LEASE_MS } from "./session-protocol";
import { type ControlOwner, ScreenError } from "./protocol";

type Participant = {
  readonly visible: () => boolean;
  readonly release: () => Promise<void>;
  readonly changed: (epoch: number, held: boolean) => void;
};

export class InputLease {
  private readonly participants = new Map<string, Participant>();
  private holder: string | undefined;
  private pending: string | undefined;
  private revision = 0;
  private expires = 0;
  private barrier: Promise<void> = Promise.resolve();
  private readonly cleanup = new Set<Participant>();
  constructor(private readonly owner: ControlOwner, private readonly now: () => number = Date.now) {}
  get epoch(): number { return this.revision; }
  register(id: string, participant: Participant): void {
    if (this.participants.has(id)) throw new ScreenError("viewer_exists");
    this.participants.set(id, participant);
  }
  permits(id: string, epoch: number): boolean {
    return this.holder === id && this.revision === epoch && this.expires > this.now()
      && this.owner.control() === "user" && this.participants.get(id)?.visible() === true;
  }
  heartbeat(id: string, epoch: number): void {
    if (this.permits(id, epoch)) this.expires = this.now() + INPUT_LEASE_MS;
  }
  async claimLegacy(id: string): Promise<number> {
    await this.expire().catch(() => undefined);
    if ((this.holder && this.holder !== id) || (this.pending && this.pending !== id))
      throw new ScreenError("input_lease_required");
    return this.claim(id);
  }
  async claim(id: string): Promise<number> {
    const participant = this.participants.get(id);
    if (!participant?.visible() || this.owner.control() !== "user") throw new ScreenError("user_control_required");
    if (this.permits(id, this.revision)) { this.heartbeat(id, this.revision); return this.revision; }
    const barrier = this.revoke();
    const revision = this.revision;
    this.pending = id;
    await barrier;
    if (revision !== this.revision || this.participants.get(id) !== participant || !participant.visible()
      || this.owner.control() !== "user") throw new ScreenError("input_claim_superseded");
    this.holder = id;
    this.pending = undefined;
    this.expires = this.now() + INPUT_LEASE_MS;
    participant.changed(this.revision, true);
    return this.revision;
  }
  release(id: string, epoch = this.revision): Promise<void> {
    return (this.holder === id || this.pending === id) && epoch === this.revision ? this.revoke() : this.barrier;
  }
  async unregister(id: string): Promise<void> {
    const released = this.release(id);
    this.participants.delete(id);
    await released;
  }
  expire(): Promise<void> {
    return this.holder && !this.permits(this.holder, this.revision) ? this.revoke() : this.barrier;
  }
  revoke(): Promise<void> {
    const previous = this.holder ? this.participants.get(this.holder) : undefined;
    this.holder = undefined;
    this.pending = undefined;
    this.expires = 0;
    this.revision++;
    previous?.changed(this.revision, false);
    if (previous) this.cleanup.add(previous);
    this.barrier = this.barrier.catch(() => {}).then(async () => {
      for (const participant of [...this.cleanup]) {
        await participant.release();
        this.cleanup.delete(participant);
      }
    });
    return this.barrier;
  }
}
