import { createRoot } from 'react-dom/client';
import { Chat } from '../src/Chat';
import { client } from '../src/store';
import { Id } from '../src/types';
import { LazyMotion, domAnimation } from 'motion/react';
import { ErrorToasts } from '../src/ErrorToasts';
import '../src/styles.css';
import '../src/assistant.css';
import '../src/messenger.css';

const workspace = Id.parse('11111111-1111-4111-8111-111111111111');
const conversation = Id.parse('22222222-2222-4222-8222-222222222222');
const sent: string[] = [];
client['value'] = { ...client.snapshot(), workspace, selected: conversation, assistantId: conversation,
  phase: 'ready', syncedCursor: 0, connected: false };
localStorage.setItem(`assistant:draft:${workspace}:${conversation}`, JSON.stringify({ text: '', version: crypto.randomUUID() }));
client.send = async content => {
  sent.push(content);
  const output = document.getElementById('sent');
  if (output) output.textContent = JSON.stringify(sent);
};
const root = document.getElementById('root');
if (root) createRoot(root).render(<LazyMotion features={domAnimation}><main className="assistant-shell">
  <Chat messages={[]} syncedCursor={0} outbox={[]} selected={conversation} error="" task={undefined}
    vm={undefined} connected={false} assistantName="Assistant" />
</main><ErrorToasts /></LazyMotion>);
