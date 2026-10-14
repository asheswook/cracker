import { expect, test } from 'bun:test';
import { Message } from '../apps/web/src/types';
import { Message as ProtocolMessage } from '../packages/protocol';
import { backgroundCaptions, isBackgroundMessage } from '../apps/web/src/background-message';
import { systemMessageContent } from '../apps/web/src/system-message';

const message = Message.parse({ id: crypto.randomUUID(), conversation_id: crypto.randomUUID(), task_id: crypto.randomUUID(), role: 'assistant', origin: 'schedule', notify: false, content: 'Review deployment\nMore detail', sequence: 1, created_at: new Date().toISOString(), client_message_id: null });
test('background origin and explicit notification survive both wire schemas', () => {
  expect(Message.parse(ProtocolMessage.parse(message))).toMatchObject({ origin: 'schedule', notify: false });
  expect(isBackgroundMessage(message)).toBe(true);
  expect(isBackgroundMessage({ ...message, origin: 'responsibility' })).toBe(true);
  expect(isBackgroundMessage({ ...message, notify: true })).toBe(false);
  expect(isBackgroundMessage({ ...message, origin: 'user' })).toBe(false);
  expect(isBackgroundMessage({ ...message, origin: undefined })).toBe(false);
});
test('only the first background bubble per task gets a caption, not wakes or explicit notifications', () => {
  const next = { ...message, id: Message.shape.id.parse(crypto.randomUUID()) };
  const other = { ...next, id: Message.shape.id.parse(crypto.randomUUID()), task_id: Message.shape.id.parse(crypto.randomUUID()) };
  expect([...backgroundCaptions([{ ...message, role: 'system' }, { ...message, notify: true }, message, next, other])]).toEqual([message.id, other.id]);
});
test('background wake is a compact first-line notice, but deliberate notifications stay normal', () => {
  expect(systemMessageContent({ ...message, role: 'system' })).toBe('예약된 작업 실행: Review deployment');
  expect(systemMessageContent({ ...message, role: 'system', origin: 'responsibility' })).toBe('예약된 작업 실행: Review deployment');
  expect(systemMessageContent({ ...message, role: 'system', notify: true })).toBe(systemMessageContent({ ...message, role: 'system', origin: 'user' }));
  expect(systemMessageContent({ ...message, notify: true })).toBe(message.content);
});
