import { expect, test } from 'bun:test';
import { Message } from '../apps/web/src/types';
import { Message as ProtocolMessage } from '../packages/protocol';
import { feedItems, isBackgroundMessage } from '../apps/web/src/background-message';
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
test('consecutive background messages of one task collapse into a single run, not explicit notifications', () => {
  const wake = { ...message, id: Message.shape.id.parse(crypto.randomUUID()), role: 'system' as const, content: 'Review deployment\nMore detail' };
  const next = { ...message, id: Message.shape.id.parse(crypto.randomUUID()), content: '| a | b |\n|---|---|\n| 1 | 2 |' };
  const other = { ...next, id: Message.shape.id.parse(crypto.randomUUID()), task_id: Message.shape.id.parse(crypto.randomUUID()) };
  const loose = { ...message, id: Message.shape.id.parse(crypto.randomUUID()), task_id: null };
  const looseNext = { ...loose, id: Message.shape.id.parse(crypto.randomUUID()) };
  const notified = { ...message, id: Message.shape.id.parse(crypto.randomUUID()), notify: true };
  const items = feedItems([wake, message, next, other, notified, loose, looseNext]);
  expect(items.map(item => item.kind === 'run' ? item.messages.map(m => m.id) : item.message.id)).toEqual([
    [wake.id, message.id, next.id], [other.id], notified.id, [loose.id], [looseNext.id],
  ]);
  const [run, untitled] = items;
  expect(run).toMatchObject({ kind: 'run', title: 'Review deployment', preview: 'a · b' });
  expect(untitled).toMatchObject({ kind: 'run', title: '자동 작업' });
  expect(feedItems([{ ...wake, content: '예약된 작업 실행: Prefixed' }])[0]).toMatchObject({ title: 'Prefixed' });
});
test('background wake is a compact first-line notice, but deliberate notifications stay normal', () => {
  expect(systemMessageContent({ ...message, role: 'system' })).toBe('예약된 작업 실행: Review deployment');
  expect(systemMessageContent({ ...message, role: 'system', origin: 'responsibility' })).toBe('예약된 작업 실행: Review deployment');
  expect(systemMessageContent({ ...message, role: 'system', notify: true })).toBe(systemMessageContent({ ...message, role: 'system', origin: 'user' }));
  expect(systemMessageContent({ ...message, notify: true })).toBe(message.content);
});
test('a run without its wake notice in view is titled from the task objective', () => {
  const objectives = new Map([[message.task_id!, '매일 낮 12시 보안공지 확인\n세부 지시']]);
  expect(feedItems([message], objectives)[0]).toMatchObject({ kind: 'run', title: '매일 낮 12시 보안공지 확인' });
  expect(feedItems([message])[0]).toMatchObject({ kind: 'run', title: '자동 작업' });
});
test('the run preview keeps literal tildes and underscores while dropping emphasis markers', () => {
  const reply = { ...message, content: '**새 공지** 5건(202600264~268)을 `#d05_보안_공지`에 올렸습니다.' };
  expect(feedItems([reply])[0]).toMatchObject({ preview: '새 공지 5건(202600264~268)을 #d05_보안_공지에 올렸습니다.' });
});
