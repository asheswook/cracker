import { z } from 'zod';
import type { MessageReply } from './types';

export const COMPOSER_TEXT_LIMIT = 100_000;
const documentID = crypto.randomUUID();
let generation = 0;
const sentCommands = new Map<string, Promise<ComposerResponse>>();
const attachmentCommands = new Set<string>();
export type NativeComposerState = Readonly<{
  version: 1; document: string; session: string; scope: string; generation: number;
  text: string; revision: string; ack: number; visible: boolean; editable: boolean;
  sendEnabled: boolean; attachEnabled: boolean; placeholder: string; error: string;
  theme: Readonly<{ canvas: string; surface: string; ink: string; muted: string; accent: string }>;
  focus?: number;
}>;
const base = { version: z.literal(1), document: z.uuid(), session: z.uuid(), scope: z.string().max(512) };
const edit = {
  seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), text: z.string().max(COMPOSER_TEXT_LIMIT * 2),
  selection: z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() }),
  composing: z.boolean(),
};
export const ComposerCommand = z.discriminatedUnion('kind', [
  z.object({ ...base, ...edit, kind: z.literal('edit') }),
  z.object({ ...base, ...edit, kind: z.literal('send'), commandId: z.uuid() }),
  z.object({ ...base, kind: z.literal('attach'), commandId: z.uuid() }),
]);
export type ComposerResponse = Readonly<{ accepted: boolean; ack: number; state?: NativeComposerState; error?: string }>;
export type ComposerDraft = Readonly<{ text: string; version: string; error: string; reply?: MessageReply | null }>;
export type ComposerBinding = Readonly<{
  scope: string; read: () => ComposerDraft; write: (text: string) => ComposerDraft;
  state: () => Omit<NativeComposerState, 'version' | 'document' | 'session' | 'scope' | 'generation' | 'text' | 'revision' | 'ack'>;
  send: (draft: ComposerDraft) => Promise<boolean>; attach: () => void;
}>;
type Session = { id: string; binding: ComposerBinding; ack: number; composing: boolean; lastText: string };

/** Owns document/session ordering; persistence and outbox remain canonical web responsibilities. */
export class NativeComposerController {
  readonly document = documentID;
  private sessions = new Map<string, Session>();
  private current: Session | undefined;
  private active = true;
  private pending = new Set<string>();
  constructor(private readonly publish: (state: NativeComposerState) => void) {}
  identity() { return this.current && this.active ? { document: this.document, session: this.current.id } : undefined; }
  activate() { this.active = true; if (this.current) this.sessions.set(this.current.id, this.current); }
  deactivate() { this.active = false; this.sessions.clear(); }
  bind(binding: ComposerBinding) {
    if (this.current?.binding.scope === binding.scope) this.current.binding = binding;
    else {
      this.current = { id: crypto.randomUUID(), binding, ack: 0, composing: false, lastText: binding.read().text };
      this.sessions.set(this.current.id, this.current);
      const oldest = this.sessions.keys().next().value;
      if (this.sessions.size > 8 && oldest) this.sessions.delete(oldest);
    }
    return this.snapshot();
  }
  snapshot(): NativeComposerState | undefined {
    const session = this.current;
    if (!session || !this.active) return undefined;
    const draft = session.binding.read();
    if (draft.text !== session.lastText) {
      session.lastText = draft.text;
      session.composing = false;
    }
    const state = session.binding.state();
    return { ...state, version: 1, document: this.document, session: session.id, scope: session.binding.scope,
      generation: ++generation, text: draft.text, revision: draft.version, ack: session.ack,
      sendEnabled: state.sendEnabled && !session.composing && !this.pending.has(session.binding.scope) && draft.text.length <= COMPOSER_TEXT_LIMIT,
      error: draft.text.length > COMPOSER_TEXT_LIMIT ? '메시지는 100,000자까지 보낼 수 있어요.' : draft.error || state.error };
  }
  private reply(accepted: boolean, error?: string, acknowledged?: number): ComposerResponse {
    const state = this.snapshot();
    if (state) this.publish(state);
    return { accepted, ack: acknowledged ?? (accepted ? state?.ack ?? 0 : 0), ...(state ? { state } : {}), ...(error ? { error } : {}) };
  }
  handle = (input: unknown): ComposerResponse | Promise<ComposerResponse> => {
    if (!this.active) return { accepted: false, ack: 0, error: 'expired_session' };
    const parsed = ComposerCommand.safeParse(input);
    if (!parsed.success || parsed.data.document !== this.document) return this.reply(false, 'invalid_command');
    const command = parsed.data;
    const session = this.sessions.get(command.session);
    if (!session || session.binding.scope !== command.scope) return this.reply(false, 'expired_session');
    if (session !== this.current && session.binding.scope === this.current?.binding.scope) return this.reply(false, 'expired_session');
    if (command.kind !== 'edit' && session !== this.current) return this.reply(false, 'inactive_scope');
    if (command.kind === 'send') {
      const existing = sentCommands.get(command.commandId);
      if (existing) return existing;
    }
    if (command.kind === 'attach') {
      if (!session.binding.state().visible || !session.binding.state().attachEnabled) return this.reply(false, 'unavailable');
      if (!attachmentCommands.has(command.commandId)) {
        attachmentCommands.add(command.commandId);
        session.binding.attach();
      }
      return this.reply(true);
    }
    if (command.selection.start > command.selection.end || command.selection.end > command.text.length)
      return this.reply(false, 'invalid_selection');
    if (command.seq < session.ack || (command.seq === session.ack && (command.text !== session.lastText || command.composing !== session.composing)))
      return this.reply(false, 'stale_edit');
    if (command.seq > session.ack) {
      session.ack = command.seq;
      session.lastText = command.text;
      session.composing = command.composing;
      if (session.binding.read().text !== command.text) session.binding.write(command.text);
    }
    if (command.kind === 'edit') {
      if (session !== this.current) return { accepted: true, ack: session.ack };
      return this.reply(true);
    }
    const state = session.binding.state();
    if (command.composing || session.composing) return this.reply(false, 'composing');
    if (!state.visible || !state.editable || !state.sendEnabled || this.pending.has(command.scope)) return this.reply(false, 'unavailable');
    if (command.text.length > COMPOSER_TEXT_LIMIT) return this.reply(false, 'text_limit');
    const draft = session.binding.read();
    if (draft.text !== command.text) return this.reply(false, 'stale_draft');
    this.pending.add(command.scope);
    const result = session.binding.send(draft).then(
      accepted => this.reply(accepted, accepted ? undefined : 'send_failed', session.ack),
      () => this.reply(false, 'send_failed', session.ack),
    ).finally(() => { this.pending.delete(command.scope); this.reply(true); });
    sentCommands.set(command.commandId, result);
    return result;
  };
}
