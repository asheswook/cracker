import { expect, test } from 'bun:test';
import { taskReason } from '../apps/web/src/task-reason';
import { dayDividers, conversationLabel } from '../apps/web/src/feed-labels';

test('internal daemon reasons become actionable Korean copy and keep the raw text as detail', () => {
  const runtime = taskReason('Runtime/provider/tool failure; inspect protected local journal before resuming');
  expect(runtime?.text).toBe('작업 중 문제가 생겨 멈췄어요. 메시지를 보내면 하던 곳부터 이어서 해요.');
  expect(runtime?.detail).toContain('Runtime/provider');
  expect(taskReason('Invalid provider response: invalid_tool_arguments; no calls from that response were executed')?.text).toContain('실행된 동작은 없어요');
  expect(taskReason('Something unexpected in English')?.text).toBe('작업 중 문제가 생겨 멈췄어요. 다시 요청해 주세요.');
  expect(taskReason('이미 한국어로 된 이유')).toEqual({ text: '이미 한국어로 된 이유', detail: null });
  expect(taskReason('  ')).toBeNull();
});

test('day dividers never step backwards and status notices do not open a day', () => {
  const at = (day: number, hour = 9) => new Date(2026, 9, day, hour).toISOString();
  const ids = dayDividers([
    { id: 'a', role: 'user', created_at: at(7) },
    { id: 'b', role: 'system', created_at: at(13) },
    { id: 'c', role: 'user', created_at: at(7, 10) },
    { id: 'd', role: 'assistant', created_at: at(8) },
    { id: 'e', role: 'system', created_at: at(13) },
    { id: 'f', role: 'user', created_at: at(7, 11) },
  ]);
  expect([...ids]).toEqual(['a', 'd']);
});

test('generic conversation titles fall back to the first user message', () => {
  expect(conversationLabel({ title: 'replay', preview: '숨고 결제 구조 알려줘' })).toEqual({ title: '숨고 결제 구조 알려줘', detail: null });
  expect(conversationLabel({ title: 'Assistant', preview: null })).toEqual({ title: '빈 대화', detail: null });
  expect(conversationLabel({ title: 'PG 분류', preview: '에이블리는?' })).toEqual({ title: 'PG 분류', detail: '에이블리는?' });
});
