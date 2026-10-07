import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LazyMotion, domMax } from 'motion/react';
import { Chat } from '../src/Chat';
import { ConversationHeader } from '../src/ConversationHeader';
import { Id, Message } from '../src/types';
import '../src/styles.css';
import '../src/assistant.css';
import '../src/messenger.css';

const conversation = Id.parse('11111111-1111-4111-8111-111111111111');
const initial = Array.from({ length: 32 }, (_, index) => Message.parse({
  id: `33333333-3333-4333-8333-${String(index + 1).padStart(12, '0')}`,
  conversation_id: conversation, task_id: null, role: 'assistant', sequence: index + 1,
  content: index === 30 ? '| Value | Detail |\n|---|---|\n| `' + 'a'.repeat(64) + '` | ' + 'Filename'.repeat(16) + ' |'
    : index === 31 ? '시간을 당겨 확인할 메시지입니다.\n\n[문서 링크](https://example.com)' : `${index + 1}. 읽던 위치를 유지합니다. `.repeat(5),
  client_message_id: null, read_at: null, created_at: '2026-10-03T01:00:00Z',
}));
function Fixture() {
  const [messages, setMessages] = useState(initial);
  const [focusMessage, setFocusMessage] = useState<string | null>(null);
  const [timeControlRoot, setTimeControlRoot] = useState<HTMLDivElement | null>(null);
  const [mode, setMode] = useState<'conversation' | 'archive' | 'empty' | 'loading'>('conversation');
  const shownMessages = mode === 'empty' || mode === 'loading' ? [] : messages;
  const reply = () => setMessages(items => [...items, Message.parse({ ...initial[0], id: crypto.randomUUID(), sequence: items.length + 1, content: '새로운 응답입니다. '.repeat(30) })]);
  return <LazyMotion features={domMax}>
    <style>{'.fixture-controls{opacity:0}.fixture-controls:focus-within{opacity:1}'}</style>
    <nav className="fixture-controls">
      <button id="empty" onClick={() => setMode('empty')}>Empty</button>
      <button id="loading" onClick={() => setMode('loading')}>Loading</button>
      <button id="archive" onClick={() => setMode('archive')}>Archive</button>
      <button id="conversation" onClick={() => setMode('conversation')}>Conversation</button>
      <button id="reply" onClick={reply}>Reply</button>
      <button id="delayed" onClick={() => setTimeout(reply, 250)}>Reply in 250ms</button>
      <button id="source" onClick={() => setFocusMessage(initial[12]?.id ?? null)}>Source</button>
    </nav>
    <div className="assistant-shell"><main className="main-surface">
      <ConversationHeader name="Fixture" archiveTitle={mode === 'archive' ? '보관한 대화' : undefined} connected computerOpen={false} onMenu={() => {}} onSettings={() => {}} onComputer={() => {}} onTimeControlMount={setTimeControlRoot} />
      <Chat messages={shownMessages} syncedCursor={mode === 'loading' ? null : shownMessages.length} outbox={[]} selected={conversation} error="" task={undefined} vm={undefined} connected assistantName="Fixture" readOnly={mode === 'archive'} focusMessage={focusMessage} timeControlRoot={timeControlRoot}/>
    </main></div>
  </LazyMotion>;
}
const root = document.getElementById('root');
if (root) createRoot(root).render(<Fixture/>);
