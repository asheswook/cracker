import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Response as ModelResponse, ResponseOutputItem } from 'openai/resources/responses/responses';
import { Runtime } from '../services/daemon/runtime.ts';
import { Journal } from '../services/daemon/journal.ts';
import { ToolExecutor } from '../services/daemon/tools.ts';
import { DaemonEvent, type Assignment, type Message } from '../packages/protocol/index.ts';
import type { Provider, ResponseInputItem } from '../packages/provider/index.ts';

class FinishedJournal extends Journal {
 readonly done=Promise.withResolvers<void>();
 override finish(run:string):void {super.finish(run);this.done.resolve();}
}
const response=(output:ResponseOutputItem[]):ModelResponse=>({id:crypto.randomUUID(),created_at:0,output_text:'',error:null,incomplete_details:null,instructions:null,metadata:null,model:'fixture',object:'response',output,parallel_tool_calls:true,temperature:null,tool_choice:'auto',tools:[],top_p:null,status:'completed'});

for(const mode of ['exhaustion','refusal'] as const)for(const pendingInput of [true,false])test(`${mode} failed receipt ${pendingInput?'consumes racing user input and continues':'terminates without new user input'}`,async()=>{
 // Given actual shell effects, a durable journal, and a server rejecting a stale terminal receipt.
 const directory=await mkdtemp(join(tmpdir(),'failed-receipt-')),effect=join(directory,'effect.txt');
 const journal=new FinishedJournal(join(directory,'journal.sqlite'));
 const now=new Date().toISOString();
 const assignment:Assignment={run_id:crypto.randomUUID(),task:{id:crypto.randomUUID(),conversation_id:crypto.randomUUID(),objective:'fixture',state:'running',reason:null,created_at:now,updated_at:now},messages:[],instructions:'',memory:[]};
 const message:Message={id:crypto.randomUUID(),task_id:assignment.task.id,conversation_id:assignment.task.conversation_id,role:'user',content:'Continue the remaining work',sequence:1,created_at:now,client_message_id:null};
 const events:DaemonEvent[]=[],history:ResponseInputItem[][]=[];
 let assigned=false,queued=false,rejected=0;
 const server=Bun.serve({port:0,async fetch(request){
  const url=new URL(request.url);
  if(url.pathname==='/v1/daemon/extensions')return Response.json({skills:[],servers:[]});
  if(url.pathname==='/v1/daemon/poll'){const next=assigned?null:assignment;assigned=true;return Response.json({assignment:next,commands:[],messages:[]});}
  if(url.pathname==='/v1/daemon/events'){
   const event=DaemonEvent.parse(await request.json());
   if(pendingInput&&!queued&&event.kind==='state'&&event.state==='failed'){queued=true;rejected++;return Response.json({error:{code:'pending_input'}},{status:409});}
   events.push(event);return Response.json({accepted:true});
  }
  if(url.pathname==='/v1/daemon/composing')return Response.json({generation:1});
  return Response.json({messages:queued&&Number(url.searchParams.get('after')??0)<1?[message]:[]});
 }});
 const shell=(id:string):ResponseOutputItem=>({type:'function_call',call_id:id,name:'shell',arguments:JSON.stringify({command:`printf ${id} >> '${effect}'`})});
 const invalid:ResponseOutputItem={type:'function_call',call_id:'rejected',name:'not-offered',arguments:'{}'};
 const refusal:ResponseOutputItem={type:'message',id:'refusal',role:'assistant',status:'completed',content:[{type:'refusal',refusal:'Fixture refusal'}]};
 const final:ResponseOutputItem={type:'message',id:'final',role:'assistant',status:'completed',content:[{type:'output_text',text:'finished',annotations:[]}]};
 const rounds:ResponseOutputItem[][]=mode==='exhaustion'
  ?[[shell('prior')],[invalid],[invalid],[invalid],[invalid],[shell('remaining')],[final]]
  :[[shell('prior')],[refusal],[shell('remaining')],[final]];
 const provider:Provider={respond:async input=>{history.push([...input]);return response(rounds[history.length-1]??[final]);}};
 const runtime=new Runtime({controlUrl:server.url.href,token:'fixture',journal,provider,tools:new ToolExecutor(),artifactRoot:directory,onFailure:()=>{}});
 try{
  // When exhaustion or refusal races with a new user message at the real HTTP receipt boundary.
  await runtime.tick();await journal.done.promise;await runtime.flush();
  // Then only a genuinely new message permits continuation; earlier effects never replay.
  const terminal=events.filter(event=>event.kind==='state').map(event=>[event.run_id,event.state]);
  console.log(JSON.stringify({mode,pendingInput,rejected,rounds:history.length,terminal}));
  expect(rejected).toBe(pendingInput?1:0);
  expect(history).toHaveLength(pendingInput?rounds.length:mode==='exhaustion'?4:2);
  expect(terminal).toEqual([[assignment.run_id,pendingInput?'succeeded':'failed']]);
  expect(await readFile(effect,'utf8')).toBe(pendingInput?'priorremaining':'prior');
  expect(journal.observations.forRun(assignment.run_id).map(item=>item.action_id.split(':').at(-1))).toEqual(pendingInput?['prior','remaining']:['prior']);
  expect(events.filter(event=>event.kind==='input_applied'&&event.message_id===message.id)).toHaveLength(pendingInput?1:0);
  if(pendingInput){
   expect(JSON.stringify(history[mode==='exhaustion'?4:2])).toContain(message.id);
   if(mode==='exhaustion')expect(journal.recoverable(assignment.run_id)?.argumentRepairs).toBe(1);
  }else if(mode==='exhaustion')expect(journal.recoverable(assignment.run_id)?.argumentRepairs).toBe(2);
 }finally{await runtime.stop();journal.close();await server.stop(true);await rm(directory,{recursive:true,force:true});}
});
