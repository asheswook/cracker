import { Id } from './types';

export type ResultLink =
  | { readonly kind: 'none' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'result'; readonly conversation: Id; readonly message?: Id };

export function parseResultLink(url: URL): ResultLink {
  const conversations = url.searchParams.getAll('conversation');
  const messages = url.searchParams.getAll('message');
  if (conversations.length === 0 && messages.length === 0) return { kind: 'none' };
  if (conversations.length !== 1 || messages.length > 1) return { kind: 'invalid' };
  const conversation = Id.safeParse(conversations[0]);
  const message = messages.length ? Id.safeParse(messages[0]) : null;
  if (!conversation.success || (message && !message.success)) return { kind: 'invalid' };
  return { kind: 'result', conversation: conversation.data, ...(message?.success ? { message: message.data } : {}) };
}
