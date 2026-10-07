import { useState, useRef, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { LazyMotion, domAnimation } from 'motion/react';
import { ErrorToasts } from '../src/ErrorToasts';
import { ErrorNotice } from '../src/primitives';
import { errorToasts } from '../src/error-toasts';
import { forwardFooterErrors, receiveFooterErrors } from '../src/footer-error-channel';
import { useTaskErrorToasts } from '../src/useTaskErrorToasts';
import { MessageList } from '../src/MessageList';
import { Task, Message } from '../src/types';
import '../src/styles.css';
import '../src/messenger.css';

const id = '11111111-1111-4111-8111-111111111111';
const old = Task.parse({ id, conversation_id: id, objective: 'Existing failed task', state: 'failed', reason: 'Historical failure must stay quiet', created_at: '2026-10-06T05:00:00Z', updated_at: '2026-10-06T05:01:00Z' });
const messages = Message.array().parse([
  { id, conversation_id: id, role: 'system', content: old.reason, sequence: 1, client_message_id: null, created_at: old.created_at, task_status: { task_id: id, run_id: id, state: 'failed', reason: old.reason } },
  { id: '22222222-2222-4222-8222-222222222222', conversation_id: id, role: 'system', content: '매일 낮 12시에 새 공지를 확인합니다.', sequence: 2, client_message_id: null, created_at: old.created_at },
]);
function Fixture() {
  useLayoutEffect(() => receiveFooterErrors('fixture'), []);
  const [tasks, setTasks] = useState([old]);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  useTaskErrorToasts('fixture', true, tasks);
  return <><main className="assistant-shell" id="content" style={{ padding: 24 }}>
    <h1>메시지와 입력창</h1><p>오류가 도착해도 이 영역의 위치와 크기는 유지됩니다.</p>
    <button id="operation" onClick={() => setError('파일을 올리지 못했어요. 연결을 확인하고 다시 시도해 주세요.')}>첨부 오류</button>
    <button id="failure" onClick={() => setTasks([{ ...old, updated_at: new Date().toISOString(), reason: `Invalid provider response: invalid_tool_arguments\n${'긴 오류 내용과 필요한 조치를 확인합니다. '.repeat(30)}\n<script>window.bad = true</script>` }])}>새 작업 오류</button>
    <button id="rerender" onClick={() => setRevision(value => value + 1)}>같은 상태 {revision}</button>
    <button id="modal" onClick={() => dialog.current?.showModal()}>설정 열기</button>
    {error && <ErrorNotice>{error}</ErrorNotice>}
    <MessageList messages={messages} pending={[]} reduced={false} arrivals={new Set()} />
    <textarea aria-label="메시지 입력" defaultValue="보존할 초안" />
    <dialog ref={dialog} aria-label="설정"><h2>설정</h2><button id="modal-error" onClick={() => errorToasts.show('설정을 저장하지 못했어요. 작성 중인 내용은 유지돼요.')}>저장 실패</button><button id="modal-close" onClick={() => dialog.current?.close()}>닫기</button></dialog>
  </main><ErrorToasts /></>;
}
function FooterFixture() {
  useLayoutEffect(() => forwardFooterErrors('fixture'), []);
  return <button id="footer-error" onClick={() => errorToasts.show('독립 입력 영역의 오류 전달 시험')}>오류 전달</button>;
}
const root = document.getElementById('root');
if (root) createRoot(root).render(<LazyMotion features={domAnimation}>{new URL(location.href).searchParams.has('footer') ? <FooterFixture /> : <Fixture />}</LazyMotion>);
