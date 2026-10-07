import { createRoot } from 'react-dom/client';
import { LazyMotion, domAnimation } from 'motion/react';
import { MessageList } from '../src/MessageList';
import { FooterContents } from '../src/FooterContents';
import { FooterOnly } from '../src/FooterOnly';
import { FooterProps } from '../src/independent-footer-protocol';
import { WorkPanel } from '../src/WorkPanel';
import { Message, Task } from '../src/types';
import '../src/styles.css';
import '../src/assistant.css';
import '../src/messenger.css';

const conversation = '11111111-1111-4111-8111-111111111111';
const taskId = '22222222-2222-4222-8222-222222222222';
const runId = '33333333-3333-4333-8333-333333333333';
const legacy = '작업 상태를 확인할 수 없어요. 다시 진행하기 전에 확인이 필요해요.';
const reason = 'Invalid provider response: invalid_tool_arguments; no calls from that response were executed';
const longReason = `${reason}\n${'unbroken-diagnostic-'.repeat(22)}\n<script>window.unexpectedScript = true</script>\n마지막 오류 내용`;
const params = new URLSearchParams(location.search);
const diagnostic = params.has('long') ? longReason : reason;
const base = { conversation_id: conversation, task_id: null, client_message_id: null, created_at: '2026-10-06T05:49:00Z', role: 'system' };
const messages = Message.array().parse([
  { ...base, id: '44444444-4444-4444-8444-444444444444', sequence: 1, content: legacy },
  { ...base, id: '55555555-5555-4555-8555-555555555555', sequence: 2, content: '매일 한국시간 낮 12시쯤 새 보안공지를 확인하고 중복 없이 공유한다.' },
  { ...base, id: '66666666-6666-4666-8666-666666666666', sequence: 3, role: 'assistant', task_id: taskId, content: '자료를 확인하고 있어요.' },
  { ...base, id: '77777777-7777-4777-8777-777777777777', sequence: 4, content: legacy, task_status: { task_id: taskId, run_id: runId, state: 'unknown', reason: diagnostic } },
  { ...base, id: '88888888-8888-4888-8888-888888888888', sequence: 5, role: 'user', content: 'retry' },
]);
const task = Task.parse({ id: taskId, conversation_id: conversation, objective: 'Synthetic scheduled objective', state: 'unknown', reason: diagnostic, created_at: base.created_at, updated_at: base.created_at });
const footer = FooterProps.parse({ scheme: 'light', readOnly: false, latest: false, error: '', storage: { failed: false, retrying: false }, task: { id: taskId, state: 'unknown', reason: diagnostic, reasonTruncated: true }, drafts: [] });
const root = document.getElementById('root');
if (root) createRoot(root).render(<LazyMotion features={domAnimation}>{params.has('footer') ? <FooterOnly /> : params.has('work') ? <WorkPanel tasks={[task]} onOpen={() => undefined} onSource={() => undefined} /> : <main className="assistant-shell" style={{ padding: 'var(--s6)' }}>
  <MessageList messages={messages} pending={[]} reduced={false} arrivals={new Set()} />
  <section id="footer"><FooterContents value={footer} action={() => undefined} /></section>
  <label>메시지 입력<input aria-label="메시지 입력" /></label>
</main>}</LazyMotion>);
