import { beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import ky from 'ky';
import type { Response as ModelResponse } from 'openai/resources/responses/responses';
import { Runtime } from '../services/daemon/runtime';
import { Journal } from '../services/daemon/journal';
import { ToolExecutor } from '../services/daemon/tools';
import { DaemonEvent } from '../packages/protocol';
import { controlFailureAction } from '../services/daemon/control-failure-policy';
import { controlBoundary } from '../services/daemon/control-boundary';
import { controlFixture } from './control-fixture';

const f=controlFixture();beforeEach(()=>f.finishActive());
function answer():ModelResponse{return {id:crypto.randomUUID(),created_at:0,output_text:'',error:null,incomplete_details:null,instructions:null,metadata:null,model:'fixture',object:'response',output:[{type:'message',id:crypto.randomUUID(),role:'assistant',status:'completed',phase:'final_answer',content:[{type:'output_text',text:'Completed after recovery',annotations:[]}]}],parallel_tool_calls:false,temperature:null,tool_choice:'auto',tools:[],top_p:null,status:'completed'};}
for(const boundary of ['context','receipt'] as const)test(`P1-B ${boundary} 503 inside a run waits without restarting inference or terminating unknown`,async()=>{
  const source=await f.newTask(),root=await mkdtemp('/tmp/agent-par/.control-boundary-'),finished=Promise.withResolvers<void>();
  class ObservedJournal extends Journal{override finish(run:string){super.finish(run);finished.resolve();}}
  const journal=new ObservedJournal(':memory:');let contexts=0,calls=0,failed=false;const states:string[]=[],messageIds:string[]=[];
  const server=Bun.serve({port:0,async fetch(request){
    const path=new URL(request.url).pathname;
    if(path.startsWith('/v1/daemon/context/')&&++contexts===2&&boundary==='context'){failed=true;return new Response('Context temporarily unavailable',{status:503});}
    if(path==='/v1/daemon/events'){
      const event=DaemonEvent.parse(await request.clone().json());
      if(event.kind==='message'){messageIds.push(event.event_id);if(boundary==='receipt'&&!failed){failed=true;return new Response('Receipt temporarily unavailable',{status:503});}}
      if(event.kind==='state')states.push(event.state);
    }
    return f.app.fetch(request);
  }});
  const runtime=new Runtime({sessionProtocol:true,controlUrl:server.url.href,token:f.machine,journal,tools:new ToolExecutor(),artifactRoot:root,provider:{respond:async(_input,tools)=>{if(tools.length)calls++;return answer();}}});
  try{
    await runtime.tick();await finished.promise;await runtime.flush();expect(failed).toBe(true);expect(calls).toBe(1);expect(states).toEqual(['succeeded']);
    expect((await f.sql`SELECT state FROM assistant.tasks WHERE id=${source.task.id}`)[0]?.['state']).toBe('succeeded');
    expect(await f.sql`SELECT id FROM assistant.messages WHERE task_id=${source.task.id} AND role='assistant'`).toHaveLength(1);
    if(boundary==='receipt')expect(new Set(messageIds).size).toBe(1);
  }finally{await runtime.stop();journal.close();await server.stop(true);await rm(root,{recursive:true,force:true});}
},10000);

test('P1-B retry waits are abortable and do not replay a completed tool effect',async()=>{
  const source=await f.newTask(),root=await mkdtemp('/tmp/agent-par/.effect-boundary-'),journal=new Journal(':memory:'),done=Promise.withResolvers<void>();let contexts=0,calls=0,effects=0;
  class OnceTool extends ToolExecutor{override async run(){effects++;return {text:'Effect completed once'};}}
  const server=Bun.serve({port:0,async fetch(request){
    const path=new URL(request.url).pathname;if(path.startsWith('/v1/daemon/context/')&&++contexts===3)return new Response('Retry after completed effect',{status:503});
    const event=path==='/v1/daemon/events'?DaemonEvent.parse(await request.clone().json()):undefined;
    const response=await f.app.fetch(request);if(response.ok&&event?.kind==='state'&&event.state==='succeeded')done.resolve();return response;
  }});
  const runtime=new Runtime({sessionProtocol:true,controlUrl:server.url.href,token:f.machine,journal,tools:new OnceTool(),artifactRoot:root,provider:{respond:async(_input,tools)=>{if(!tools.length)return answer();calls++;const result=answer();return calls===1?{...result,output:[{type:'function_call',call_id:'one-effect',name:'shell',arguments:'{"command":"effect"}'}]}:result;}}});
  try{await runtime.tick();await done.promise;expect(effects).toBe(1);expect(calls).toBe(2);expect((await f.sql`SELECT state FROM assistant.tasks WHERE id=${source.task.id}`)[0]?.['state']).toBe('succeeded');}
  finally{await runtime.stop();journal.close();await server.stop(true);await rm(root,{recursive:true,force:true});}
  const abort=new AbortController(),waiting=Promise.withResolvers<void>();let attempts=0;
  const outage=Bun.serve({port:0,fetch:()=>new Response('Outage',{status:503})});
  try{
    const work=controlBoundary(abort.signal,async()=>{attempts++;return ky.get(outage.url,{retry:0});},()=>waiting.resolve());
    await waiting.promise;abort.abort(new Error('Stopped during backoff'));await expect(work).rejects.toThrow();await Bun.sleep(300);expect(attempts).toBe(1);
  }finally{await outage.stop(true);}
},10000);

test('P1-B aborting one receipt waiter leaves the shared writer and the other run unaffected',async()=>{
  const journal=new Journal(':memory:'),a=crypto.randomUUID(),b=crypto.randomUUID(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),delivered:string[]=[];
  journal.enqueue({kind:'message',event_id:crypto.randomUUID(),run_id:a,content:'A'});journal.enqueue({kind:'message',event_id:crypto.randomUUID(),run_id:b,content:'B'});
  const server=Bun.serve({port:0,async fetch(request){const event=DaemonEvent.parse(await request.json());entered.resolve();await release.promise;if('run_id' in event&&event.run_id)delivered.push(event.run_id);return Response.json({accepted:true});}});
  const runtime=new Runtime({controlUrl:server.url.href,token:'fixture',journal,tools:new ToolExecutor(),provider:{respond:async()=>answer()}}),abort=new AbortController();
  try{
    const waitingA=controlBoundary(abort.signal,()=>runtime.flush(a));await entered.promise;
    const waitingB=controlBoundary(new AbortController().signal,()=>runtime.flush(b));
    abort.abort(new Error('Stop only A'));await expect(waitingA).rejects.toThrow('Stop only A');
    release.resolve();await waitingB;expect(delivered).toEqual([a,b]);expect(journal.pending()).toEqual([]);
  }finally{release.resolve();await runtime.stop();journal.close();await server.stop(true);}
});

test('P1-B permanent control errors escape the boundary without retry',async()=>{
  let attempts=0,retries=0;const server=Bun.serve({port:0,fetch:()=>{attempts++;return Response.json({error:{code:'forbidden'}},{status:403});}});
  try{await expect(controlBoundary(new AbortController().signal,()=>ky.get(server.url,{retry:0}),()=>{retries++;})).rejects.toThrow();expect(attempts).toBe(1);expect(retries).toBe(0);}
  finally{await server.stop(true);}
});

for(const status of [401,403,409])test(`P2-D production policy exits for ${status} ${status===409?'stale_session':'credential rejection'}`,async()=>{
  const server=Bun.serve({port:0,fetch:()=>Response.json({error:{code:status===409?'stale_session':'unauthorized'}},{status})});
  try{const error=await ky.get(server.url,{retry:0}).then(()=>new Error('Expected error'),cause=>{if(!(cause instanceof Error))throw cause;return cause;});expect(await controlFailureAction(error)).toBe('exit');}
  finally{await server.stop(true);}
});

test('P2-D production process logs registration retry, then exits non-zero for a fenced credential',async()=>{
  const root=await mkdtemp('/tmp/agent-par/.main-boundary-');let registrations=0;
  const server=Bun.serve({port:0,fetch:request=>{
    if(new URL(request.url).pathname!=='/v1/daemon/session')throw new Error('No work or external requests may start');
    registrations++;return registrations===1?new Response('Registration temporarily unavailable',{status:503}):Response.json({error:{code:'stale_session'}},{status:409});
  }});
  const child=Bun.spawn(['bun','services/daemon/main.ts'],{cwd:'/tmp/agent-par',env:{PATH:process.env['PATH'],CONTROL_URL:server.url.href,VM_TOKEN:'fixture',PROVIDER_MODE:'api',OPENAI_MODEL:'fixture',OPENAI_API_KEY:'fixture',SCREEN_ENABLED:'false',JOURNAL_PATH:`${root}/journal.sqlite`},stdout:'pipe',stderr:'pipe'});
  const stdout=new Response(child.stdout).text(),stderr=new Response(child.stderr).text();
  try{
    const exit=await Promise.race([child.exited,Bun.sleep(6000).then(()=>null)]);expect(exit).not.toBeNull();expect(exit).not.toBe(0);
    const output=(await stdout)+(await stderr);expect(output).toContain('daemon.registration_retry');expect(registrations).toBe(2);
  }finally{child.kill('SIGTERM');await child.exited;await server.stop(true);await rm(root,{recursive:true,force:true});}
},10000);
