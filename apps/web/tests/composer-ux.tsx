import { useState } from 'react';
import { FooterContents } from '../src/FooterContents';
import '../src/independent-footer.css';
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
client.send = async (content, attachments = []) => {
  document.documentElement.dataset.sentArtifacts = JSON.stringify(attachments.map(file => ({id:file.id,name:file.name,bytes:file.bytes})));
  sent.push(content);
  const output = document.getElementById('sent');
  if (output) output.textContent = JSON.stringify(sent);
};
document.documentElement.dataset.footerFloating = 'true';
function PressFixture() { const [count,setCount]=useState(0); return <aside style={{position:'fixed',top:80,right:80,zIndex:100}}><div className="footer-content" style={{width:44}}><FooterContents value={{scheme:'light',readOnly:false,latest:true,error:'',storage:{failed:false,retrying:false},task:null,drafts:[]}} action={()=>setCount(value=>value+1)} /></div><output id="latest-count">{count}</output></aside>; }
const root = document.getElementById('root');
if (root) createRoot(root).render(<LazyMotion features={domAnimation}><main className="assistant-shell">
  <Chat messages={[]} syncedCursor={0} outbox={[]} selected={conversation} error="" task={undefined}
    vm={undefined} connected={false} assistantName="Assistant" />
</main><ErrorToasts /><PressFixture /></LazyMotion>);
