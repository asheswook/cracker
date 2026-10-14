import type { Message } from './types';

export function isBackgroundMessage(message: Message): boolean {
  return !message.notify && (message.origin === 'schedule' || message.origin === 'responsibility');
}
export function backgroundCaptions(messages: readonly Message[]): ReadonlySet<string> {
  const tasks = new Set<string>(), captions = new Set<string>();
  for (const message of messages) {
    if (!isBackgroundMessage(message) || message.role === 'system') continue;
    const key = message.task_id ?? message.id;
    if (!tasks.has(key)) captions.add(message.id);
    tasks.add(key);
  }
  return captions;
}
