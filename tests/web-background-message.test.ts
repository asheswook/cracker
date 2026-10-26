import { expect, test } from 'bun:test';
import { Message } from '../apps/web/src/types';
import { Message as ProtocolMessage } from '../packages/protocol';
import { feedItems, isBackgroundMessage, readableTitle } from '../apps/web/src/background-message';
import { systemMessageContent } from '../apps/web/src/system-message';
import { Task } from '../apps/web/src/types';
import { Task as ProtocolTask } from '../packages/protocol';
import { isRoutine, taskTitle } from '../apps/web/src/work-list';
import { lastRunLabel } from '../apps/web/src/schedule-labels';

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
test('reply objectives with a user instruction prefix show the thread subject, not the instruction', () => {
  const prefix = 'The user asked for this reply and said what it should say: "Please say yes." ';
  expect(readableTitle(`${prefix}Prepare a reply draft in Gmail. Thread: Budget review (from Talbot, id abc).`)).toBe('답장 초안 쓰기 · Budget review');
  expect(readableTitle(`${prefix}Prepare a reply draft in Slack. Thread: Release plan, id abc.`)).toBe('답장 초안 쓰기 · Release plan');
  expect(readableTitle('Prepare a reply draft for "Old subject".')).toBe('답장 초안 쓰기 · Old subject');
  expect(readableTitle('Gmail observation for me@example.com (inbox)')).toBe('Gmail 확인 · me@example.com');
  expect(readableTitle('Send one approved reply. Thread: Review, id abc')).toBe('승인한 답장 보내기 · Review');
  expect(readableTitle('Check whether an approved reply went out')).toBe('보낸 답장 확인');
});

test('task classification prefers explicit lane and origin over legacy text heuristics', () => {
  expect(isRoutine({ objective: '짧은 예약', lane: 'background' })).toBe(true);
  expect(isRoutine({ objective: '짧은 예약', origin: 'schedule' })).toBe(true);
  expect(isRoutine({ objective: '짧은 예약', lane: 'foreground', origin: 'responsibility' })).toBe(true);
  expect(isRoutine({ objective: 'Morning brief', lane: 'foreground' })).toBe(false);
  expect(isRoutine({ objective: 'Morning brief', origin: 'user' })).toBe(false);
  expect(isRoutine({ objective: 'Morning brief' })).toBe(true);
  expect(isRoutine({ objective: '직접 요청' })).toBe(false);
});

test('task titles preserve explicit names, short arrows, and first-line fallbacks', () => {
  expect(taskTitle({ objective: "'메일' 스킬을 로드해 확인해요.", title: '내가 정한 제목', origin: 'schedule' })).toBe('내가 정한 제목');
  expect(taskTitle({ objective: "'메일' 스킬을 로드해 확인해요." })).toBe('메일');
  expect(taskTitle({ objective: 'A => B', origin: 'user' })).toBe('A => B');
  expect(taskTitle({ objective: `${'인'.repeat(39)}=> 질문` })).toBe(`${'인'.repeat(39)}=> 질문`);
  expect(taskTitle({ objective: `${'인'.repeat(40)}=> 질문\n상세` })).toBe('질문');
  expect(taskTitle({ objective: `${'인'.repeat(40)}=>   ` })).toBe(`${'인'.repeat(40)}=>`);
  expect(taskTitle({ objective: `${'인'.repeat(40)}=> 중간 => 마지막` })).toBe('마지막');
});

test('task display metadata survives both wire schemas and unknown runs are not labeled failures', () => {
  const task = { id: crypto.randomUUID(), conversation_id: crypto.randomUUID(), objective: '확인', title: '메일 확인', origin: 'responsibility', lane: 'background', state: 'succeeded', reason: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  expect(Task.parse(ProtocolTask.parse(task))).toMatchObject({ title: '메일 확인', origin: 'responsibility', lane: 'background' });
  expect(lastRunLabel({ state: 'unknown', reason: null }, null)?.text).toBe('지난번 결과 확인 못 함');
});
