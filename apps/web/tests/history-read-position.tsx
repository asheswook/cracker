import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LazyMotion, domMax } from 'motion/react';
import { Chat } from '../src/Chat';
import { client } from '../src/store';
import { Id, Message } from '../src/types';
import '../src/styles.css';
import '../src/assistant.css';
import '../src/messenger.css';
const current=Id.parse('11111111-1111-4111-8111-111111111111');
const archive=Id.parse('22222222-2222-4222-8222-222222222222');
const date='2026-10-04T00:00:00Z';
const make=(conversation:Id,index:number)=>Message.parse({id:`${conversation.slice(0,8)}-3333-4333-8333-${String(index).padStart(12,'0')}`,conversation_id:conversation,role:'assistant',content:`Message ${index}. ${'Synthetic reading content across a line and narrow viewports. '.repeat(8)}`,sequence:index,created_at:date,client_message_id:null,task_id:index===15?'44444444-4444-4444-8444-444444444444':null});
function Fixture(){
 const [selected,setSelected]=useState(current),[loading,setLoading]=useState(false),[partial,setPartial]=useState(false),[size,setSize]=useState(70),[focus,setFocus]=useState<'message'|'task'|null>(null),[workspace,setWorkspace]=useState(current);
 const messages=Array.from({length:selected===current?size:40},(_,index)=>make(selected,index+1));
 client.snapshot=()=>({...originalSnapshot(),selected,workspace});
 client.send=async()=>{setSize(value=>value+1);};
 const navigate=(id:Id,delay=false)=>{setFocus(null);setSelected(id);setLoading(delay);};
 return <LazyMotion features={domMax}><div className="assistant-shell"><main className="main-surface"><nav className="fixture-controls">
 <button id="current" onClick={()=>navigate(current)}>Current</button><button id="archive" onClick={()=>navigate(archive)}>Archive</button>
 <button id="delayed" onClick={()=>navigate(current,true)}>Delayed current</button><button id="resolve" onClick={()=>{setLoading(false);setPartial(false);}}>Resolve</button><button id="partial" onClick={()=>setPartial(true)}>Partial history</button>
 <button id="arrival" onClick={()=>setSize(value=>value+1)}>Arrival</button>
 <button id="focus-message" onClick={()=>{navigate(current);setFocus('message');}}>Message focus</button>
 <button id="delayed-focus" onClick={()=>{navigate(current,true);setFocus('message');}}>Delayed focus</button>
 <button id="focus-task" onClick={()=>{navigate(current);setFocus('task');}}>Task focus</button>
 <button id="observe-scroll" onClick={()=>{const node=document.querySelector<HTMLElement>('.message-feed');if(!node)return;const scrollTo=node.scrollTo.bind(node);node.dataset['scrollCalls']='0';node.scrollTo=(options?:ScrollToOptions|number,y?:number)=>{node.dataset['scrollCalls']=String(Number(node.dataset['scrollCalls'])+1);if(typeof options==='number')scrollTo(options,y??0);else scrollTo(options);};}}>Observe scroll</button>
 <button id="workspace" onClick={()=>setWorkspace(archive)}>Workspace</button>
 </nav><Chat messages={loading?(partial?messages.slice(0,10):[]):messages} syncedCursor={loading?null:messages.length} selected={selected} outbox={[]} error="" task={undefined} vm={undefined} connected={false} assistantName="Fixture" readOnly={selected===archive} focusMessage={focus==='message'?make(current,15).id:null} focusTask={focus==='task'?'44444444-4444-4444-8444-444444444444':null}/></main></div></LazyMotion>;
}
const originalSnapshot=client.snapshot;
const root=document.getElementById('root');if(root)createRoot(root).render(<Fixture/>);
