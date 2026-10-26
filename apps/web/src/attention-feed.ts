import { useSyncExternalStore } from 'react';
import { z } from 'zod';
import { read, errorMessage } from './api';

export const Item = z.object({
  id: z.string(), kind: z.enum(['card', 'task', 'responsibility', 'schedule', 'result', 'mail', 'watch', 'send']),
  title: z.string(), detail: z.string().nullable(), at: z.string(),
  conversation_id: z.uuid(), message_id: z.uuid().nullable(), state: z.string().nullable(),
  topic: z.string().nullable().default(null),
  url: z.string().nullable().default(null),
  send_task_id: z.string().nullable().default(null),
  source: z.string().nullable().default(null),
  who: z.string().nullable().default(null),
  action: z.string().nullable().default(null),
  waiting_since: z.string().nullable().default(null),
  /** Why the user said this obligation is stuck; null when it is moving. */
  blocked: z.string().nullable().default(null),
});
export type Item = z.infer<typeof Item>;
/** Sender heuristic for folding non-actionable timeline mail only; never excludes needs_you. */
export const automated = (item: Item) => item.kind === 'mail' && (item.state === 'alert' || /\bbot\b|no-?reply|notification|alert|security|github|gitlab|jira|sentry|알림|자동/i.test(item.who ?? ''));
/** Recently delivered brief, when the server includes it (optional on older servers). */
const Brief = z.object({
  body: z.string(), at: z.string(),
  conversation_id: z.uuid().nullable().default(null), message_id: z.uuid().nullable().default(null),
}).passthrough();
export const Attention = z.object({
  needs_you: z.array(Item), in_progress: z.array(Item), done: z.array(Item),
  brief: Brief.nullable().optional().catch(null),
}).passthrough();
export type Attention = z.infer<typeof Attention>;

/**
 * One shared /v1/attention poll (every 20s while anything is subscribed): the feed, the tab badge and the
 * nav badge read the same snapshot, so opening the feed never starts a second loop.
 */
type Snapshot = { readonly data: Attention | null; readonly error: string };
let snapshot: Snapshot = { data: null, error: '' };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
let inflight: Promise<void> | null = null;
let generation = 0;
const emit = () => { for (const l of listeners) l(); };
const set = (next: Partial<Snapshot>) => { snapshot = { ...snapshot, ...next }; emit(); };

/** Drop all session-owned data. Fresh sessions may resume already-mounted subscribers. */
export function resetAttentionFeed(resume = false) {
  generation++;
  clearInterval(timer);
  timer = undefined;
  inflight = null; // Old requests may finish, but cannot publish or clear a newer request.
  snapshot = { data: null, error: '' };
  emit();
  if (resume && listeners.size) void refreshAttention();
}

export function refreshAttention(): Promise<void> {
  if (listeners.size && timer === undefined) timer = setInterval(() => { void refreshAttention(); }, 20_000);
  const current = generation;
  inflight ??= read('/v1/attention', Attention).then(
    data => { if (current === generation) set({ data, error: '' }); },
    e => { if (current === generation) set({ error: errorMessage(e) }); },
  ).finally(() => { if (current === generation) inflight = null; });
  return inflight;
}
/** Optimistic removal after an action; the next poll confirms. */
export function dropAttention(id: string) {
  const d = snapshot.data;
  if (!d) return;
  set({ data: { ...d, needs_you: d.needs_you.filter(i => i.id !== id), in_progress: d.in_progress.filter(i => i.id !== id) } });
}
export function setAttentionError(error: string) { set({ error }); }

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    void refreshAttention();
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) { clearInterval(timer); timer = undefined; }
  };
}
const get = () => snapshot;
export function useAttention(): Snapshot {
  return useSyncExternalStore(subscribe, get, get);
}
const idle = () => () => {};
/** The 피드 badge: how many things wait on the user. Polls only while enabled (signed in, web navigation shown). */
export function useNeedsCount(enabled: boolean): number {
  return useSyncExternalStore(enabled ? subscribe : idle, () => enabled ? snapshot.data?.needs_you.length ?? 0 : 0, () => 0);
}
