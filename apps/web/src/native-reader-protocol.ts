import { z } from 'zod';
export const ReaderMode = z.enum(['follow', 'reading', 'source']);
export type ReaderModeValue = z.infer<typeof ReaderMode>;
export const ReaderSnapshot = z.object({
  v: z.literal(1), document: z.uuid(), scope: z.string().max(512), navigation: z.number().int().positive(),
  revision: z.number().int().positive(), sequence: z.number().int().nonnegative(), interaction: z.number().int().nonnegative(), geometry: z.number().int().nonnegative(), mode: ReaderMode,
  offset: z.number().finite(), contentHeight: z.number().finite().nonnegative(), width: z.number().finite().positive(),
  height: z.number().finite().positive(), headerHeight: z.number().finite().nonnegative(),
  bottomInset: z.number().finite().nonnegative().optional(),
  keyboardMoving: z.boolean(), suspended: z.boolean(), dragging: z.boolean(),
}).strict();
export type ReaderSnapshotValue = z.infer<typeof ReaderSnapshot>;
export const ReaderReply = z.object({ ok: z.boolean(), error: z.string().optional(), snapshot: ReaderSnapshot.optional() });
export type ReaderReplyValue = z.infer<typeof ReaderReply>;
export type ReaderPacket = Readonly<{
  v: 1; document: string; scope: string; navigation: number; sequence: number;
}> & (
  | Readonly<{ kind: 'bind'; mode: ReaderModeValue; suspended: boolean; interaction?: number }>
  | Readonly<{ kind: 'layout'; interaction: number; geometry: number; width: number; height: number; contentHeight: number; mode: ReaderModeValue; offset?: number }>
  | Readonly<{ kind: 'move'; interaction: number; geometry: number; mode: ReaderModeValue; offset?: number }>
  | Readonly<{ kind: 'release' }>
);
export type ReaderCommand = ReaderPacket extends infer Packet ? Packet extends ReaderPacket
  ? Omit<Packet, 'v' | 'document' | 'scope' | 'navigation' | 'sequence'> : never : never;
export class ReaderSession {
  document = crypto.randomUUID();
  scope = '';
  navigation = 0;
  snapshot: ReaderSnapshotValue | undefined;
  active = false;
  private key = '';
  private sequence = 0;
  private acceptedSequence = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;
  constructor(private readonly transport: (packet: ReaderPacket) => Promise<ReaderReplyValue>,
    private readonly changed: (snapshot: ReaderSnapshotValue, external: boolean) => void) {}
  receive(input: unknown, external = true): boolean {
    const parsed = ReaderSnapshot.safeParse(input);
    if (!parsed.success || this.disposed) return false;
    const next = parsed.data, old = this.snapshot;
    if (next.document !== this.document || next.scope !== this.scope || next.navigation !== this.navigation) return false;
    if (old && (next.interaction < old.interaction || next.geometry < old.geometry || (next.interaction === old.interaction && next.sequence < this.acceptedSequence))) return false;
    if (old && (next.revision < old.revision || (next.revision === old.revision && JSON.stringify(next) !== JSON.stringify(old)))) return false;
    this.acceptedSequence = Math.max(this.acceptedSequence, next.sequence);
    this.snapshot = next;
    if (JSON.stringify(next) !== JSON.stringify(old)) this.changed(next, external);
    return true;
  }
  bind(binding: Readonly<{ key: string; scope: string; mode: ReaderModeValue; suspended: boolean }>): Promise<ReaderReplyValue> {
    const fresh = binding.key !== this.key;
    const interaction = this.snapshot?.interaction;
    if (fresh) {
      this.key = binding.key; this.scope = binding.scope; this.navigation++;
      this.snapshot = undefined; this.active = false; this.acceptedSequence = 0;
    } else if (this.snapshot?.suspended === binding.suspended) return Promise.resolve({ ok: true, snapshot: this.snapshot });
    return this.send({ kind: 'bind', mode: fresh ? binding.mode : this.snapshot?.mode ?? binding.mode,
      suspended: binding.suspended, ...(interaction !== undefined ? { interaction } : {}) }).then(reply => {
      if (reply.ok && reply.snapshot && reply.snapshot.navigation === this.navigation) this.active = true;
      return reply;
    });
  }
  send(command: ReaderCommand, current: () => boolean = () => true): Promise<ReaderReplyValue> {
    const navigation = this.navigation, scope = this.scope;
    const operation = this.queue.then(async () => {
      if (!current()) return { ok: false, error: 'cancelled_intent' };
      if (this.disposed || navigation !== this.navigation || scope !== this.scope) return { ok: false, error: 'stale_navigation' };
      if ('interaction' in command && command.interaction !== undefined && this.snapshot && command.interaction !== this.snapshot.interaction)
        return { ok: false, error: 'stale_interaction', snapshot: this.snapshot };
      if ('geometry' in command && this.snapshot && command.geometry !== this.snapshot.geometry)
        return { ok: false, error: 'stale_geometry', snapshot: this.snapshot };
      const packet: ReaderPacket = { ...command, v: 1, document: this.document, scope, navigation, sequence: ++this.sequence };
      const reply = await this.transport(packet);
      if (navigation !== this.navigation || this.disposed) return { ok: false, error: 'stale_navigation' };
      if (reply.snapshot) this.receive(reply.snapshot, false);
      return reply;
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
  release() {
    if (this.disposed || !this.scope) return;
    const packet: ReaderPacket = { v: 1, document: this.document, scope: this.scope, navigation: this.navigation || 1,
      sequence: ++this.sequence, kind: 'release' };
    this.document = crypto.randomUUID();
    this.key = ''; this.scope = ''; this.navigation++; this.snapshot = undefined; this.active = false; this.acceptedSequence = 0;
    void this.transport(packet).catch(() => undefined);
  }
  dispose() { if (!this.disposed) { this.release(); this.disposed = true; } }
}
