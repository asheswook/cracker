import { z } from 'zod';
export const FooterAction = z.enum(['latest', 'retry-upload', 'remove-draft', 'retry-storage', 'task-details']);
export type FooterActionName = z.infer<typeof FooterAction>;
export const FooterProps = z.object({
  scheme: z.enum(['light', 'dark']), readOnly: z.boolean(), latest: z.boolean(), error: z.string().max(8192),
  storage: z.object({ failed: z.boolean(), retrying: z.boolean() }).strict(),
  task: z.object({ id: z.uuid(), state: z.enum(['failed', 'unknown']), reason: z.string().max(2000).nullable(), reasonTruncated: z.boolean() }).strict().nullable(),
  drafts: z.array(z.object({ id: z.uuid(), name: z.string().max(4096), status: z.enum(['ready', 'uploading', 'stored']),
    progress: z.number().finite().min(0).max(100).nullable(), error: z.string().max(8192), canRetry: z.boolean(), canRemove: z.boolean() }).strict()).max(8),
}).strict();
export type FooterPropsValue = z.infer<typeof FooterProps>;
export const FooterState = z.object({ v: z.literal(1), kind: z.literal('state'), document: z.uuid(), scope: z.string().max(512),
  generation: z.number().int().positive(), visible: z.boolean(), props: FooterProps }).strict();
export type FooterStateValue = z.infer<typeof FooterState>;
export const FooterRender = FooterState.extend({ footerDocument: z.uuid() });
export type FooterRenderValue = z.infer<typeof FooterRender>;
const base = { v: z.literal(1), document: z.uuid(), footerDocument: z.uuid(), scope: z.string().max(512),
  generation: z.number().int().positive(), revision: z.number().int().positive() };
export const FooterEvent = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('activate') }).strict(),
  z.object({ ...base, kind: z.literal('fallback'), reason: z.string().max(128).optional() }).strict(),
  z.object({ ...base, kind: z.literal('action'), commandId: z.uuid(), action: FooterAction, draftId: z.uuid().optional() }).strict(),
]);
export type FooterEventValue = z.infer<typeof FooterEvent>;
export type FooterReply = Readonly<{ ok: boolean; error?: string }>;
export function footerPacketFits(packet: object) { return new TextEncoder().encode(JSON.stringify(packet)).length <= 262144; }
export class FooterBodySession {
  readonly document = crypto.randomUUID();
  state: FooterStateValue | undefined;
  footerDocument: string | undefined;
  private signature = '';
  private revision = 0;
  private lastEvent = '';
  get acceptedRevision() { return this.revision; }
  private commands = new Map<string, { signature: string; reply: Promise<FooterReply>; settled: boolean }>();
  constructor(private readonly action: (action: FooterActionName, draftId?: string) => Promise<FooterReply>) {}
  update(value: Readonly<{ scope: string; visible: boolean; props: FooterPropsValue }>) {
    const signature = JSON.stringify(value);
    if (signature === this.signature) return undefined;
    const state = FooterState.parse({ ...value, v: 1, kind: 'state', document: this.document, generation: (this.state?.generation ?? 0) + 1 });
    if (!footerPacketFits(state)) throw new RangeError('footer_packet_size');
    if (state.scope !== this.state?.scope) this.footerDocument = undefined;
    this.state = state; this.signature = signature; return state;
  }
  handle(input: unknown): Promise<FooterReply> {
    const parsed = FooterEvent.safeParse(input), state = this.state;
    if (!parsed.success || !state) return Promise.resolve({ ok: false, error: 'invalid_event' });
    const event = parsed.data;
    if (event.document !== this.document || event.scope !== state.scope || event.generation !== state.generation)
      return Promise.resolve({ ok: false, error: 'stale_event' });
    const eventSignature = JSON.stringify(event);
    if (event.revision < this.revision || (event.revision === this.revision && eventSignature !== this.lastEvent))
      return Promise.resolve({ ok: false, error: 'stale_revision' });
    this.revision = event.revision; this.lastEvent = eventSignature;
    if (event.kind === 'activate') {
      if (!state.visible) return Promise.resolve({ ok: false, error: 'hidden' });
      this.footerDocument = event.footerDocument; return Promise.resolve({ ok: true });
    }
    if (this.footerDocument && this.footerDocument !== event.footerDocument) return Promise.resolve({ ok: false, error: 'stale_footer' });
    if (event.kind === 'fallback') { this.footerDocument = undefined; return Promise.resolve({ ok: true }); }
    if (!state.visible || !this.footerDocument) return Promise.resolve({ ok: false, error: 'inactive_footer' });
    const signature = JSON.stringify([event.document, event.footerDocument, event.scope, event.generation, event.action, event.draftId]);
    const prior = this.commands.get(event.commandId);
    if (prior) return prior.signature === signature ? prior.reply : Promise.resolve({ ok: false, error: 'command_mismatch' });
    const draft = state.props.drafts.find(item => item.id === event.draftId);
    const permitted = event.action === 'latest' ? state.props.latest : event.action === 'task-details' ? Boolean(state.props.task?.reasonTruncated)
      : event.action === 'retry-storage' ? state.props.storage.failed && !state.props.storage.retrying
        : event.action === 'retry-upload' ? draft?.canRetry : draft?.canRemove;
    if (!permitted || (state.props.readOnly && event.action !== 'latest')) return Promise.resolve({ ok: false, error: 'action_unavailable' });
    if (this.commands.size >= 256) {
      const oldest = [...this.commands].find(([, entry]) => entry.settled)?.[0];
      if (oldest) this.commands.delete(oldest); else return Promise.resolve({ ok: false, error: 'command_capacity' });
    }
    const entry = { signature, settled: false, reply: Promise.resolve<FooterReply>({ ok: false, error: 'action_pending' }) };
    entry.reply = Promise.resolve().then(() => {
      if (this.state !== state || this.footerDocument !== event.footerDocument || !this.state.visible) return { ok: false, error: 'stale_event' };
      return this.action(event.action, event.draftId);
    }).catch((): FooterReply => ({ ok: false, error: 'action_failed' }))
      .then(reply => { entry.settled = true; return reply; });
    this.commands.set(event.commandId, entry); return entry.reply;
  }
}
export class FooterRenderSession {
  state: FooterRenderValue | undefined;
  private retired = new Set<string>();
  constructor(readonly document: string) {}
  receive(input: unknown): { ok: true; value: FooterRenderValue } | { ok: false; error: string } {
    const parsed = FooterRender.safeParse(input);
    if (!parsed.success || parsed.data.footerDocument !== this.document || !footerPacketFits(parsed.data)) return { ok: false, error: 'invalid_footer_state' };
    const next = parsed.data, old = this.state;
    if (this.retired.has(next.document)) return { ok: false, error: 'retired_document' };
    if (old?.document === next.document && (next.generation < old.generation || (next.generation === old.generation && JSON.stringify(next) !== JSON.stringify(old))))
      return { ok: false, error: 'stale_footer_state' };
    if (old && old.document !== next.document) { this.retired.add(old.document); const first = this.retired.values().next().value; if (this.retired.size > 8 && first) this.retired.delete(first); }
    this.state = next; return { ok: true, value: next };
  }
}

export function benignFooterRejection(error: string | undefined) {
  return ['stale_event', 'stale_geometry', 'stale_revision', 'stale_footer_state', 'stale_footer', 'reader_busy', 'action_unavailable', 'inactive_footer', 'action_pending', 'command_mismatch', 'action_failed'].includes(error ?? '');
}

export function footerTaskSummary(task: Readonly<{ id: string; state: string; reason: string | null }> | undefined): FooterPropsValue['task'] {
  if (!task || (task.state !== 'failed' && task.state !== 'unknown')) return null;
  return { id: task.id, state: task.state, reason: task.reason?.slice(0, 2000) ?? null, reasonTruncated: (task.reason?.length ?? 0) > 2000 };
}
