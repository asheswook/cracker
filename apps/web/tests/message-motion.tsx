import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LazyMotion, domMax } from 'motion/react';
import { Chat } from '../src/Chat';
import { Id, Message, Pending, ReplyComposing, ReplyHandoff, Task, Vm } from '../src/types';
import { client } from '../src/store';
import '../src/styles.css';
import '../src/assistant.css';
import '../src/messenger.css';

const conversation = Id.parse('11111111-1111-4111-8111-111111111111');
const other = Id.parse('22222222-2222-4222-8222-222222222222');
const task = Task.parse({ id:'33333333-3333-4333-8333-333333333333',conversation_id:conversation,objective:'Synthetic reply',state:'running',reason:null,created_at:new Date().toISOString(),updated_at:new Date().toISOString() });
const user = Message.parse({ id:'44444444-4444-4444-8444-444444444444',conversation_id:conversation,task_id:task.id,role:'user',content:'합성 질문입니다.',sequence:1,client_message_id:null,created_at:new Date().toISOString(),read_at:new Date().toISOString() });
const vm = Vm.parse({ id:crypto.randomUUID(),name:'Fixture VM',last_seen_at:new Date().toISOString(),control_state:'agent' });
const signal = () => ReplyComposing.parse({ task_id:task.id,run_id:'55555555-5555-4555-8555-555555555555',inference_id:'66666666-6666-4666-8666-666666666666',generation:1,response_id:'synthetic-response',item_id:'synthetic-item',input_message_ids:[user.id],expires_at:new Date(Date.now()+5000).toISOString() });
function Fixture() {
  const params = new URL(location.href).searchParams;
  const explicit = params.has('handoff');
  const [messages,setMessages]=useState<Message[]>([user]);
  const [outbox,setOutbox]=useState<Pending[]>([]);
  const [composing,setComposing]=useState<ReplyComposing|null>(null);
  const [handoff,setHandoff]=useState<ReplyHandoff|null|undefined>(explicit?null:undefined);
  const [currentTask,setTask]=useState(task);
  const [selected,setSelected]=useState(conversation);
  const [connected,setConnected]=useState(true);
  const [cursor,setCursor]=useState<number|null>(1);
  const delivery=()=>ReplyHandoff.parse({...signal(),status:params.get('handoff')==='settling'?'settling':'delivering',delivery_event_id:params.get('handoff')==='settling'?null:crypto.randomUUID()});
  const reply=()=>{setComposing(null);setHandoff(explicit?null:undefined);setMessages(items=>[...items,Message.parse({...user,id:crypto.randomUUID(),role:'assistant',content:params.get('reply')==='long'?'긴 합성 답변입니다. '.repeat(100):'합성 답변입니다.',sequence:Math.max(...items.map(item=>item.sequence))+1,read_at:null})]);setCursor(value=>(value??1)+1);};
  useEffect(()=>{const original=client.send;client.send=async(content,attachments)=>{setOutbox(items=>[...items,Pending.parse({client_message_id:crypto.randomUUID(),conversation_id:selected,content,attachments,created_at:new Date().toISOString(),state:'sending'})]);};return()=>{client.send=original;};},[selected]);
  const reset=()=>{setMessages([user]);setOutbox([]);setComposing(null);setHandoff(explicit?null:undefined);setTask(task);setSelected(conversation);setConnected(true);setCursor(1);};
  return <LazyMotion features={domMax}>
    <nav className="fixture-controls" aria-label="Synthetic scenarios">
      <button id="reset" onClick={reset}>Reset</button>
      <button id="begin" onClick={()=>setComposing(signal())}>Begin genuine signal</button>
      <button id="wrong-source" onClick={()=>setComposing({...signal(),input_message_ids:[other]})}>Wrong source</button>
      <button id="expires" onClick={()=>setComposing({...signal(),expires_at:new Date(Date.now()+550).toISOString()})}>Expire lease</button>
      <button id="renew" onClick={()=>setComposing(signal())}>Renew</button>
      <button id="fast" onClick={()=>{setComposing(signal());setTimeout(reply,60);}}>Fast 60ms reply</button>
      <button id="reply" onClick={reply}>Reply</button>
      <button id="handoff-gap" onClick={()=>{setComposing(null);if(explicit)setHandoff(delivery());if(params.has('terminal'))setTask({...task,state:'succeeded'});const gap=Number(params.get('gap')??0);if(gap) setTimeout(reply,gap);else reply();}}>Gap handoff</button>
      <button id="hold" onClick={()=>{setComposing(null);setHandoff(delivery());}}>Publication pending</button>
      <button id="no-reply" onClick={()=>{setComposing(null);setHandoff(null);}}>No reply</button>
      <button id="handoff-expiry" onClick={()=>{setComposing(null);setHandoff({...delivery(),expires_at:new Date(Date.now()+600).toISOString()});}}>Expire publication</button>
      <button id="handoff-only" onClick={()=>setHandoff(delivery())}>Handoff without typing</button>
      <button id="stale-handoff" onClick={()=>{setComposing(null);setHandoff({...delivery(),expires_at:new Date(Date.now()-1).toISOString()});}}>Stale handoff</button>
      {(['run_id','inference_id','generation','response_id','item_id','input_message_ids','task_id'] as const).map(field=><button key={field} id={`mismatch-${field}`} onClick={()=>{setComposing(null);setHandoff(ReplyHandoff.parse({...delivery(),[field]:field==='generation'?2:field==='input_message_ids'?[other]:other}));}}>Mismatch {field}</button>)}
      <button id="newer-composing" onClick={()=>{setHandoff(delivery());setComposing({...signal(),generation:2,inference_id:other,item_id:'new-item'});}}>New genuine typing</button>
      <button id="same-inference-item" onClick={()=>setComposing({...signal(),item_id:'next-item'})}>Next genuine text item</button>
      <button id="same-item-hold" onClick={()=>{setComposing(null);setHandoff({...delivery(),item_id:'next-item'});}}>Hold next text item</button>
      <button id="restart" onClick={()=>{setComposing(null);setTimeout(()=>setComposing({...signal(),generation:2,item_id:'second-item'}),50);setTimeout(reply,300);}}>Rapid restart</button>
      <button id="stream-item" onClick={()=>{reply();setTimeout(()=>setComposing({...signal(),generation:2,item_id:'second-item'}),60);}}>Next streamed item</button>
      <button id="reply-before-clear" onClick={()=>{reply();setComposing(signal());setTimeout(()=>setComposing(null),150);}}>Reply before clear</button>
      <button id="terminal-signal" onClick={()=>{setTask({...task,state:'succeeded'});setTimeout(reply,150);}}>Terminal with old signal</button>
      <button id="remove-reply" onClick={()=>{setMessages(items=>items.filter(item=>item.role!=='assistant'));setComposing(null);}}>Remove old reply</button>
      <button id="new-input" onClick={()=>{setMessages(items=>[...items,{...user,id:crypto.randomUUID() as Id,sequence:Math.max(...items.map(item=>item.sequence))+1,content:'새 입력'}]);setCursor(value=>(value??1)+1);}}>New input</button>
      <button id="idle" onClick={()=>setComposing(null)}>Idle</button>
      <button id="cancel" onClick={()=>setTask({...task,state:'cancelled'})}>Cancel</button>
      <button id="unread" onClick={()=>setMessages(items=>items.map(item=>item.id===user.id?{...item,read_at:null}:item))}>Unread</button>
      <button id="disconnect" onClick={()=>setConnected(false)}>Disconnect</button>
      <button id="task-switch" onClick={()=>setTask({...task,id:other})}>Switch task</button>
      <button id="conversation-switch" onClick={()=>{setSelected(other);setMessages([{...user,conversation_id:other}]);}}>Switch conversation</button>
      <button id="history" onClick={()=>setMessages(items=>[Message.parse({...user,id:crypto.randomUUID(),role:'assistant',sequence:0,content:'Older history'}),...items])}>Prepend history</button>
      <button id="duplicate" onClick={()=>setMessages(items=>items.map(item=>({...item})))}>Duplicate poll</button>
      <button id="hydrate" onClick={()=>{setCursor(null);setMessages([user]);setTimeout(()=>{setMessages([user,Message.parse({...user,id:crypto.randomUUID(),role:'assistant',sequence:2,content:'Hydrated history'})]);setCursor(2);},60);}}>Hydrate history</button>
      <button id="ack" onClick={()=>{const saved=outbox[0];if(saved){setMessages(items=>[...items,Message.parse({...user,...saved,id:crypto.randomUUID(),role:'user',sequence:items.length+1,read_at:null})]);setCursor(messages.length+1);setOutbox([]);}}}>Acknowledge pending</button>
      <button id="long-history" onClick={()=>{setMessages(Array.from({length:30},(_,index)=>Message.parse({...user,id:index===28?user.id:crypto.randomUUID(),role:index%2?'assistant':'user',sequence:index+1,content:'긴 기록입니다. '.repeat(50)})));setCursor(30);}}>Long history</button>
    </nav>
    <div className="assistant-shell"><main className="main-surface"><Chat messages={messages} outbox={outbox} syncedCursor={cursor} selected={selected} task={currentTask} vm={vm} connected={connected} assistantName="Fixture" replyComposing={composing} replyHandoff={handoff} error=""/></main></div>
    <output id="fixture-state" hidden>{JSON.stringify({signal:Boolean(composing),handoff:handoff?.status??null,connected,task:currentTask.id,state:currentTask.state,selected,messages:messages.length,pending:outbox.length})}</output>
  </LazyMotion>;
}
const root=document.getElementById('root');
if(root)createRoot(root).render(<Fixture/>);
