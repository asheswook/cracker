import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AnimatePresence, LazyMotion, domMax } from 'motion/react';
import { Chat } from '../src/Chat';
import { ConversationHeader } from '../src/ConversationHeader';
import { InspectorHost } from '../src/InspectorHost';
import { Id, Message } from '../src/types';
import '../src/styles.css';
import '../src/assistant.css';
import '../src/messenger.css';
import '../src/inspector-motion.css';

const selected = Id.parse('11111111-1111-4111-8111-111111111111');
const params = new URLSearchParams(location.search);
const messages = params.has('empty') ? [] : Array.from({ length: 50 }, (_, index) => Message.parse({
  id: `22222222-2222-4222-8222-${String(index + 1).padStart(12, '0')}`,
  conversation_id: selected, role: index % 3 === 0 ? 'user' : 'assistant',
  content: `메시지 ${index + 1}. 스크롤하며 이전 대화를 읽습니다. 화면 위쪽에서도 대화 내용을 자연스럽게 읽을 수 있습니다.\n\nThis synthetic conversation exercises the actual message feed and header.`,
  sequence: index + 1, created_at: '2026-10-04T00:00:00Z', client_message_id: null, task_id: null,
}));

function Fixture() {
  const [panel, setPanel] = useState(false);
  const [reserved, setReserved] = useState(false);
  const [timeRoot, setTimeRoot] = useState<HTMLDivElement | null>(null);
  const record = (action: string) => { document.body.dataset['action'] = action; };
  return <LazyMotion features={domMax}>
    <div className={`app-shell assistant-shell ${reserved ? 'has-inspector computer-open' : ''} ${panel ? 'inspector-visible' : ''}`}>
      <div className="desktop-sidebar" aria-label="Synthetic fixture rail" />
      <main className="main-surface">
        <ConversationHeader name="크래커" archiveTitle={undefined} connected computerOpen={panel}
          working={params.has('working')} onMenu={() => record('menu')}
          onSettings={() => record('settings')} onComputer={() => { setReserved(true); setPanel(true); }}
          onTimeControlMount={setTimeRoot} />
        <Chat messages={messages} syncedCursor={messages.length} selected={selected} outbox={[]}
          error="" task={undefined} vm={undefined} connected assistantName="크래커"
          timeControlRoot={timeRoot} />
      </main>
      <AnimatePresence onExitComplete={() => setReserved(false)}>
        {panel && <InspectorHost computer onClose={() => setPanel(false)}>
          <div className="inspector-header"><h2>검증 패널</h2><button onClick={() => setPanel(false)}>닫기</button></div>
          <div className="inspector-body">Actual InspectorHost geometry; synthetic panel content.</div>
        </InspectorHost>}
      </AnimatePresence>
    </div>
  </LazyMotion>;
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<Fixture />);
