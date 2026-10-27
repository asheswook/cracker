import { expect, test } from 'bun:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { Runtime } from '../services/daemon/runtime.ts';
import { Journal } from '../services/daemon/journal.ts';
import { ToolExecutor } from '../services/daemon/tools.ts';
import { DaemonEvent, type Assignment, type Message } from '../packages/protocol/index.ts';
import type { Provider, ResponseInputItem } from '../packages/provider/index.ts';
import type { Response, ResponseOutputItem } from 'openai/resources/responses/responses';

class FinishedJournal extends Journal {
 readonly done=Promise.withResolvers<void>();
 override finish(run:string):void {super.finish(run);this.done.resolve();}
}
const response=(output:ResponseOutputItem[]):Response=>({id:crypto.randomUUID(),created_at:0,output_text:'',error:null,incomplete_details:null,instructions:null,metadata:null,model:'fixture',object:'response',output,parallel_tool_calls:true,temperature:null,tool_choice:'auto',tools:[],top_p:null,status:'completed'});

for(const {followUp,uncertainUpload} of [{followUp:false,uncertainUpload:false},{followUp:true,uncertainUpload:false},{followUp:false,uncertainUpload:true}])test(`real thrown tool failure becomes model feedback and preserves effects${followUp?' with pending user input':''}${uncertainUpload?' after an accepted remote write':''}`,async()=>{
 // Given real HTTP control, SQLite, and actual shell/session tools (no executor mock).
 const directory=await mkdtemp(join(tmpdir(),'tool-failure-recovery-')),effect=join(directory,'effects.txt');
 const journal=new FinishedJournal(join(directory,'journal.sqlite'));
 const assignment:Assignment={run_id:crypto.randomUUID(),task:{id:crypto.randomUUID(),conversation_id:crypto.randomUUID(),objective:'fixture',state:'running',reason:null,created_at:new Date().toISOString(),updated_at:new Date().toISOString()},messages:[],instructions:'',memory:[]};
 const message:Message={id:crypto.randomUUID(),task_id:assignment.task.id,conversation_id:assignment.task.conversation_id,role:'user',content:'continue the remaining work',sequence:1,created_at:new Date().toISOString(),client_message_id:null};
 const history:ResponseInputItem[][]=[],events:DaemonEvent[]=[];
 let assigned=false,queued=false,failedCalls=0,uploads=0;
 const failingTool=uncertainUpload?'publish_artifact':'shell_session';
 const control=Bun.serve({port:0,async fetch(request){
  const url=new URL(request.url);
  if(uncertainUpload&&url.pathname.endsWith('/artifacts')&&request.method==='POST'){uploads++;await writeFile(join(directory,'accepted-upload.txt'),await request.text());return new Response('fixture failure after remote write',{status:503});}
  if(url.pathname==='/v1/daemon/extensions')return Response.json({skills:[],servers:[]});
  if(url.pathname==='/v1/daemon/poll'){const next=assigned?null:assignment;assigned=true;return Response.json({assignment:next,commands:[],messages:[]});}
  if(url.pathname==='/v1/daemon/events'){events.push(DaemonEvent.parse(await request.json()));return Response.json({accepted:true});}
  if(url.pathname==='/v1/daemon/composing')return Response.json({generation:1});
  return Response.json({messages:queued&&Number(url.searchParams.get('after')??0)<message.sequence?[message]:[]});
 }});
 const provider:Provider={respond:async input=>{
  history.push([...input]);
  switch(history.length){
   case 1:return response([{type:'function_call',call_id:'prior',name:'shell',arguments:JSON.stringify({command:`printf prior >> '${effect}'; printf artifact > \"$OUTPUT_DIR/result.txt\"`})}]);
    case 2:return response([{type:'function_call',call_id:'failed-call',name:failingTool,arguments:JSON.stringify(uncertainUpload?{path:'result.txt',name:'result.txt',media_type:'text/plain',series:null,change_summary:null,updates:null}:{session_id:crypto.randomUUID(),action:'poll',input:null,yield_ms:0,max_output_chars:1000})}]);
   case 3:return response([{type:'function_call',call_id:'remaining',name:'shell',arguments:JSON.stringify({command:`printf remaining >> '${effect}'`})}]);
   default:return response([{type:'message',id:'final',role:'assistant',status:'completed',content:[{type:'output_text',text:'finished',annotations:[]}]}]);
  }
 }};
 const runtime=new Runtime({controlUrl:control.url.href,token:'fixture',journal,provider,tools:new ToolExecutor(),artifactRoot:directory,onTiming:timing=>{if(timing.kind==='tool'&&timing.tool_name===failingTool&&timing.outcome==='failed'){failedCalls++;queued=followUp;}},onFailure:()=>{}});
 try{
  // When a genuine ShellError is thrown for an unknown session after a prior effect.
  await runtime.tick();await journal.done.promise;await runtime.flush();
  // Then the same run continues from explicit failure feedback without automatic replay.
  expect(events.filter(event=>event.kind==='state').map(event=>[event.run_id,event.state])).toEqual([[assignment.run_id,'succeeded']]);
  expect(history).toHaveLength(4);expect(failedCalls).toBe(1);
  expect(await readFile(effect,'utf8')).toBe('priorremaining');
  const result=history[2]?.find(item=>item.type==='function_call_output'&&item.call_id==='failed-call');
  if(!result||result.type!=='function_call_output')throw new TypeError('Missing failed tool result');
  const feedback=z.object({kind:z.literal('tool_execution_error'),code:z.string(),tool_name:z.string(),call_id:z.string(),effect_uncertain:z.boolean(),executed:z.boolean(),retry_safety:z.string()}).parse(JSON.parse(String(result.output)));
  expect(feedback).toMatchObject({code:uncertainUpload?'publication_http_503':'shell_session_unknown_or_expired',tool_name:failingTool,call_id:'failed-call',effect_uncertain:true,executed:true,retry_safety:'reconcile_before_retry'});
  expect(journal.observations.forRun(assignment.run_id).map(item=>item.action_id.split(':').at(-1))).toEqual(['prior','failed-call','remaining']);
  expect(journal.resumeSafe(assignment.run_id)).toBe(true);
  if(uncertainUpload){expect(uploads).toBe(1);expect(await readFile(join(directory,'accepted-upload.txt'),'utf8')).toBe('artifact');}
  if(followUp){
   expect(events.filter(event=>event.kind==='input_applied'&&event.message_id===message.id)).toHaveLength(1);
   expect(JSON.stringify(history[2])).toContain(message.id);
  }
 }finally{await runtime.stop();journal.close();await control.stop(true);await rm(directory,{recursive:true,force:true});}
});

for(const {resumed,pendingInput} of [{resumed:false,pendingInput:false},{resumed:true,pendingInput:false},{resumed:true,pendingInput:true}])test(`explain-only recovery rejects tool attempts and never replays uncertain source effects${resumed?' via recovery resume':''}${pendingInput?' with pending input at final receipt':''}`,async()=>{
 // Given a distinct recovery run and a source run with an uncertain action and existing file effect.
 const directory=await mkdtemp(join(tmpdir(),'explain-only-recovery-')),effect=join(directory,'original.txt');
 await writeFile(effect,'original');
 const journal=new FinishedJournal(join(directory,'journal.sqlite')),sourceRun=crypto.randomUUID();
 journal.start(sourceRun);journal.begin(sourceRun,`${sourceRun}:uncertain`);
 const assignment:Assignment={run_id:crypto.randomUUID(),task:{id:crypto.randomUUID(),conversation_id:crypto.randomUUID(),objective:'explain prior failure',state:'running',reason:null,created_at:new Date().toISOString(),updated_at:new Date().toISOString()},messages:[],instructions:'',memory:[],recovery:{mode:'explain_only',source_run_id:sourceRun,reason:'uncertain source actions',completed_actions:0,uncertain_actions:1,history_available:false}};
 const events:DaemonEvent[]=[],offeredCounts:number[]=[],failures:unknown[]=[],resumes:unknown[]=[],history:ResponseInputItem[][]=[];let assigned=false,queued=false,rejected=0;
 const followUp:Message={id:crypto.randomUUID(),task_id:assignment.task.id,conversation_id:assignment.task.conversation_id,role:'user',content:'Explain the uncertain result again',sequence:1,created_at:new Date().toISOString(),client_message_id:null};
 const server=Bun.serve({port:0,async fetch(request){
  const path=new URL(request.url).pathname;
  if(path==='/v1/daemon/extensions')return Response.json({skills:[],servers:[]});
  if(path===`/v1/daemon/resume/${sourceRun}`){resumes.push(await request.json());return Response.json({assignment});}
  if(path==='/v1/daemon/poll'){const next=assigned?null:assignment;assigned=true;return Response.json({assignment:resumed?null:next,commands:[],messages:[],...(resumed?{recovery_run_id:sourceRun}:{})});}
  if(path==='/v1/daemon/events'){const event=DaemonEvent.parse(await request.json());if(pendingInput&&!queued&&event.kind==='state'&&event.state==='failed'){queued=true;rejected++;return Response.json({error:{code:'pending_input'}},{status:409});}events.push(event);return Response.json({accepted:true});}
  if(path==='/v1/daemon/composing')return Response.json({generation:1});
  return Response.json({messages:queued&&Number(new URL(request.url).searchParams.get('after')??0)<1?[followUp]:[]});
 }});
 const provider:Provider={respond:async(input,offered)=>{
  history.push([...input]);
  offeredCounts.push(offered.length);
  return offeredCounts.length===1
   ?response([{type:'function_call',call_id:'forbidden-replay',name:'shell',arguments:JSON.stringify({command:`printf replay >> '${effect}'`})}])
   :response([{type:'message',id:'explanation',role:'assistant',status:'completed',content:[{type:'output_text',text:'The prior effect remains uncertain.',annotations:[]}]}]);
 }};
 const runtime=new Runtime({controlUrl:server.url.href,token:'fixture',journal,provider,tools:new ToolExecutor(),artifactRoot:directory,onFailure:failure=>failures.push(failure)});
 try{
  // When a recovery model attempts a tool despite its explanation-only assignment.
  await runtime.tick();await journal.done.promise;await runtime.flush();
  // Then only an explanation is delivered; no run is falsely marked successful.
  console.log(JSON.stringify({scenario:'explain_only',states:events.filter(event=>event.kind==='state'),failures}));
  expect(resumes).toEqual(resumed?[{desktop_control_scoped:true,recovery:{completed_actions:0,uncertain_actions:1,history_available:false}}]:[]);
  expect(offeredCounts).toEqual(pendingInput?[0,0,0]:[0,0]);
  expect(await readFile(effect,'utf8')).toBe('original');
  expect(journal.observations.forRun(assignment.run_id)).toEqual([]);
  expect(events.filter(event=>event.kind==='state').map(event=>[event.run_id,event.state])).toEqual([[assignment.run_id,'failed']]);
  expect(events.filter(event=>event.kind==='message').map(event=>event.content)).toEqual(Array(pendingInput?2:1).fill('The prior effect remains uncertain.'));
  if(pendingInput){expect(rejected).toBe(1);expect(events.filter(event=>event.kind==='input_applied'&&event.message_id===followUp.id)).toHaveLength(1);expect(JSON.stringify(history[2])).toContain(followUp.id);}
  expect(journal.resumeSafe(sourceRun)).toBe(false);
  expect(journal.recoverable(assignment.run_id)?.assignment.recovery).toEqual(assignment.recovery);
 }finally{await runtime.stop();journal.close();await server.stop(true);await rm(directory,{recursive:true,force:true});}
});
