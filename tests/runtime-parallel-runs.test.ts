import { beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Response as ModelResponse } from 'openai/resources/responses/responses';
import { Runtime } from '../services/daemon/runtime';
import { Journal } from '../services/daemon/journal';
import { ToolExecutor } from '../services/daemon/tools';
import { DaemonEvent, DaemonPoll, Message } from '../packages/protocol';
import ky from 'ky';
import { TaskArtifacts } from '../services/daemon/artifacts';
import { backgroundRetry } from '../packages/provider/retry';
import { createBackgroundTask } from '../services/control/repository/common';
import { controlFixture } from './control-fixture';

const f=controlFixture();
beforeEach(()=>f.finishActive());
function answer(text:string,phase:'commentary'|'final_answer'='final_answer'):ModelResponse{
  return {id:crypto.randomUUID(),created_at:0,output_text:'',error:null,incomplete_details:null,instructions:null,metadata:null,model:'fixture',object:'response',output:[{type:'message',id:crypto.randomUUID(),role:'assistant',status:'completed',phase,content:[{type:'output_text',text,annotations:[]}]}],parallel_tool_calls:false,temperature:null,tool_choice:'auto',tools:[],top_p:null,status:'completed'};
}

test('one daemon executes foreground and background concurrently, with per-run budgets and correct reports',async()=>{
  const source=await f.newTask();await f.sql.begin(tx=>createBackgroundTask(tx,{workspace:f.workspace,conversation:source.task.conversation_id,objective:'Concurrent background',origin:'schedule',clientId:crypto.randomUUID()}));
  const root=await mkdtemp(join(tmpdir(),'parallel-runtime-')),journal=new Journal(':memory:');
  const started={foreground:Promise.withResolvers<void>(),background:Promise.withResolvers<void>()},release=Promise.withResolvers<void>(),done=Promise.withResolvers<void>();
  let polls=0,successes=0,peak=0,inFlight=0;const calls={foreground:0,background:0};
  const server=Bun.serve({port:0,async fetch(request){
    const url=new URL(request.url),path=url.pathname;if(path==='/v1/daemon/poll'&&url.searchParams.get('view')!=='commands')polls++;
    const event=path==='/v1/daemon/events'?DaemonEvent.parse(await request.clone().json()):undefined;
    const result=await f.app.fetch(request);if(result.ok&&event?.kind==='state'&&event.state==='succeeded'&&++successes===2)done.resolve();return result;
  }});
  const runtime=new Runtime({sessionProtocol:true,controlUrl:server.url.href,token:f.machine,journal,tools:new ToolExecutor(),artifactRoot:root,provider:{respond:async(_input,_tools,signal,_observer,budget)=>{
    if(!_tools.length)return answer(JSON.stringify({schema_version:1,claims:[]}));
    const lane=budget===backgroundRetry?'background':'foreground';calls[lane]++;
    if(calls[lane]===1){peak=Math.max(peak,++inFlight);started[lane].resolve();await release.promise;signal.throwIfAborted();inFlight--;return answer(`${lane} private progress`,'commentary');}
    return answer(`${lane} final report`);
  }}});
  try{
    await runtime.recover();await runtime.tick();await started.foreground.promise;
    await Promise.all([runtime.tick(),runtime.tick(),runtime.tick()]);await started.background.promise;
    expect(polls).toBe(2);expect(peak).toBe(2);release.resolve();await done.promise;await runtime.flush();
    const messages=Message.array().parse(await f.sql`SELECT * FROM assistant.messages WHERE conversation_id=${source.task.conversation_id} AND role='assistant' ORDER BY sequence`);
    expect(messages.filter(message=>message.hidden).map(message=>message.content)).toEqual(['background private progress']);
    expect(messages.filter(message=>!message.hidden).map(message=>message.content).sort()).toEqual(['background final report','foreground final report','foreground private progress'].sort());
    expect(calls).toEqual({foreground:2,background:2});
    expect(await f.sql`SELECT id FROM assistant.runs WHERE vm_id=${f.vm} AND state='succeeded'`).toHaveLength(2);
  }finally{release.resolve();await runtime.stop();journal.close();await server.stop(true);await rm(root,{recursive:true,force:true});}
},30000);

test('ACK response loss retries the persisted acceptance and executes exactly once',async()=>{
  const source=await f.newTask();const root=await mkdtemp(join(tmpdir(),'parallel-accept-')),journal=new Journal(':memory:'),done=Promise.withResolvers<void>();let lost=false,calls=0;
  const server=Bun.serve({port:0,async fetch(request){
    const path=new URL(request.url).pathname;const event=path==='/v1/daemon/events'?DaemonEvent.parse(await request.clone().json()):undefined;
    const result=await f.app.fetch(request);
    if(path.startsWith('/v1/daemon/accept/')&&!lost&&result.ok){lost=true;return new Response('Lost ACK response',{status:503});}
    if(result.ok&&event?.kind==='state'&&event.state==='succeeded')done.resolve();return result;
  }});
  const runtime=new Runtime({sessionProtocol:true,controlUrl:server.url.href,token:f.machine,journal,tools:new ToolExecutor(),artifactRoot:root,provider:{respond:async(_input,tools)=>{if(!tools.length)return answer(JSON.stringify({schema_version:1,claims:[]}));calls++;return answer('Exactly once');}}});
  try{
    await runtime.tick();expect(calls).toBe(0);expect(journal.accepted()).toHaveLength(1);
    await runtime.tick();await done.promise;await runtime.flush();expect(calls).toBe(1);expect(journal.accepted()).toEqual([]);
    expect(await f.sql`SELECT id FROM assistant.runs WHERE task_id=${source.task.id}`).toHaveLength(1);
  }finally{await runtime.stop();journal.close();await server.stop(true);await rm(root,{recursive:true,force:true});}
},30000);

test('a rejected event cannot starve another run or make its flush wait for the bad event',async()=>{
  const journal=new Journal(':memory:'),bad=crypto.randomUUID(),good=crypto.randomUUID(),delivered:string[]=[];
  const server=Bun.serve({port:0,async fetch(request){const event=DaemonEvent.parse(await request.json());if('run_id' in event&&event.run_id===bad)return Response.json({error:{code:'invalid_event'}},{status:400});delivered.push(event.event_id);return Response.json({accepted:true});}});
  const first={kind:'message',event_id:crypto.randomUUID(),run_id:bad,content:'Rejected'} as const,second={kind:'message',event_id:crypto.randomUUID(),run_id:good,content:'Delivered'} as const;
  journal.enqueue(first);journal.enqueue(second);
  const runtime=new Runtime({controlUrl:server.url.href,token:'fixture',journal,tools:new ToolExecutor(),provider:{respond:async()=>answer('Unused')}});
  try{await runtime.flush(good);expect(delivered).toEqual([second.event_id]);expect(journal.wasRejected(first.event_id)).toBe(true);expect(journal.pending()).toEqual([]);await expect(runtime.flush(bad)).rejects.toThrow('was rejected');}
  finally{await runtime.stop();journal.close();await server.stop(true);}
});

test('a real journal restart resumes a safe foreground checkpoint and quarantines unsafe background effects',async()=>{
  const source=await f.newTask();await f.sql.begin(tx=>createBackgroundTask(tx,{workspace:f.workspace,conversation:source.task.conversation_id,objective:'Unsafe background',origin:'schedule',clientId:crypto.randomUUID()}));
  const root=await mkdtemp(join(tmpdir(),'parallel-restart-')),path=`${root}/journal.sqlite`,done=Promise.withResolvers<void>();
  const server=Bun.serve({port:0,async fetch(request){const event=new URL(request.url).pathname==='/v1/daemon/events'?DaemonEvent.parse(await request.clone().json()):undefined;const result=await f.app.fetch(request);if(result.ok&&event?.kind==='state'&&event.state==='succeeded')done.resolve();return result;}});
  const id=crypto.randomUUID(),control=ky.create({prefixUrl:server.url.href,headers:{authorization:`Bearer ${f.machine}`,'x-daemon-session':id}});
  await control.post('v1/daemon/session',{json:{session_id:id,runs:[]}});
  async function offered(){const run=DaemonPoll.parse(await control.get('v1/daemon/poll?view=work').json()).assignment;if(!run)throw new Error('No offer');await control.post(`v1/daemon/accept/${run.run_id}`,{json:{}});return run;}
  const fg=await offered(),bg=await offered(),first=new Journal(path);
  const artifacts=await TaskArtifacts.create({http:control,runId:fg.run_id,conversationId:fg.task.conversation_id,root});
  for(const message of fg.messages)await control.post('v1/daemon/events',{json:{kind:'input_applied',event_id:crypto.randomUUID(),run_id:fg.run_id,message_id:message.id}});
  first.start(fg.run_id);first.checkpoint({version:1,assignment:fg,input:[{role:'user',content:'Safe historical checkpoint'}],cursor:Math.max(...fg.messages.map(message=>message.sequence)),seenCallIds:[],artifacts:artifacts.checkpoint(),inputTokens:0});
  first.start(bg.run_id);first.begin(bg.run_id,'uncertain-effect');first.close();
  const journal=new Journal(path);let calls=0;
  const runtime=new Runtime({sessionProtocol:true,controlUrl:server.url.href,token:f.machine,journal,tools:new ToolExecutor(),artifactRoot:root,provider:{respond:async(input,tools)=>{if(!tools.length)return answer(JSON.stringify({schema_version:1,claims:[]}));calls++;expect(input).toContainEqual({role:'user',content:'Safe historical checkpoint'});return answer('Resumed safely');}}});
  try{
    await runtime.recover();await done.promise;await runtime.flush();expect(calls).toBe(1);
    expect((await f.sql`SELECT state FROM assistant.runs WHERE id=${fg.run_id}`)[0]?.['state']).toBe('succeeded');
    expect((await f.sql`SELECT state FROM assistant.runs WHERE id=${bg.run_id}`)[0]?.['state']).toBe('unknown');
    expect(journal.interrupted()).toEqual([]);
  }finally{await runtime.stop();journal.close();await server.stop(true);await rm(root,{recursive:true,force:true});}
},30000);

test('stop targets only its foreground run while the background run keeps executing',async()=>{
  const source=await f.newTask();await f.sql.begin(tx=>createBackgroundTask(tx,{workspace:f.workspace,conversation:source.task.conversation_id,objective:'Continue background',origin:'schedule',clientId:crypto.randomUUID()}));
  const root=await mkdtemp(join(tmpdir(),'parallel-stop-')),journal=new Journal(':memory:'),started=Promise.withResolvers<void>(),bgStarted=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),done=Promise.withResolvers<void>();
  let fgAborted=false,bgAborted=false;
  const server=Bun.serve({port:0,async fetch(request){const event=new URL(request.url).pathname==='/v1/daemon/events'?DaemonEvent.parse(await request.clone().json()):undefined;const result=await f.app.fetch(request);if(result.ok&&event?.kind==='state'&&event.state==='succeeded')done.resolve();return result;}});
  const runtime=new Runtime({sessionProtocol:true,controlUrl:server.url.href,token:f.machine,journal,tools:new ToolExecutor(),artifactRoot:root,provider:{respond:async(_input,_tools,signal,_observer,budget)=>{
    if(!_tools.length)return answer(JSON.stringify({schema_version:1,claims:[]}));
    if(budget===backgroundRetry){signal.addEventListener('abort',()=>{bgAborted=true;},{once:true});bgStarted.resolve();await release.promise;signal.throwIfAborted();return answer('Background survived stop');}
    started.resolve();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{fgAborted=true;reject(signal.reason);},{once:true}));
  }}});
  try{
    await runtime.tick();await started.promise;await runtime.tick();await bgStarted.promise;
    expect((await f.request(`/v1/tasks/${source.task.id}/stop`,f.client,{})).status).toBe(200);await runtime.tick();
    expect(fgAborted).toBe(true);expect(bgAborted).toBe(false);expect((await f.sql`SELECT state FROM assistant.tasks WHERE id=${source.task.id}`)[0]?.['state']).toBe('cancelled');
    expect(await f.sql`SELECT id FROM assistant.runs WHERE vm_id=${f.vm} AND lane='background' AND state='running'`).toHaveLength(1);
    release.resolve();await done.promise;await runtime.flush();
  }finally{release.resolve();await runtime.stop();journal.close();await server.stop(true);await rm(root,{recursive:true,force:true});}
},30000);

test('startup executes a journaled acceptance once, without misclassifying it as interrupted work',async()=>{
  await f.newTask();const root=await mkdtemp(join(tmpdir(),'parallel-accepted-restart-')),path=`${root}/journal.sqlite`,done=Promise.withResolvers<void>();
  const server=Bun.serve({port:0,async fetch(request){const event=new URL(request.url).pathname==='/v1/daemon/events'?DaemonEvent.parse(await request.clone().json()):undefined;const result=await f.app.fetch(request);if(result.ok&&event?.kind==='state'&&event.state==='succeeded')done.resolve();return result;}});
  const id=crypto.randomUUID(),control=ky.create({prefixUrl:server.url.href,headers:{authorization:`Bearer ${f.machine}`,'x-daemon-session':id}});
  await control.post('v1/daemon/session',{json:{session_id:id,runs:[]}});
  const work=DaemonPoll.parse(await control.get('v1/daemon/poll?view=work').json()).assignment;if(!work)throw new Error('No offer');
  const first=new Journal(path);first.accept(work);await control.post(`v1/daemon/accept/${work.run_id}`,{json:{}});first.start(work.run_id);expect(first.accepted()).toHaveLength(1);first.close();
  const journal=new Journal(path);let calls=0;
  const runtime=new Runtime({sessionProtocol:true,controlUrl:server.url.href,token:f.machine,journal,tools:new ToolExecutor(),artifactRoot:root,provider:{respond:async(_input,tools)=>{if(!tools.length)return answer(JSON.stringify({schema_version:1,claims:[]}));calls++;return answer('Accepted before restart');}}});
  try{await runtime.recover();await done.promise;await runtime.flush();expect(calls).toBe(1);expect(journal.rejected()).toEqual([]);expect((await f.sql`SELECT state FROM assistant.runs WHERE id=${work.run_id}`)[0]?.['state']).toBe('succeeded');}
  finally{await runtime.stop();journal.close();await server.stop(true);await rm(root,{recursive:true,force:true});}
},30000);

test('terminal ACK loss keeps admission blocked locally until its own terminal receipt is confirmed',async()=>{
  const initial=await f.newTask(),root=await mkdtemp(join(tmpdir(),'parallel-terminal-')),firstFinished=Promise.withResolvers<void>(),secondFinished=Promise.withResolvers<void>(),terminalOffered=Promise.withResolvers<void>();
  class ObservedJournal extends Journal{override finish(run:string){super.finish(run);firstFinished.resolve();}}
  const journal=new ObservedJournal(':memory:');let blocked=true,calls=0;
  const server=Bun.serve({port:0,async fetch(request){const path=new URL(request.url).pathname,event=path==='/v1/daemon/events'?DaemonEvent.parse(await request.clone().json()):undefined;const result=await f.app.fetch(request);
    if(result.ok&&event?.kind==='state'&&event.state==='succeeded'){
      const task=(await f.sql`SELECT task_id FROM assistant.runs WHERE id=${event.run_id}`)[0]?.['task_id'];
      if(task===initial.task.id&&blocked){terminalOffered.resolve();return new Response('Terminal ACK lost',{status:503});}
      if(task!==initial.task.id)secondFinished.resolve();
    }return result;
  }});
  const runtime=new Runtime({sessionProtocol:true,controlUrl:server.url.href,token:f.machine,journal,tools:new ToolExecutor(),artifactRoot:root,onFailure:()=>{return;},provider:{respond:async(_input,tools)=>{if(!tools.length)return answer(JSON.stringify({schema_version:1,claims:[]}));calls++;return answer(`Report ${calls}`);}}});
  try{
    await runtime.tick();await terminalOffered.promise;expect(calls).toBe(1);await f.newTask();
    await expect(runtime.tick()).rejects.toThrow();expect(calls).toBe(1);
    blocked=false;await runtime.flush();await firstFinished.promise;await runtime.tick();await secondFinished.promise;await runtime.flush();expect(calls).toBe(2);
  }finally{blocked=false;await runtime.stop();journal.close();await server.stop(true);await rm(root,{recursive:true,force:true});}
},30000);

test('a finished journal row with only commentary is not trusted as terminal-pending',()=>{
  const journal=new Journal(':memory:'),run=crypto.randomUUID();
  try{journal.start(run);journal.begin(run,'uncertain');journal.enqueue({kind:'message',event_id:crypto.randomUUID(),run_id:run,content:'Private progress',phase:'commentary'});journal.finish(run);
    expect(journal.reconciliation()).toEqual([{run_id:run,phase:'executing',recoverable:false}]);
  }finally{journal.close();}
});
