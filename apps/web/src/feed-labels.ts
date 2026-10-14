import type { Conversation, Message } from './types';

// Dividers follow conversation order: a status notice stamped later than its neighbours, or a reply
// recorded with an earlier clock, must not make the timeline jump back and forth between days.
export function dayDividers(messages: readonly (Pick<Message, 'role' | 'created_at'> & { readonly id: string })[]): ReadonlySet<string> {
  const ids = new Set<string>();
  let shown: number | undefined;
  for (const message of messages) {
    const at = new Date(message.created_at);
    const day = new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
    if (shown !== undefined && (message.role === 'system' || day <= shown)) continue;
    ids.add(message.id); shown = day;
  }
  return ids;
}
const generic = new Set(['replay', 'assistant', '새 대화', 'new conversation']);
export function conversationLabel(item: Pick<Conversation, 'title' | 'preview'>): { title: string; detail: string | null } {
  const title = item.title.trim();
  const preview = item.preview?.trim() || null;
  if (!title || generic.has(title.toLocaleLowerCase())) return { title: preview ?? '빈 대화', detail: null };
  return { title, detail: preview };
}

