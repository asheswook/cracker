import { createRoot } from 'react-dom/client';
import { LazyMotion, domMax } from 'motion/react';
import { MessageList } from '../src/MessageList';
import { Message } from '../src/types';
import '../src/styles.css';
import '../src/assistant.css';
import '../src/messenger.css';

const count = Number(new URLSearchParams(location.search).get('count') ?? 400);
const messages = Array.from({ length: count }, (_, index) => Message.parse({
  id: `33333333-3333-4333-8333-${String(index + 1).padStart(12, '0')}`,
  conversation_id: '11111111-1111-4111-8111-111111111111', task_id: null,
  role: index % 3 === 0 ? 'user' : 'assistant', sequence: index + 1,
  content: `메시지 ${index + 1}: 시간을 확인하기 위해 왼쪽으로 끌어당깁니다.\n\n` +
    '**조사 결과**를 읽고 원래 위치로 돌아옵니다. '.repeat(6) +
    '\n\n- 첫 번째 결과\n- 두 번째 결과\n\n[문서 링크](https://example.com)',
  client_message_id: null, read_at: null, created_at: '2026-10-06T01:00:00Z',
}));
const root = document.getElementById('root');
if (root) createRoot(root).render(<LazyMotion features={domMax}>
  <div className="assistant-shell"><main className="main-surface">
    <div className="message-feed" style={{ height: '100%', overflowY: 'auto' }}>
      <MessageList messages={messages} pending={[]} arrivals={new Set()} reduced={matchMedia('(prefers-reduced-motion: reduce)').matches}/>
    </div>
  </main></div>
</LazyMotion>);
