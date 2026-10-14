import { z } from 'zod';
import { AssistantAppearance } from './appearance/types';
export const HeaderAction = z.enum(['menu', 'settings', 'computer', 'time-toggle', 'archive-return']);
export type HeaderActionName = z.infer<typeof HeaderAction>;
export const HeaderProps = z.object({
  name: z.string().max(80), archiveTitle: z.string().max(200).nullable(), connected: z.boolean(), presence: z.enum(['online', 'computer-offline', 'offline']).optional(),
  computerOpen: z.boolean(), working: z.boolean(), activity: z.enum(['thinking', 'computer', 'typing']).optional(), appearance: AssistantAppearance,
  scheme: z.enum(['light', 'dark']), time: z.object({ available: z.boolean(), pinned: z.boolean() }).strict(),
}).strict();
export type HeaderPropsValue = z.infer<typeof HeaderProps>;
export const HeaderState = z.object({
  v: z.literal(1), kind: z.literal('state'), document: z.uuid(), generation: z.number().int().positive(),
  scope: z.string().max(512), visible: z.boolean(), props: HeaderProps,
}).strict();
export type HeaderStateValue = z.infer<typeof HeaderState>;
export const HeaderRender = HeaderState.extend({ headerDocument: z.uuid() });
export type HeaderRenderValue = z.infer<typeof HeaderRender>;
const eventBase = { v: z.literal(1), document: z.uuid(), headerDocument: z.uuid(),
  generation: z.number().int().positive(), scope: z.string().max(512) };
export const HeaderEvent = z.discriminatedUnion('kind', [
  z.object({ ...eventBase, kind: z.literal('activate') }).strict(),
  z.object({ ...eventBase, kind: z.literal('fallback'), reason: z.string().max(128).optional() }).strict(),
  z.object({ ...eventBase, kind: z.literal('action'), commandId: z.uuid(), action: HeaderAction }).strict(),
]);
export type HeaderReply = Readonly<{ ok: boolean; error?: string }>;
export class HeaderBodySession {
  readonly document = crypto.randomUUID();
  state: HeaderStateValue | undefined;
  headerDocument: string | undefined;
  private signature = '';
  private generation = 0;
  private actionGenerationFloor = 0;
  private commands = new Map<string, HeaderReply>();
  constructor(private readonly actions: (action: HeaderActionName) => boolean) {}
  update(value: Readonly<{ scope: string; visible: boolean; props: HeaderPropsValue }>) {
    const signature = JSON.stringify(value);
    if (signature === this.signature) return undefined;
    const state = HeaderState.parse({ ...value, v: 1, kind: 'state', document: this.document, generation: ++this.generation });
    if (!this.state || this.state.scope !== state.scope || this.state.visible !== state.visible) this.actionGenerationFloor = state.generation;
    if (this.state && this.state.scope !== state.scope) this.headerDocument = undefined;
    this.signature = signature;
    this.state = state;
    return state;
  }
  handle(input: unknown): HeaderReply {
    const parsed = HeaderEvent.safeParse(input);
    const state = this.state;
    if (!parsed.success || !state) return { ok: false, error: 'invalid_event' };
    const event = parsed.data;
    const minimumGeneration = event.kind === 'action' ? this.actionGenerationFloor : state.generation;
    if (event.document !== this.document || event.scope !== state.scope
      || event.generation < minimumGeneration || event.generation > state.generation)
      return { ok: false, error: 'stale_event' };
    if (event.kind === 'activate') {
      if (!state.visible) return { ok: false, error: 'hidden' };
      if (this.headerDocument !== event.headerDocument) this.actionGenerationFloor = state.generation;
      this.headerDocument = event.headerDocument;
      return { ok: true };
    }
    if (this.headerDocument && this.headerDocument !== event.headerDocument) return { ok: false, error: 'stale_header' };
    if (event.kind === 'fallback') { this.headerDocument = undefined; return { ok: true }; }
    if (!state.visible || !this.headerDocument) return { ok: false, error: 'inactive_header' };
    const prior = this.commands.get(event.commandId);
    if (prior) return prior;
    if (event.action === 'archive-return' && state.props.archiveTitle === null) return { ok: false, error: 'archive_unavailable' };
    if (event.action === 'time-toggle' && !state.props.time.available) return { ok: false, error: 'time_unavailable' };
    this.commands.set(event.commandId, { ok: false, error: 'action_pending' });
    const oldest = this.commands.keys().next().value;
    if (this.commands.size > 256 && oldest) this.commands.delete(oldest);
    let reply: HeaderReply;
    try { reply = this.actions(event.action) ? { ok: true } : { ok: false, error: 'action_unavailable' }; }
    catch { reply = { ok: false, error: 'action_failed' }; }
    this.commands.set(event.commandId, reply);
    return reply;
  }
}

export class HeaderRenderSession {
  state: HeaderRenderValue | undefined;
  private retired = new Set<string>();
  constructor(readonly document: string) {}
  receive(input: unknown): { ok: true; value: HeaderRenderValue } | { ok: false; error: string } {
    const parsed = HeaderRender.safeParse(input);
    if (!parsed.success || parsed.data.headerDocument !== this.document) return { ok: false, error: 'invalid_header_state' };
    const next = parsed.data;
    const previous = this.state;
    if (this.retired.has(next.document)) return { ok: false, error: 'retired_document' };
    if (previous?.document === next.document && (next.generation < previous.generation
      || (next.generation === previous.generation && JSON.stringify(next) !== JSON.stringify(previous))))
      return { ok: false, error: 'stale_header_state' };
    if (previous && previous.document !== next.document) {
      this.retired.add(previous.document);
      const oldest = this.retired.values().next().value;
      if (this.retired.size > 8 && oldest) this.retired.delete(oldest);
    }
    this.state = next;
    return { ok: true, value: next };
  }
}
