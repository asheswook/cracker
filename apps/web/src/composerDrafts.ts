import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { z } from 'zod';
import { MessageReply, type Id } from './types';

const SavedDraft = z.object({ text: z.string(), version: z.string(), reply: MessageReply.nullable().default(null) });
type Draft = z.infer<typeof SavedDraft> & { readonly error: string };
const drafts = new Map<string, Draft>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
function read(key: string): Draft {
  const cached = drafts.get(key);
  if (cached) return cached;
  let draft: Draft;
  try {
    const stored = localStorage.getItem(key);
    draft = { ...(stored ? SavedDraft.parse(JSON.parse(stored)) : { text: '', version: '', reply: null }), error: '' };
  } catch {
    draft = { text: '', version: '', reply: null, error: '저장된 초안을 읽지 못했어요.' };
  }
  drafts.set(key, draft);
  return draft;
}
function write(key: string, text: string, reply: MessageReply | null = read(key).reply) {
  const saved = { text, reply, version: crypto.randomUUID() };
  let error = '';
  try {
    if (text || reply) localStorage.setItem(key, JSON.stringify(saved));
    else localStorage.removeItem(key);
  } catch {
    error = '초안을 이 기기에 저장하지 못했어요. 창을 닫기 전에 복사해 주세요.';
  }
  drafts.set(key, { ...saved, error });
  for (const notify of listeners) notify();
  return read(key);
}
export function useComposerDraft(workspace: Id | null, conversation: Id | null) {
  const scope = `assistant:draft:${workspace ?? 'none'}:${conversation ?? 'new'}`;
  const getSnapshot = useCallback(() => read(scope), [scope]);
  const draft = useSyncExternalStore(subscribe, getSnapshot);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (!event.key?.startsWith('assistant:draft:')) return;
      drafts.delete(event.key);
      for (const notify of listeners) notify();
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, []);
  const setText = useCallback((text: string) => write(scope, text), [scope]);
  const setReply = useCallback((reply: MessageReply | null) => write(scope, read(scope).text, reply), [scope]);
  const clearIfUnchanged = useCallback((version: string) => {
    if (read(scope).version !== version) return;
    try {
      const stored = localStorage.getItem(scope);
      if (stored && SavedDraft.parse(JSON.parse(stored)).version !== version) {
        drafts.delete(scope);
        for (const notify of listeners) notify();
        return;
      }
    } catch {
      return;
    }
    write(scope, '', null);
  }, [scope]);
  return { ...draft, scope, setText, setReply, readCurrent: getSnapshot, clearIfUnchanged };
}
