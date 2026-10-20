import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import OpenAI from 'openai';
import { z } from 'zod';
import { Runtime } from '../services/daemon/runtime.ts';
import { Journal } from '../services/daemon/journal.ts';
import { ToolExecutor } from '../services/daemon/tools.ts';
import { DaemonEvent, type Assignment } from '../packages/protocol/index.ts';
import type { Provider, ResponseInputItem } from '../packages/provider/index.ts';
import type { Response, ResponseOutputItem } from 'openai/resources/responses/responses';
import { stripRecentImages } from '../services/daemon/rejected-request.ts';

class FinishedJournal extends Journal {
 readonly done=Promise.withResolvers<void>();
 override finish(run:string):void {super.finish(run);this.done.resolve();}
}
class Screenshots extends ToolExecutor {
 calls=0;
 override async run(){this.calls++;return {text:'screenshot saved',images:['data:image/png;base64,HUGE']};}
}
const response=(output:ResponseOutputItem[]):Response=>({id:crypto.randomUUID(),created_at:0,output_text:'',error:null,incomplete_details:null,instructions:null,metadata:null,model:'fixture',object:'response',output,parallel_tool_calls:true,temperature:null,top_p:null,tool_choice:'auto',tools:[],status:'completed'});
const images=(input:readonly ResponseInputItem[])=>input.flatMap(item=>'content' in item&&Array.isArray(item.content)?item.content.flatMap(part=>part.type==='input_image'?[part.image_url]:[]):[]);
const badRequest=()=>new OpenAI.BadRequestError(400,{type:'invalid_request_error',message:'fixture'},'fixture',new Headers());

async function harness(provider:Provider){
 const directory=await mkdtemp(join(tmpdir(),'rejected-request-'));
 const journal=new FinishedJournal(join(directory,'journal.sqlite'));
 const assignment:Assignment={run_id:crypto.randomUUID(),task:{id:crypto.randomUUID(),conversation_id:crypto.randomUUID(),objective:'look at the page',state:'running',reason:null,created_at:new Date().toISOString(),updated_at:new Date().toISOString()},messages:[],instructions:'',memory:[]};
 const events:DaemonEvent[]=[];let assigned=false;
 const control=Bun.serve({port:0,async fetch(request){
  const url=new URL(request.url);
  if(url.pathname==='/v1/daemon/extensions')return Response.json({skills:[],servers:[]});
  if(url.pathname==='/v1/daemon/poll'){const next=assigned?null:assignment;assigned=true;return Response.json({assignment:next,commands:[],messages:[]});}
  if(url.pathname==='/v1/daemon/events'){events.push(DaemonEvent.parse(await request.json()));return Response.json({accepted:true});}
  if(url.pathname==='/v1/daemon/composing')return Response.json({generation:1});
  return Response.json({messages:[]});
 }});
 const tools=new Screenshots();
 const runtime=new Runtime({controlUrl:control.url.href,token:'fixture',journal,provider,tools,artifactRoot:directory});
 return {assignment,events,journal,tools,run:async()=>{await runtime.tick();await journal.done.promise;await runtime.flush();},
  close:async()=>{await runtime.stop();journal.close();await control.stop(true);await rm(directory,{recursive:true,force:true});}};
}

test('a rejected request removes the new image, tells the model, and the same run continues', async () => {
 // Given a provider that rejects any request still carrying the oversized screenshot.
 const history:ResponseInputItem[][]=[];
 const provider:Provider={respond:async input=>{
  history.push(structuredClone(input));
  if(images(input).length)throw badRequest();
  if(history.length===1)return response([{type:'function_call',call_id:'shot',name:'shell',arguments:JSON.stringify({command:'true'})}]);
  return response([{type:'message',id:'final',role:'assistant',status:'completed',content:[{type:'output_text',text:'read it via snapshot',annotations:[]}]}]);
 }};
 const h=await harness(provider);
 try{
  // When the screenshot result makes the next request fail with HTTP 400.
  await h.run();
  // Then the run succeeds without replaying the tool, and the model saw explicit feedback.
  expect(h.events.filter(event=>event.kind==='state').map(event=>event.kind==='state'?event.state:null)).toEqual(['succeeded']);
  expect(h.tools.calls).toBe(1);
  expect(history).toHaveLength(3);
  expect(images(history[1]!)).toHaveLength(1);
  expect(images(history[2]!)).toHaveLength(0);
  const feedback=history[2]!.flatMap(item=>'content' in item&&typeof item.content==='string'&&item.content.includes('provider_request_rejected')?[item.content]:[]);
  expect(feedback).toHaveLength(1);
  expect(z.object({kind:z.literal('provider_request_rejected'),http_status:z.literal(400),removed_images:z.literal(1),executed_calls:z.literal(0)}).passthrough().parse(JSON.parse(feedback[0]!))).toBeTruthy();
  expect(history[2]!.some(item=>item.type==='function_call_output'&&item.call_id==='shot')).toBe(true);
 }finally{await h.close();}
});

test('a request the provider keeps rejecting stops after two regenerations', async () => {
 // Given a provider that rejects every request.
 let attempts=0;
 const provider:Provider={respond:async()=>{attempts++;throw badRequest();}};
 const h=await harness(provider);
 try{
  // When the run starts.
  await h.run();
  // Then it tries the original plus two corrected requests, then reports an unresolved failure.
  expect(attempts).toBe(3);
  expect(h.events.filter(event=>event.kind==='state').map(event=>event.kind==='state'?event.state:null)).toEqual(['unknown']);
 }finally{await h.close();}
});

test('stripRecentImages only removes images added after the last accepted response', () => {
 const image=(url:string):ResponseInputItem=>({role:'user',content:[{type:'input_image',image_url:url,detail:'original'}]});
 const input:ResponseInputItem[]=[image('old'),{role:'user',content:'text'},image('new1'),image('new2')];
 expect(stripRecentImages(input,2)).toBe(2);
 expect(images(input)).toEqual(['old']);
});

test('a checkpoint resumed with an already-attached oversized image recovers by removing it', async () => {
 // Given a recoverable checkpoint whose last tool result already carries the image the provider rejects.
 const directory=await mkdtemp(join(tmpdir(),'rejected-checkpoint-'));
 const assignment:Assignment={run_id:crypto.randomUUID(),task:{id:crypto.randomUUID(),conversation_id:crypto.randomUUID(),objective:'look at the page',state:'running',reason:null,created_at:new Date().toISOString(),updated_at:new Date().toISOString()},messages:[],instructions:'',memory:[]};
 const control=Bun.serve({port:0,fetch(request){const path=new URL(request.url).pathname;return Response.json(path==='/v1/daemon/extensions'?{skills:[],servers:[]}:path.includes('/resume/')?{assignment}:{messages:[],accepted:true});}});
 const path=join(directory,'journal.sqlite');
 const seed=new Journal(path);seed.start(assignment.run_id);
 const { TaskArtifacts } = await import('../services/daemon/artifacts.ts');
 const ky=(await import('ky')).default;
 const artifacts=await TaskArtifacts.create({http:ky.create({prefixUrl:control.url.href}),runId:assignment.run_id,conversationId:assignment.task.conversation_id,root:directory});
 seed.checkpoint({version:1,assignment,input:[{role:'user',content:'look'},{type:'function_call',call_id:'shot',name:'shell',arguments:'{}'},{type:'function_call_output',call_id:'shot',output:'saved'},{role:'user',content:[{type:'input_image',image_url:'data:image/png;base64,HUGE',detail:'original'}]}],toolImageIndexes:[],cursor:0,seenCallIds:['shot'],artifacts:artifacts.checkpoint(),inputTokens:0});seed.close();
 const journal=new FinishedJournal(path),history:ResponseInputItem[][]=[];
 const provider:Provider={respond:async input=>{history.push(structuredClone(input));if(images(input).length)throw badRequest();return response([{type:'message',id:'final',role:'assistant',status:'completed',content:[{type:'output_text',text:'done',annotations:[]}]}]);}};
 const runtime=new Runtime({controlUrl:control.url.href,token:'fixture',journal,provider,tools:new Screenshots(),artifactRoot:directory});
 try{
  // When the run is recovered.
  await runtime.recover();await journal.done.promise;await runtime.flush();
  // Then the second request no longer carries the image and the run finishes.
  expect(history).toHaveLength(2);
  expect(images(history[0]!)).toHaveLength(1);
  expect(images(history[1]!)).toHaveLength(0);
 }finally{await runtime.stop();journal.close();await control.stop(true);await rm(directory,{recursive:true,force:true});}
});
