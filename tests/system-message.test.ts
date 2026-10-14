import { expect, test } from 'bun:test';
import { Message } from '../apps/web/src/types';
import { systemMessageContent } from '../apps/web/src/system-message';

const legacy = '작업 상태를 확인할 수 없어요. 다시 진행하기 전에 확인이 필요해요.';
const message = Message.parse({ id: '11111111-1111-4111-8111-111111111111', conversation_id: '22222222-2222-4222-8222-222222222222', role: 'system', content: legacy, task_id: null, sequence: 1, created_at: '2026-10-06T05:49:00Z', client_message_id: null });
const status = { task_id: message.id, run_id: message.conversation_id, state: 'unknown', reason: 'Invalid provider response: invalid_tool_arguments; no calls from that response were executed' } as const;

test('task-scoped diagnostics stay out of the feed while retaining their original metadata', () => {
  const decoded = Message.parse({ ...message, task_status: status });
  expect(systemMessageContent(decoded)).toBeNull();
  expect(decoded.task_status?.reason).toBe(status.reason);
  expect(decoded.task_status?.run_id).toBe(status.run_id);
});
test('only exact legacy system notices without metadata are suppressed', () => {
  expect(systemMessageContent(message)).toBeNull();
  expect(systemMessageContent({ ...message, role: 'user' })).toBe(legacy);
  expect(systemMessageContent({ ...message, role: 'assistant' })).toBe(legacy);
  expect(systemMessageContent({ ...message, content: `${legacy} Additional diagnostic` })).toBe(`${legacy} Additional diagnostic`);
});
test('scheduled notices stay verbatim and internal English error bodies are shown in user language', () => {
  const notice = '매일 한국시간 낮 12시쯤 새 보안공지를 확인한다.';
  expect(systemMessageContent({ ...message, content: notice })).toBe(notice);
  expect(systemMessageContent({ ...message, content: status.reason })).toBe('모델 응답을 처리하지 못해 멈췄어요. 실행된 동작은 없어요. 다시 요청해 주세요.');
});
test('task status suppresses only system callouts and never user prose', () => {
  const reason = ' first line\n<script>alert(1)</script>\nlast line ';
  expect(systemMessageContent({ ...message, task_status: { ...status, reason } })).toBeNull();
  expect(systemMessageContent({ ...message, role: 'user', task_status: status })).toBe(legacy);
  expect(systemMessageContent({ ...message, task_status: { ...status, reason: ' ' } })).toBeNull();
});
