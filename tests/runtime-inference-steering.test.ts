import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import type { Response as ModelResponse, ResponseOutputItem } from 'openai/resources/responses/responses';
import { Runtime } from '../services/daemon/runtime.ts';
import { Journal } from '../services/daemon/journal.ts';
import { ToolExecutor } from '../services/daemon/tools.ts';
import { DaemonEvent, type Assignment, type Message } from '../packages/protocol/index.ts';
import type { Provider, ResponseInputItem } from '../packages/provider/index.ts';
import type { NativeContextState } from '../packages/provider/native-context.ts';
import { fixture as anthropicFixture, message as anthropicMessage, wire } from './anthropic-context-fixture.ts';
import type { RunCheckpoint } from '../services/daemon/active-context.ts';

class FinishedJournal extends Journal {
 readonly done=Promise.withResolvers<void>();
 beforeCheckpoint:((value:RunCheckpoint)=>void)|undefined;
 onCheckpoint:((value:RunCheckpoint)=>void)|undefined;
 override checkpoint(value:RunCheckpoint):void {this.beforeCheckpoint?.(value);super.checkpoint(value);this.onCheckpoint?.(value);}
 override finish(run:string):void {super.finish(run);this.done.resolve();}
}
const response=(output:ResponseOutputItem[]):ModelResponse=>({id:crypto.randomUUID(),created_at:0,output_text:'',error:null,incomplete_details:null,instructions:null,metadata:null,model:'fixture',object:'response',output,parallel_tool_calls:true,temperature:null,tool_choice:'auto',tools:[],top_p:null,status:'completed'});
const final:ResponseOutputItem={type:'message',id:'fresh-final',role:'assistant',status:'completed',content:[{type:'output_text',text:'fresh answer',annotations:[]}]};

async function fixture(options:{readonly native:boolean;readonly postResponse?:boolean}){
 const directory=await mkdtemp(join(tmpdir(),'inference-steering-')),effect=join(directory,'effect.txt');
 const journal=new FinishedJournal(join(directory,'journal.sqlite')),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
 const now=new Date().toISOString(),assignment:Assignment={run_id:crypto.randomUUID(),task:{id:crypto.randomUUID(),conversation_id:crypto.randomUUID(),objective:'fixture',state:'running',reason:null,created_at:now,updated_at:now},messages:[],instructions:'',memory:[]};
 const steering:Message={id:crypto.randomUUID(),task_id:assignment.task.id,conversation_id:assignment.task.conversation_id,role:'user',content:'Use the new request',sequence:1,created_at:now,client_message_id:null};
 const state={queued:false,outage:false},events:DaemonEvent[]=[],history:ResponseInputItem[][]=[],signals:AbortSignal[]=[],ancestry:(NativeContextState|undefined)[]=[],failures:unknown[]=[];
 let assigned=false,contextErrors=0;
 const control=Bun.serve({port:0,async fetch(request){
  const url=new URL(request.url);
  if(url.pathname==='/v1/daemon/extensions')return Response.json({skills:[],servers:[]});
  if(url.pathname==='/v1/daemon/poll'){const next=assigned?null:assignment;assigned=true;return Response.json({assignment:next,commands:[],messages:[]});}
  if(url.pathname===`/v1/daemon/resume/${assignment.run_id}`)return Response.json({assignment});
  if(url.pathname==='/v1/daemon/events'){events.push(DaemonEvent.parse(await request.json()));return Response.json({accepted:true});}
  if(url.pathname==='/v1/daemon/composing')return Response.json({generation:1});
  if(state.outage&&url.pathname===`/v1/daemon/context/${assignment.run_id}`){contextErrors++;return Response.json({error:{code:'unavailable'}},{status:503});}
  return Response.json({messages:state.queued&&Number(url.searchParams.get('after')??0)<1?[steering]:[]});
 }});
 const call=(id:string):Extract<ResponseOutputItem,{type:'function_call'}>=>({type:'function_call',call_id:id,name:'shell',arguments:JSON.stringify({command:`printf ${id} >> '${effect}'`})});
 const stale:ResponseOutputItem[]=[{type:'message',id:'stale-message',role:'assistant',status:'completed',content:[{type:'output_text',text:'stale answer',annotations:[]}]},call('stale')];
 const normal:Provider={respond:async(input,_tools,signal)=>{
  history.push(structuredClone(input));signals.push(signal);
  if(history.length===1)return response([call('prior')]);
  if(history.length===2){entered.resolve();signal.addEventListener('abort',()=>release.resolve(),{once:true});await release.promise;return response(stale);}
  return response([final]);
 }};
 const native=options.native?anthropicFixture({count:()=>100,respond:async(_body,index)=>{
  const blocks=index===1?[{type:'tool_use',id:'prior',name:'shell',input:JSON.parse(call('prior').arguments)}]:index===2?[{type:'thinking',thinking:'stale thought',signature:'stale-signature'},{type:'tool_use',id:'stale',name:'shell',input:JSON.parse(call('stale').arguments)}]:[{type:'text',text:'fresh answer'}];
  const payload=wire(anthropicMessage(blocks,index<3?'tool_use':'end_turn',`native-${index}`));
  if(index===2&&!options.postResponse){
   let cancelled=false;const boundary=payload.indexOf('\n\n')+2,encoder=new TextEncoder();
   return new Response(new ReadableStream<Uint8Array>({start(controller){
    controller.enqueue(encoder.encode(payload.slice(0,boundary)));entered.resolve();
    void release.promise.then(()=>{if(!cancelled){controller.enqueue(encoder.encode(payload.slice(boundary)));controller.close();}});
   },cancel(){cancelled=true;}}),{headers:{'content-type':'text/event-stream'}});
  }
  return new Response(payload,{headers:{'content-type':'text/event-stream'}});
 }}):undefined;
 const nativeContext=native?.provider.nativeContext;
 const provider:Provider=nativeContext?{respond:normal.respond,nativeContext:{
  capability:signal=>nativeContext.capability(signal),measure:request=>nativeContext.measure(request),compact:request=>nativeContext.compact(request),
  respond:async request=>{
   history.push(structuredClone(request.input));signals.push(request.signal);ancestry.push(structuredClone(request.state));
   const result=await nativeContext.respond(request);
   if(history.length===2&&options.postResponse){entered.resolve();await release.promise;}
   return result;
  },
 }}:normal;
 const createRuntime=(resumedJournal=journal)=>new Runtime({controlUrl:control.url.href,token:'fixture',journal:resumedJournal,provider,tools:new ToolExecutor(),artifactRoot:directory,compactThreshold:1000000,onFailure:failure=>failures.push(failure)});
 const runtime=createRuntime();
 return {runtime,createRuntime,journal,journalPath:join(directory,'journal.sqlite'),entered,release,state,events,history,signals,ancestry,failures,assignment,steering,effect,native,contextErrors:()=>contextErrors,close:async()=>{release.resolve();await runtime.stop();journal.close();await control.stop(true);await native?.close();await rm(directory,{recursive:true,force:true});}};
}

for(const native of [false,true])for(const postResponse of [false,true])test(`${native?'native':'ordinary'} inference preserves received context without dispatching stale output on ${postResponse?'response boundary':'mailbox poll interruption'}`,async()=>{
 // Given a completed real shell effect and a second inference held at an asynchronous boundary.
 const f=await fixture({native,postResponse});
 try{
  await f.runtime.tick();await f.entered.promise;
  // When steering arrives while inference is held, or immediately before its completed response is consumed.
  f.state.queued=true;
  if(postResponse)f.release.resolve();else{await f.runtime.tick();expect(f.signals[1]?.aborted).toBe(true);f.release.resolve();}
  await f.journal.done.promise;await f.runtime.flush();
  // Then the same run retains received output, while only the fresh answer and prior tool effect are delivered.
  expect(f.history).toHaveLength(3);expect(f.signals[2]?.aborted).toBe(false);
  expect(JSON.stringify(f.history[2])).toContain(f.steering.id);
  expect(f.events.filter(event=>event.kind==='input_applied'&&event.message_id===f.steering.id)).toHaveLength(1);
  expect(f.events.filter(event=>event.kind==='state').map(event=>[event.run_id,event.state])).toEqual([[f.assignment.run_id,'succeeded']]);
  expect(f.events.filter(event=>event.kind==='message').map(event=>event.content)).toEqual(['fresh answer']);
  expect(await readFile(f.effect,'utf8')).toBe('prior');
  expect(f.journal.observations.forRun(f.assignment.run_id).map(item=>item.action_id.split(':').at(-1))).toEqual(['prior']);
  expect(f.failures).toEqual([]);
  if(!native||postResponse){
   const skipped=f.history[2]?.find(item=>item.type==='function_call_output'&&item.call_id==='stale');
   expect(skipped?.type==='function_call_output'&&typeof skipped.output==='string'?JSON.parse(skipped.output):null).toMatchObject({executed:false,error:{code:'interrupted_before_execution'}});
  }
  if(native){
   if(postResponse)expect(JSON.stringify(f.native?.requests[2])).toContain('stale-signature');
   else {expect(f.ancestry[2]).toEqual(f.ancestry[1]);expect(JSON.stringify(f.native?.requests[2])).not.toContain('stale-signature');}
  }
 }finally{await f.close();}
});

test('native continuation survives a restart before the new input is applied',async()=>{
 const f=await fixture({native:true,postResponse:true}),saved=Promise.withResolvers<void>();
 let stopping:Promise<void>|undefined,resumed:Runtime|undefined,resumedJournal:FinishedJournal|undefined;
 f.journal.onCheckpoint=value=>{
  const tail=value.input.at(-1);
  if(tail&&'role'in tail&&tail.role==='user'&&'content'in tail&&typeof tail.content==='string'&&tail.content.startsWith('{"kind":"inference_interrupted"')){
   f.journal.onCheckpoint=undefined;stopping=f.runtime.stop();saved.resolve();
  }
 };
 try{
  await f.runtime.tick();await f.entered.promise;
  f.state.queued=true;f.release.resolve();await saved.promise;await stopping;
  resumedJournal=new FinishedJournal(f.journalPath);
  const checkpoint=resumedJournal.recoverable(f.assignment.run_id);
  expect(checkpoint?.cursor).toBe(0);expect(checkpoint?.seenCallIds).toContain('stale');
  expect(JSON.stringify(checkpoint?.nativeContext)).toContain('stale-signature');
  resumed=f.createRuntime(resumedJournal);await resumed.recover();await resumedJournal.done.promise;await resumed.flush();
  expect(JSON.stringify(f.native?.requests[2])).toContain('stale-signature');
  expect(f.history[2]?.filter(item=>item.type==='function_call_output'&&item.call_id==='stale')).toHaveLength(1);
  expect(f.events.filter(event=>event.kind==='input_applied'&&event.message_id===f.steering.id)).toHaveLength(1);
  expect(await readFile(f.effect,'utf8')).toBe('prior');expect(f.failures).toEqual([]);
 }finally{f.journal.onCheckpoint=undefined;await resumed?.stop();resumedJournal?.close();await f.close();}
});

test('transient mailbox probe failure keeps held inference alive until a later steering poll',async()=>{
 // Given a provider call held after a completed shell effect.
 const f=await fixture({native:false});
 try{
  await f.runtime.tick();await f.entered.promise;
  // When only the readonly mailbox probe temporarily fails, followed by a healthy poll with steering.
  f.state.outage=true;await f.runtime.tick();
  expect(f.contextErrors()).toBeGreaterThan(0);expect(f.signals[1]?.aborted).toBe(false);expect(f.failures).toEqual([]);
  f.state.outage=false;f.state.queued=true;await f.runtime.tick();expect(f.signals[1]?.aborted).toBe(true);
  await f.journal.done.promise;await f.runtime.flush();
  // Then no provider failure is fabricated and no completed effect is replayed.
  expect(f.history).toHaveLength(3);expect(await readFile(f.effect,'utf8')).toBe('prior');expect(f.failures).toEqual([]);
  expect(f.events.filter(event=>event.kind==='state').map(event=>event.state)).toEqual(['succeeded']);
 }finally{await f.close();}
});

test('continuation checkpoint failure is reported instead of swallowed as steering',async()=>{
 const f=await fixture({native:false});
 f.journal.beforeCheckpoint=value=>{
  const tail=value.input.at(-1);
  if(tail&&'role'in tail&&tail.role==='user'&&'content'in tail&&typeof tail.content==='string'&&tail.content.startsWith('{"kind":"inference_interrupted"')){
   f.journal.beforeCheckpoint=undefined;throw new Error('fixture storage failure');
  }
 };
 try{
  await f.runtime.tick();await f.entered.promise;f.state.queued=true;await f.runtime.tick();
  await f.journal.done.promise;await f.runtime.flush();
  expect(f.history).toHaveLength(2);expect(f.failures).toHaveLength(1);
  expect(f.events.filter(event=>event.kind==='state').map(event=>event.state)).not.toContain('succeeded');
  expect(await readFile(f.effect,'utf8')).toBe('prior');
 }finally{f.journal.beforeCheckpoint=undefined;await f.close();}
});

test('explicit stop still aborts held inference without dispatching its late result',async()=>{
 // Given held inference after a completed shell effect.
 const f=await fixture({native:false});
 try{
  await f.runtime.tick();await f.entered.promise;
  // When the entire runtime is explicitly stopped.
  await f.runtime.stop();
  // Then provider cancellation remains effective and stale tool effects never execute.
  expect(f.signals[1]?.aborted).toBe(true);expect(f.history).toHaveLength(2);
  expect(await readFile(f.effect,'utf8')).toBe('prior');expect(f.events.filter(event=>event.kind==='state')).toEqual([]);
 }finally{await f.close();}
});

test('new input interrupts held semantic selection before main inference',async()=>{
 // Given semantic preparation awaiting a metadata provider response for the initial input.
 const directory=await mkdtemp(join(tmpdir(),'semantic-steering-')),journal=new FinishedJournal(join(directory,'journal.sqlite'));
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),now=new Date().toISOString();
 const assignment:Assignment={run_id:crypto.randomUUID(),task:{id:crypto.randomUUID(),conversation_id:crypto.randomUUID(),objective:'fixture',state:'running',reason:null,created_at:now,updated_at:now},messages:[],instructions:'',memory:[],semantic_context_enabled:true};
 const first:Message={id:crypto.randomUUID(),task_id:assignment.task.id,conversation_id:assignment.task.conversation_id,role:'user',content:'First input',sequence:1,created_at:now,client_message_id:null};
 const second:Message={...first,id:crypto.randomUUID(),content:'Second input',sequence:2};
 assignment.messages=[first];
 const events:DaemonEvent[]=[],history:ResponseInputItem[][]=[],metadataSignals:AbortSignal[]=[],failures:unknown[]=[];
 let assigned=false,queued=false;
 const server=Bun.serve({port:0,async fetch(request){
  const url=new URL(request.url);
  if(url.pathname==='/v1/daemon/extensions')return Response.json({skills:[],servers:[]});
  if(url.pathname==='/v1/daemon/poll'){const next=assigned?null:assignment;assigned=true;return Response.json({assignment:next,commands:[],messages:[]});}
  if(url.pathname==='/v1/daemon/events'){events.push(DaemonEvent.parse(await request.json()));return Response.json({accepted:true});}
  if(url.pathname==='/v1/daemon/composing')return Response.json({generation:1});
  if(url.pathname.endsWith('/semantic/prepare')){
   const body=z.object({message_id:z.uuid()}).parse(await request.json());
   const source=body.message_id===second.id?second:first;
   return Response.json({source:{message_id:source.id,task_id:source.task_id,sequence:source.sequence,role:source.role,content:source.content,truncated:false,sha256:'a'.repeat(64),attachments:[],retention_allowed:!queued},retention_context:{sources:[],decisions:[]},neighbors:[],candidates:[],linked:null,history:{messages:[],next_after_sequence:null,has_more:false}});
  }
  return Response.json({messages:queued&&Number(url.searchParams.get('after')??0)<2?[second]:[]});
 }});
 const provider:Provider={respond:async(input,tools,signal)=>{
  if(tools.length===1&&tools[0]?.type==='function'&&tools[0].name==='select_semantic_context'){
   metadataSignals.push(signal);entered.resolve();signal.addEventListener('abort',()=>release.resolve(),{once:true});await release.promise;signal.throwIfAborted();
   return response([{type:'function_call',call_id:'selection',name:'select_semantic_context',arguments:JSON.stringify({context_id:null,title:'Fixture',scope:'Fixture',confirmed:true})}]);
  }
  history.push(structuredClone(input));return response([final]);
 }};
 const runtime=new Runtime({controlUrl:server.url.href,token:'fixture',journal,provider,tools:new ToolExecutor(),artifactRoot:directory,onFailure:failure=>failures.push(failure)});
 try{
  await runtime.tick();await entered.promise;
  // When a fresh user input reaches the readonly poll during semantic selection.
  queued=true;await runtime.tick();expect(metadataSignals[0]?.aborted).toBe(true);
  await journal.done.promise;await runtime.flush();
  // Then main inference sees both acknowledged inputs once, with no false run failure.
  expect(history).toHaveLength(1);expect(JSON.stringify(history[0])).toContain(second.id);
  expect(events.filter(event=>event.kind==='input_applied').map(event=>event.message_id)).toEqual([first.id,second.id]);
  expect(events.filter(event=>event.kind==='state').map(event=>event.state)).toEqual(['succeeded']);expect(failures).toEqual([]);
 }finally{release.resolve();await runtime.stop();journal.close();await server.stop(true);await rm(directory,{recursive:true,force:true});}
});
