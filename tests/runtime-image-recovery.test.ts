import { test, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import ky from 'ky';
import type { Response } from 'openai/resources/responses/responses';
import type { Assignment } from '../packages/protocol/index.ts';
import type { Provider, ResponseInputItem } from '../packages/provider/index.ts';
import { Runtime } from '../services/daemon/runtime.ts';
import { Journal } from '../services/daemon/journal.ts';
import { TaskArtifacts } from '../services/daemon/artifacts.ts';
import { ToolExecutor } from '../services/daemon/tools.ts';
class RecoveryJournal extends Journal { readonly finished=Promise.withResolvers<void>(); override finish(run:string){super.finish(run);this.finished.resolve();} }
class Frames extends ToolExecutor { count=0; override async run(){return {text:'capture',images:[`new${++this.count}`]};} }
const frame=(value:string):ResponseInputItem=>({role:'user',content:[{type:'input_image',image_url:value,detail:'original'}]});
for(const compact of [false,true])test(`recovered desktop frames remain bounded across subsequent captures; compaction=${compact}`,async()=>{
 const root=await mkdtemp(join(tmpdir(),'frame-recovery-')),path=join(root,'journal.sqlite');
 const assignment:Assignment={run_id:crypto.randomUUID(),task:{id:crypto.randomUUID(),conversation_id:crypto.randomUUID(),objective:'fixture',state:'running',reason:null,created_at:new Date().toISOString(),updated_at:new Date().toISOString()},messages:[],instructions:'',memory:[]};
 const server=Bun.serve({port:0,fetch(request){const path=new URL(request.url).pathname;return Response.json(path==='/v1/daemon/extensions'?{skills:[],servers:[]}:path.includes('/resume/')?{assignment}:{messages:[],accepted:true});}});
 const artifacts=await TaskArtifacts.create({http:ky.create({prefixUrl:server.url.href}),runId:assignment.run_id,conversationId:assignment.task.conversation_id,root});
 const initial=new Journal(path);initial.start(assignment.run_id);
 initial.checkpoint({version:1,assignment,input:[frame('same'),frame('same'),frame('old')],toolImageIndexes:[1,2],cursor:0,seenCallIds:[],artifacts:artifacts.checkpoint(),inputTokens:0});initial.close();
 const journal=new RecoveryJournal(path),history:ResponseInputItem[][]=[];
 const provider:Provider={
  compact:async(input)=>[...input.filter(item=>'role' in item&&item.role==='user'),{type:'compaction',encrypted_content:'fixture'}],
  respond:async(input)=>{history.push(structuredClone(input));const round=history.length;const output:Response['output']=round<=3?[{type:'function_call',call_id:`capture${round}`,name:'computer_exec',arguments:JSON.stringify({code:'await desktop.screenshot()',timeout_ms:1000})}]:[{type:'message',id:'done',role:'assistant',status:'completed',phase:'final_answer',content:[{type:'output_text',text:'done',annotations:[]}]}];return {id:crypto.randomUUID(),object:'response',created_at:0,output,output_text:'',model:'fixture',error:null,incomplete_details:null,instructions:null,metadata:null,parallel_tool_calls:false,temperature:null,top_p:null,tool_choice:'auto',tools:[],status:'completed'};},
 };
 const runtime=new Runtime({controlUrl:server.url.href,token:'fixture',journal,provider,tools:new Frames(),artifactRoot:root,compactThreshold:compact?1:64000});
 try{await runtime.recover();await journal.finished.promise;await runtime.flush();
 const urls=history.map(input=>input.flatMap(item=>'content' in item&&Array.isArray(item.content)?item.content.flatMap(part=>part.type==='input_image'?[part.image_url]:[]):[]));
 expect(urls).toEqual([['same','same','old'],['same','old','new1'],['same','new1','new2'],['same','new2','new3']]);
 expect(journal.recoverable(assignment.run_id)?.toolImageIndexes).toHaveLength(2);
 }finally{await runtime.stop();journal.close();await server.stop(true);await rm(root,{recursive:true,force:true});}
});
