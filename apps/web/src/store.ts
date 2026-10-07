import { HTTPError } from 'ky';
import { useSyncExternalStore } from 'react';
import { z } from 'zod';
import { http, read, errorMessage } from './api';
import { Conversation, Id, Message, MessagePage, Pending, Persona, Resources, Session } from './types';
import { confirmControl, controlTransport, ControlFailure } from './controlReceipt';
import type { ControlKind, ControlReceipt } from './controlReceipt';
import type { Task, Vm, Schedule, Memory, Artifact,ReplyComposing, ReplyHandoff, AssistantWorking } from './types';
import { AppearanceSettings, defaultAppearance, type AssistantAppearance } from './appearance/types';
import { Instructions } from './settings/types';
import { clearStartupCache, readStartupCache, writeStartupCache } from './startup-cache';
type Snapshot = Readonly<{
  phase: 'loading' | 'login' | 'ready';
  workspace: Id | null;
  selected: Id | null;
  assistantId: Id | null;
  persona: Persona;
  appearance: AssistantAppearance;
  appearanceRevision: string | null;
  conversations: Conversation[];
  tasks: Task[];
  vms: Vm[];
  schedules: Schedule[];
  memories: Memory[];
  messages: Message[];
  syncedCursor: number | null;
  composing:ReplyComposing|null;
  replyHandoff: ReplyHandoff | null | undefined;
  working: AssistantWorking | null;
  outbox: Pending[];
  error: string;
  connected: boolean;
  control: Readonly<Record<string, ControlReceipt>>;
}>;
const initial: Snapshot = {
  phase: 'loading',
  workspace: null,
  selected: null,
  assistantId: null,
  persona: { name: 'Assistant', role: '', style: '' },
  appearance: defaultAppearance,
  appearanceRevision: null,
  conversations: [],
  tasks: [],
  vms: [],
  schedules: [],
  memories: [],
  messages: [],
  syncedCursor: null,
  composing:null,
  replyHandoff: undefined,
  working: null,
  outbox: [],
  error: '',
  connected: false,
  control: {},
};
function stable<T>(before: T, after: T): T {
  return JSON.stringify(before) === JSON.stringify(after) ? before : after;
}
export class ClientStore {
  private value: Snapshot = initial;
  private listeners = new Set<() => void>();
  private polling = false;
  private epoch = 0;
  private vmRevision = 0;
  private personaRevision = 0;
  private appearanceReadRevision = 0;
  private controls = new Map<Id, AbortController>();
  private activeSends = new Set<Id>();
  private cursors = new Map<Id, number>();
  private histories = new Map<Id, Message[]>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private messageTimer: ReturnType<typeof setInterval> | null = null;
  private handoffTimer: ReturnType<typeof setTimeout> | null = null;
  private cacheTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionRetry: ReturnType<typeof setTimeout> | null = null;
  private sessionRequest: Promise<void> | null = null;
  private sessionAttempts = 0;
  private syncs = new Map<Id, Promise<void>>();
  private selectionRevision = 0;
  private replyRevision = 0;
  snapshot = () => this.value;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  private patch(next: Partial<Snapshot>) {
    if (Object.entries(next).every(([key, value]) => Reflect.get(this.value, key) === value)) return;
    this.value = { ...this.value, ...next };
    if (this.value.connected && ['connected', 'persona', 'appearance', 'appearanceRevision', 'conversations', 'messages', 'assistantId'].some(key => key in next)) {
      if (this.cacheTimer) clearTimeout(this.cacheTimer);
      this.cacheTimer = setTimeout(() => {
        this.cacheTimer = null;
        const { workspace, assistantId, persona, appearance, appearanceRevision, conversations } = this.value;
        if (workspace && assistantId) writeStartupCache({ workspace, assistantId, persona, appearance, appearanceRevision, conversations, messages: this.histories.get(assistantId) ?? [] });
      }, 200);
    }
    if ('replyHandoff' in next) {
      if (this.handoffTimer) clearTimeout(this.handoffTimer);
      const handoff = next.replyHandoff;
      this.handoffTimer = handoff ? setTimeout(() => {
        if (this.value.replyHandoff === handoff) this.patch({ replyHandoff: null });
      }, Math.max(0, Date.parse(handoff.expires_at) - Date.now())) : null;
    }
    for (const notify of this.listeners) notify();
  }
  private key() {
    return `assistant:outbox:${this.value.workspace}`;
  }
  private persist() {
    localStorage.setItem(this.key(), JSON.stringify(this.value.outbox));
  }
  private restore() {
    const result = Pending.array().safeParse(JSON.parse(localStorage.getItem(this.key()) ?? '[]'));
    if (result.success)
      this.patch({
        outbox: result.data.map((m) => ({ ...m, state: m.state === 'sending' ? 'failed' : m.state })),
      });
  }
  init(): Promise<void> {
    if (this.value.phase === 'ready') return this.refresh();
    if (this.sessionRequest) return this.sessionRequest;
    if (this.sessionRetry) clearTimeout(this.sessionRetry);
    this.sessionRetry = null;
    const request = this.restoreSession(this.epoch);
    this.sessionRequest = request;
    void request.finally(() => { if (this.sessionRequest === request) this.sessionRequest = null; });
    return request;
  }
  private async restoreSession(epoch: number) {
    try {
      const session = await read('/v1/session', Session);
      if (epoch !== this.epoch) return;
      this.sessionAttempts = 0;
      await this.establish(session);
    } catch (e) {
      if (epoch !== this.epoch) return;
      if (e instanceof HTTPError && (e.response.status === 401 || e.response.status === 403)) {
        this.clearSession();
        return;
      }
      this.patch({ phase: 'loading', connected: false, working: null, error: errorMessage(e) });
      const delay = Math.min(15_000, 1000 * 2 ** Math.min(this.sessionAttempts++, 4));
      this.sessionRetry = setTimeout(() => { this.sessionRetry = null; void this.init(); }, delay);
    }
  }
  reconnect() {
    if (this.value.phase === 'loading') void this.init();
    else if (this.value.phase === 'ready') void this.refresh();
  }
  private async establish(session: z.infer<typeof Session>) {
    this.cancelControls();
    if (this.timer) clearInterval(this.timer);
    if (this.messageTimer) clearInterval(this.messageTimer);
    this.epoch++;
    this.syncs.clear();
    this.histories.clear();
    this.cursors.clear();
    this.patch({ ...initial, phase: 'ready', workspace: session.workspace_id });
    const cached = readStartupCache(session.workspace_id);
    if (cached) {
      this.histories.set(cached.assistantId, cached.messages);
      this.patch({ assistantId: cached.assistantId, selected: cached.assistantId, persona: cached.persona,
        appearance: cached.appearance, appearanceRevision: cached.appearanceRevision, conversations: cached.conversations, messages: cached.messages });
    }
    try {
      this.restore();
    } catch (e) {
      if (e instanceof Error) this.patch({ error: '기기에 저장된 전송 목록을 읽지 못했어요.' });
    }
    const epoch = this.epoch;
    await this.refresh();
    if (epoch !== this.epoch) return;
    this.timer = setInterval(() => void this.refresh(), 3000);
    this.messageTimer = setInterval(() => void this.refreshActiveMessages(), 500);
  }
  async login(token: string) {
    this.epoch++;
    if (this.sessionRetry) clearTimeout(this.sessionRetry);
    this.sessionRetry = null;
    this.sessionRequest = null;
    const epoch = this.epoch;
    const session = Session.parse(await http.post('/v1/session', { json: { token } }).json<unknown>());
    if (epoch !== this.epoch) return;
    await this.establish(session);
  }
  private clearSession() {
    this.cancelControls();
    if (this.cacheTimer) clearTimeout(this.cacheTimer);
    this.cacheTimer = null;
    if (this.value.workspace) clearStartupCache(this.value.workspace);
    this.epoch++;
    if (this.sessionRetry) clearTimeout(this.sessionRetry);
    this.sessionRetry = null;
    this.sessionRequest = null;
    this.sessionAttempts = 0;
    if (this.timer) clearInterval(this.timer);
    if (this.messageTimer) clearInterval(this.messageTimer);
    this.timer = null;
    this.messageTimer = null;
    this.syncs.clear();
    this.cursors.clear();
    this.histories.clear();
    this.patch({ ...initial, phase: 'login' });
  }
  async logout() {
    this.cancelControls();
    try {
      await http.delete('/v1/session');
    } catch (e) {
      if (!(e instanceof HTTPError && e.response.status === 401)) throw e;
    }
    this.clearSession();
  }
  async refresh() {
    if (this.polling || this.value.phase !== 'ready') return;
    this.polling = true;
    const epoch = this.epoch;
    const vmRevision = this.vmRevision;
    const personaRevision = this.personaRevision;
    const appearanceReadRevision = this.appearanceReadRevision;
    try {
      const boot = this.value.syncedCursor === null;
      let bootConversation: Id | null = null;
      let publishBootSignals: (() => void) | undefined;
      const primary = (async () => {
      if (!this.value.assistantId) {
        const result = z
          .object({ conversation: Conversation })
          .parse(await http.post('/v1/assistant/conversation').json<unknown>());
        if (epoch !== this.epoch) return;
        this.patch({ assistantId: result.conversation.id, selected: result.conversation.id });
      }
      if (boot && epoch === this.epoch && this.value.selected) {
        bootConversation = this.value.selected;
        await this.sync(bootConversation, publish => { publishBootSignals = publish; });
      }
      })();
      const [c, t, v, s, m, settings, appearance] = await Promise.all([
        read('/v1/conversations', Resources.conversations).then(value => {
          if (epoch === this.epoch) this.patch({ conversations: stable(this.value.conversations, value.conversations) });
          return value;
        }),
        read('/v1/tasks', Resources.tasks),
        read('/v1/vms', Resources.vms),
        read('/v1/schedules', Resources.schedules),
        read('/v1/memory', Resources.memories),
        read('/v1/settings', z.object({ persona: Persona })).then(value => {
          if (epoch === this.epoch && personaRevision === this.personaRevision) this.patch({ persona: stable(this.value.persona, value.persona) });
          return value;
        }),
        read('/v1/appearance', AppearanceSettings).then(value => {
          if (epoch === this.epoch && appearanceReadRevision === this.appearanceReadRevision)
            this.patch({ appearance: stable(this.value.appearance, value.appearance), appearanceRevision: value.revision });
          return value;
        }),
        primary,
      ]);
      if (epoch !== this.epoch) return;
      const next = {
        conversations: stable(this.value.conversations, c.conversations),
        tasks: stable(this.value.tasks, t.tasks),
        vms: vmRevision === this.vmRevision ? stable(this.value.vms, v.vms) : this.value.vms,
        schedules: stable(this.value.schedules, s.schedules),
        memories: stable(this.value.memories, m.memories),
        persona:
          personaRevision === this.personaRevision
            ? stable(this.value.persona, settings.persona)
            : this.value.persona,
        appearance: appearanceReadRevision === this.appearanceReadRevision
          ? stable(this.value.appearance, appearance.appearance) : this.value.appearance,
        appearanceRevision: appearanceReadRevision === this.appearanceReadRevision
          ? appearance.revision : this.value.appearanceRevision,
        connected: true,
        error: '',
      };
      if (Object.entries(next).some(([k, v]) => Reflect.get(this.value, k) !== v)) this.patch(next);
      if (publishBootSignals && bootConversation === this.value.selected) publishBootSignals();
      else if (this.value.selected) await this.sync(this.value.selected);
    } catch (e) {
      if (epoch === this.epoch) {
        if (e instanceof HTTPError && e.response.status === 401) this.clearSession();
        else this.patch({ connected: false, composing:null,replyHandoff: null,working: null,error: errorMessage(e) });
      }
    } finally {
      this.polling = false;
    }
  }
  async select(id: Id, sourceMessageId?: Id) {
    const epoch = this.epoch;
    if (this.value.selected !== id) this.selectionRevision++;
    this.patch({ selected: id, composing:null,replyHandoff: null,working: null,messages: this.histories.get(id) ?? [], syncedCursor: this.cursors.get(id) ?? null });
    try {
      if (sourceMessageId) await this.loadSource(id, sourceMessageId);
      else await this.sync(id);
    } catch (e) {
      if (epoch === this.epoch && this.value.selected === id)
          this.patch({ connected: false, composing:null,replyHandoff: null,working: null,error: errorMessage(e) });
    }
  }
  private async loadSource(conversation: Id, sourceMessageId: Id) {
    const epoch = this.epoch;
    const source = await read(`/v1/sources/${sourceMessageId}`, z.object({ message: Message, conversation_id: Id }));
    if (epoch !== this.epoch) return;
    if (source.conversation_id !== conversation || source.message.conversation_id !== conversation)
      throw new Error('원문의 대화가 일치하지 않아요.');
    const current = this.histories.get(conversation) ?? [];
    const merged = new Map(current.map(message => [message.id, message]));
    merged.set(source.message.id, { ...source.message, read_at: merged.get(source.message.id)?.read_at ?? source.message.read_at });
    const messages = stable(current, [...merged.values()].sort((a, b) => a.sequence - b.sequence));
    this.histories.set(conversation, messages);
    if (this.value.selected === conversation && this.value.messages !== messages) this.patch({ messages });
  }
  async create() {
    const id = this.value.assistantId;
    if (!id) throw new Error('어시스턴트 연결을 확인해 주세요.');
    await this.select(id);
    return id;
  }
  async refreshPersona(signal?: AbortSignal): Promise<Instructions | undefined> {
    const revision = ++this.personaRevision;
    const epoch = this.epoch;
    const settings = Instructions.parse(await http.get('/v1/settings', { signal: signal ?? null }).json<unknown>());
    if (signal?.aborted || epoch !== this.epoch || revision !== this.personaRevision) return;
    this.patch({ persona: stable(this.value.persona, settings.persona) });
    return settings;
  }
  async refreshAppearance(signal?: AbortSignal): Promise<AppearanceSettings | undefined> {
    const revision = ++this.appearanceReadRevision;
    const epoch = this.epoch;
    const settings = AppearanceSettings.parse(await http.get('/v1/appearance', { signal: signal ?? null }).json<unknown>());
    if (signal?.aborted || epoch !== this.epoch || revision !== this.appearanceReadRevision) return;
    this.patch({ appearance: stable(this.value.appearance, settings.appearance), appearanceRevision: settings.revision });
    return settings;
  }
  private async refreshActiveMessages() {
    const id = this.value.selected;
    if (!id || this.value.phase !== 'ready' || (typeof document !== 'undefined' && document.visibilityState === 'hidden') ||
      (!this.value.replyHandoff && !this.value.tasks.some(task => task.conversation_id === id && ['queued', 'running'].includes(task.state)))) return;
    const epoch = this.epoch, selection = this.selectionRevision;
    try {
      await this.sync(id);
    } catch (error) {
      if (epoch !== this.epoch || selection !== this.selectionRevision) return;
      if (error instanceof HTTPError && error.response.status === 401) this.clearSession();
      else this.patch({ connected: false, composing: null, replyHandoff: null, working: null, error: errorMessage(error) });
    }
  }
  private sync(id: Id, onBoot?: (publish: () => void) => void): Promise<void> {
    const existing = this.syncs.get(id);
    if (existing) return existing;
    const request = this.readMessages(id, onBoot).finally(() => {
      if (this.syncs.get(id) === request) this.syncs.delete(id);
    });
    this.syncs.set(id, request);
    return request;
  }
  private async readMessages(id: Id, onBoot?: (publish: () => void) => void) {
    const epoch = this.epoch;
    const selection = this.selectionRevision;
    const replyRevision = this.replyRevision;
    const old = this.histories.get(id) ?? [];
    const receiptIds = old
      .filter((message) => message.role === 'user' && !message.read_at)
      .slice(-100)
      .map((message) => message.id);
    const page = await read(
      `/v1/conversations/${id}/messages?after=${this.cursors.get(id) ?? 0}${receiptIds.length ? `&receipt_ids=${receiptIds.join(',')}` : ''}`,
      MessagePage,
    );
    if (epoch !== this.epoch) return;
    const current = this.histories.get(id) ?? [];
    const merged = new Map(current.map((m) => [m.id, m]));
    for (const message of page.messages) {
      const readAt = merged.get(message.id)?.read_at ?? message.read_at;
      merged.set(message.id, { ...message, read_at: readAt });
    }
    for (const receipt of page.receipts) {
      const message = merged.get(receipt.message_id);
      if (message?.role === 'user' && !message.read_at)
        merged.set(message.id, { ...message, read_at: receipt.read_at });
    }
    const messages = stable(
      current,
      [...merged.values()].sort((a, b) => a.sequence - b.sequence),
    );
    this.histories.set(id, messages);
    const syncedCursor = Math.max(this.cursors.get(id) ?? 0, page.cursor);
    this.cursors.set(id, syncedCursor);
    const confirmed = new Set(messages.map((m) => m.client_message_id));
    const outbox = this.value.outbox.filter((m) => !confirmed.has(m.client_message_id));
    const changedOutbox = outbox.length !== this.value.outbox.length;
    const changedMessages = this.value.selected === id && this.value.messages !== messages;
    const changedCursor = this.value.selected === id && this.value.syncedCursor !== syncedCursor;
    const signals = () => {
    const controlBlocked = this.value.vms[0]?.control_state === 'user' ||
      Object.values(this.value.control).some(receipt => receipt.kind === 'takeover' && receipt.phase === 'pending');
    const replyCurrent = epoch === this.epoch && this.value.connected && this.value.selected === id &&
      selection === this.selectionRevision && replyRevision === this.replyRevision;
    const composing = replyCurrent ? stable(this.value.composing, controlBlocked || (page.composing && Date.parse(page.composing.expires_at) <= Date.now()) ? null : page.composing) : this.value.composing;
    const replyHandoff = replyCurrent
      ? stable(this.value.replyHandoff, controlBlocked || (page.reply_handoff && Date.parse(page.reply_handoff.expires_at) <= Date.now()) ? null : page.reply_handoff)
      : this.value.replyHandoff;
    const working = epoch === this.epoch && this.value.connected && this.value.selected === id && selection === this.selectionRevision
      ? stable(this.value.working, page.working && Date.parse(page.working.expires_at) <= Date.now() ? null : page.working) : this.value.working;
    return { composing, replyHandoff, working };
    };
    onBoot?.(() => { if (epoch === this.epoch) this.patch(signals()); });
    const { composing, replyHandoff, working } = signals();
    if (changedOutbox || changedMessages || changedCursor || composing!==this.value.composing || replyHandoff !== this.value.replyHandoff || working !== this.value.working)
      this.patch({composing, replyHandoff, working, ...(changedOutbox ? { outbox } : {}), ...(changedMessages ? { messages } : {}), ...(changedCursor ? { syncedCursor } : {}) });
    if (changedOutbox) this.persist();
  }
  async send(content: string, attachments: Artifact[] = [], reply?: Pending['reply']) {
    const id = this.value.assistantId;
    if (!id || this.value.selected !== id) throw new Error('어시스턴트 대화로 돌아와 메시지를 보내 주세요.');
    const pending: Pending = {
      client_message_id: Id.parse(crypto.randomUUID()),
      conversation_id: id,
      content: content.trim(),
      ...(reply ? { reply, reply_to_message_id: reply.message_id } : {}),
      attachments,
      created_at: new Date().toISOString(),
      state: 'queued',
    };
    this.patch({ working: null, replyHandoff: null, outbox: [...this.value.outbox, pending] });
    this.persist();
    await this.retry(pending);
  }
  async retry(pending: Pending) {
    if (this.activeSends.has(pending.client_message_id)) return;
    this.activeSends.add(pending.client_message_id);
    const epoch = this.epoch;
    this.patch({
      outbox: this.value.outbox.map((m) =>
        m.client_message_id === pending.client_message_id ? { ...m, state: 'sending' } : m,
      ),
    });
    this.persist();
    try {
      await http.post(`/v1/conversations/${pending.conversation_id}/messages`, {
        json: {
          client_message_id: pending.client_message_id,
          content: pending.content,
          ...(pending.reply_to_message_id ? { reply_to_message_id: pending.reply_to_message_id } : {}),
          attachment_ids: pending.attachments?.map((a) => a.id),
        },
      });
      if (epoch === this.epoch) await this.sync(pending.conversation_id);
    } catch (e) {
      if (epoch === this.epoch) {
        this.patch({
          outbox: this.value.outbox.map((m) =>
            m.client_message_id === pending.client_message_id ? { ...m, state: 'failed' } : m,
          ),
          error: errorMessage(e),
        });
        this.persist();
      }
    } finally {
      this.activeSends.delete(pending.client_message_id);
    }
  }
  private cancelControls() {
    for (const id of this.controls.keys()) this.cancelControl(id);
  }
  cancelControl(id: Id) {
    this.controls.get(id)?.abort();
    this.controls.delete(id);
    const pending = this.value.control[id];
    if (pending?.phase === 'pending')
      this.patch({
        control: {
          ...this.value.control,
          [id]: {
            ...pending,
            phase: 'unknown',
            error: '제어권 확인이 중단됐어요. 상태를 다시 확인해 주세요.',
          },
        },
      });
  }
  async control(id: Id, kind: ControlKind): Promise<boolean> {
    if (this.controls.has(id) || this.value.phase !== 'ready') return false;
    if (kind === 'takeover') {
      this.replyRevision++;
      this.patch({ composing: null, replyHandoff: null });
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]);
    this.controls.set(id, controller);
    const epoch = this.epoch;
    const previous = this.value.control[id];
    const recovering = previous?.phase === 'unknown' && previous.kind === kind;
    const commandId = recovering ? previous.commandId : Id.parse(crypto.randomUUID());
    const current = () => epoch === this.epoch && this.controls.get(id) === controller;
    const update = (phase: ControlReceipt['phase'], error = '') => {
      if (current())
        this.patch({ control: { ...this.value.control, [id]: { kind, commandId, phase, error } } });
    };
    update('pending');
    try {
      if (recovering) {
        try {
          await controlTransport.receipt(commandId, signal);
        } catch (error) {
          signal.throwIfAborted();
          if (error instanceof HTTPError && error.response.status === 404)
            await controlTransport.submit(id, kind, commandId, signal);
          else throw error;
        }
      } else {
        await controlTransport.submit(id, kind, commandId, signal);
      }
      signal.throwIfAborted();
      if (!current()) return false;
      const vms = await confirmControl(id, kind, commandId, signal);
      if (!current() || signal.aborted) return false;
      this.vmRevision++;
      const control = { ...this.value.control };
      delete control[id];
      this.patch({ vms, control });
      return true;
    } catch (error) {
      if (current()) {
        if (error instanceof HTTPError && error.response.status === 401) this.clearSession();
        else if (error instanceof HTTPError && error.response.status === 409) {
          try {
            const vms = await controlTransport.vms(signal);
            if (current() && !signal.aborted) {
              this.vmRevision++;
              this.patch({ vms });
            }
          } catch {
            // The conflict is still explicit when its follow-up status read fails.
          }
          update('failed', '다른 제어권 요청이 처리 중이거나 상태가 바뀌었어요. 잠시 후 다시 요청해 주세요.');
        } else
          update(
            error instanceof ControlFailure ? 'failed' : 'unknown',
            error instanceof ControlFailure
              ? error.message
              : '제어권 적용 결과를 확인하지 못했어요. 자동으로 다시 요청하지 않았어요.',
          );
      }
    } finally {
      if (this.controls.get(id) === controller) this.controls.delete(id);
    }
    return false;
  }
  async action(path: string, body: unknown = {}, method: 'post' | 'delete' = 'post') {
    await http(path, { method, json: body });
    await this.refresh();
  }
}
export const client = new ClientStore();
export function useClient() {
  return useSyncExternalStore(client.subscribe, client.snapshot);
}
