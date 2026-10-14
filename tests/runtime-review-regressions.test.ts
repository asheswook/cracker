import { beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import ky, { TimeoutError } from 'ky';
import type { Response as ModelResponse } from 'openai/resources/responses/responses';
import { DaemonEvent, DaemonPoll } from '../packages/protocol';
import { Runtime } from '../services/daemon/runtime';
import { Journal } from '../services/daemon/journal';
import { ToolExecutor } from '../services/daemon/tools';
import { controlFailureAction } from '../services/daemon/control-failure-policy';
import { createBackgroundTask } from '../services/control/repository/common';
import { controlFixture } from './control-fixture';

const f=controlFixture();
beforeEach(async()=>{await f.finishActive();await f.sql`UPDATE assistant.commands SET status='failed' WHERE vm_id=${f.vm} AND status='pending'`;});
function answer():ModelResponse{return {id:crypto.randomUUID(),created_at:0,output_text:'',error:null,incomplete_details:null,instructions:null,metadata:null,model:'fixture',object:'response',output:[],parallel_tool_calls:false,temperature:null,tool_choice:'auto',tools:[],top_p:null,status:'completed'};}
async function accepted(journal:Journal){
  const source=await f.newTask(),id=crypto.randomUUID();
  const headers={authorization:`Bearer ${f.machine}`,'content-type':'application/json','x-daemon-session':id};
  expect((await f.app.request('/v1/daemon/session',{method:'POST',headers,body:JSON.stringify({session_id:id,runs:[]})})).status).toBe(200);
  const run=DaemonPoll.parse(await(await f.app.request('/v1/daemon/poll?view=work',{headers})).json()).assignment;
  if(!run)throw new Error('Missing offer');journal.accept(run);
  return {source,run,headers};
}
for(const state of ['cancelled','unknown'] as const)test(`P1-1 startup retires a stale ${state} acceptance and finishes recovery`,async()=>{
  const root=await mkdtemp('/tmp/agent-par/.review-recovery-'),journal=new Journal(':memory:');
  const {run}=await accepted(journal);await f.sql`UPDATE assistant.runs SET state=${state} WHERE id=${run.run_id}`;await f.sql`UPDATE assistant.tasks SET state=${state} WHERE id=${run.task.id}`;
  const server=Bun.serve({port:0,fetch:f.app.fetch});let calls=0;
  const runtime=new Runtime({sessionProtocol:true,controlUrl:server.url.href,token:f.machine,journal,tools:new ToolExecutor(),artifactRoot:root,provider:{respond:async()=>{calls++;return answer();}}});
  try{await runtime.recover();expect(journal.accepted()).toEqual([]);await runtime.tick(false);expect(calls).toBe(0);}
  finally{await runtime.stop();journal.close();await server.stop(true);await rm(root,{recursive:true,force:true});}
},10000);

test('P1-1 startup applies pending stop before executing a recovered acceptance',async()=>{
  const root=await mkdtemp('/tmp/agent-par/.review-stop-'),journal=new Journal(':memory:'),{source}=await accepted(journal);
  await f.request(`/v1/tasks/${source.task.id}/stop`,f.client,{});const server=Bun.serve({port:0,fetch:f.app.fetch});let calls=0;
  const runtime=new Runtime({sessionProtocol:true,controlUrl:server.url.href,token:f.machine,journal,tools:new ToolExecutor(),artifactRoot:root,provider:{respond:async()=>{calls++;return answer();}}});
  try{await runtime.recover();await Bun.sleep(50);expect(calls).toBe(0);expect(journal.accepted()).toEqual([]);expect((await f.sql`SELECT status FROM assistant.commands WHERE task_id=${source.task.id}`)[0]?.['status']).toBe('applied');}
  finally{await runtime.stop();journal.close();await server.stop(true);await rm(root,{recursive:true,force:true});}
},10000);

test('P1-1 startup applies takeover and ACK before recovered inference starts',async()=>{
  const root=await mkdtemp('/tmp/agent-par/.review-control-'),journal=new Journal(':memory:'),{run}=await accepted(journal),order:string[]=[];
  await f.request(`/v1/vms/${f.vm}/control`,f.client,{kind:'takeover'});
  const server=Bun.serve({port:0,async fetch(request){
    const path=new URL(request.url).pathname,body=path==='/v1/daemon/events'?DaemonEvent.parse(await request.clone().json()):null;
    const result=await f.app.fetch(request);if(result.ok&&body?.kind==='command_ack')order.push('ack');return result;
  }});
  const started=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
  const runtime=new Runtime({sessionProtocol:true,controlUrl:server.url.href,token:f.machine,journal,tools:new ToolExecutor(),artifactRoot:root,provider:{respond:async()=>{order.push(journal.control());started.resolve();await release.promise;return answer();}}});
  try{await runtime.recover();await started.promise;expect(order.slice(0,2)).toEqual(['ack','user']);expect((await f.sql`SELECT state FROM assistant.runs WHERE id=${run.run_id}`)[0]?.['state']).toBe('running');}
  finally{release.resolve();await runtime.stop();journal.close();await server.stop(true);await rm(root,{recursive:true,force:true});}
},10000);

for(const failure of ['ack','poll'] as const)test(`P1-2 production failure decision keeps healthy background inference alive after ${failure} 503`,async()=>{
  const conversation=await f.newConversation();await f.sql.begin(tx=>createBackgroundTask(tx,{workspace:f.workspace,conversation:conversation.id,objective:'Stay alive',origin:'schedule',clientId:crypto.randomUUID()}));
  const root=await mkdtemp('/tmp/agent-par/.review-transient-'),journal=new Journal(':memory:'),started=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let failing=false,aborted=false;
  const server=Bun.serve({port:0,fetch:request=>{
    const path=new URL(request.url).pathname;
    if(failing&&(failure==='poll'?path==='/v1/daemon/poll':path.startsWith('/v1/daemon/accept/')))return new Response('Temporarily unavailable',{status:503});
    return f.app.fetch(request);
  }});
  const runtime=new Runtime({sessionProtocol:true,controlUrl:server.url.href,token:f.machine,journal,tools:new ToolExecutor(),artifactRoot:root,provider:{respond:async(_input,_tools,signal)=>{
    signal.addEventListener('abort',()=>{aborted=true;},{once:true});started.resolve();await Promise.race([release.promise,new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}))]);signal.throwIfAborted();return answer();
  }}});
  try{
    await runtime.tick();await started.promise;await f.newTask();failing=true;
    try{await runtime.tick();}catch(error){if(!(error instanceof Error))throw error;if(await controlFailureAction(error,runtime.controlBarrierFailed())==='disconnect')await runtime.disconnect();}
    expect(aborted).toBe(false);if(failure==='ack')expect(journal.accepted()).toHaveLength(1);
  }finally{failing=false;release.resolve();await runtime.stop();journal.close();await server.stop(true);await rm(root,{recursive:true,force:true});}
},10000);

test('P1-2 main policy retries HTTP/timeout/network failures but disconnects fencing and local barrier failures',async()=>{
  const server=Bun.serve({port:0,fetch:request=>new URL(request.url).pathname==='/fenced'?Response.json({error:{code:'stale_session'}},{status:409}):new Response('Retry',{status:503})});
  try{
    const error=await ky.get(server.url,{retry:0}).then(()=>new Error('Expected failure'),cause=>{if(!(cause instanceof Error))throw cause;return cause;});
    expect(await controlFailureAction(error)).toBe('retry');expect(await controlFailureAction(new TimeoutError(new Request(server.url)))).toBe('retry');
    expect(await controlFailureAction(new TypeError('fetch failed'))).toBe('retry');expect(await controlFailureAction(error,true)).toBe('disconnect');
    const fenced=await ky.get(new URL('/fenced',server.url),{retry:0}).then(()=>new Error('Expected fencing'),cause=>{if(!(cause instanceof Error))throw cause;return cause;});
    expect(await controlFailureAction(fenced)).toBe('exit');
  }finally{await server.stop(true);}
});
