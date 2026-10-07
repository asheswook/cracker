import {test,expect} from 'bun:test';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Response as ModelResponse,ResponseOutputItem} from 'openai/resources/responses/responses';
import {Runtime} from '../services/daemon/runtime.ts';
import {Journal} from '../services/daemon/journal.ts';
import {ToolExecutor} from '../services/daemon/tools.ts';
import {DaemonEvent,type Assignment} from '../packages/protocol/index.ts';
import type {Provider,ResponseInputItem} from '../packages/provider/index.ts';
import {fixture,message,wire} from './anthropic-context-fixture.ts';

class ObservedJournal extends Journal {readonly done=Promise.withResolvers<void>();override finish(run:string){super.finish(run);this.done.resolve();}}
const call=(id:string,args:string):ResponseOutputItem=>({type:'function_call',call_id:id,name:'shell',arguments:args});
const finish:ResponseOutputItem={type:'message',id:'final',role:'assistant',status:'completed',content:[{type:'output_text',text:'done',annotations:[]}]};
const effect=(id:string)=>call(id,JSON.stringify({command:`printf '${id}\\n' >> "$OUTPUT_DIR/effects.txt"`}));
const response=(output:ResponseOutputItem[]):ModelResponse=>({id:crypto.randomUUID(),created_at:0,output_text:'',error:null,incomplete_details:null,instructions:null,metadata:null,model:'fixture',object:'response',output,parallel_tool_calls:true,temperature:null,tool_choice:'auto',tools:[],top_p:null,status:'completed'});

async function scenario(rounds:ResponseOutputItem[][],claude=false,cancelOnRound?:number,resume=false,throwOnRound?:number){
 const root=await mkdtemp(join(tmpdir(),'argument-repair-')),journal=new ObservedJournal(':memory:'),events:DaemonEvent[]=[],history:ResponseInputItem[][]=[];
 const now=new Date().toISOString();const assignment:Assignment={run_id:crypto.randomUUID(),task:{id:crypto.randomUUID(),conversation_id:crypto.randomUUID(),objective:'fixture',state:'running',reason:null,created_at:now,updated_at:now},messages:[],instructions:'',memory:[]};
 let assigned=false,index=0;
 const control=Bun.serve({port:0,async fetch(request){
  const path=new URL(request.url).pathname;
  if(path==='/v1/daemon/poll'){const value=assigned?null:assignment;assigned=true;return Response.json({assignment:value,commands:[],messages:[]});}
  if(path==='/v1/daemon/events'){events.push(DaemonEvent.parse(await request.json()));return Response.json({accepted:true});}
  if(path==='/v1/daemon/extensions')return Response.json({skills:[],servers:[]});
  if(path.startsWith('/v1/daemon/resume/'))return Response.json({assignment});
  if(path==='/v1/daemon/composing')return Response.json({generation:1});
  return Response.json({messages:[]});
 }});
 const entered=Promise.withResolvers<void>();
 const provider:Provider={respond:async (input,_tools,signal)=>{history.push([...input]);index++;if(index===throwOnRound)throw new TypeError('fixture transport failure');if(index===cancelOnRound){entered.resolve();return await new Promise<ModelResponse>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true}));}return response(rounds[index-1]??[]);}};
 const native=claude?fixture({respond:()=>{
  const items=rounds[index++]??[];
  const blocks=items.flatMap<unknown>(item=>item.type==='function_call'?[{type:'tool_use',id:item.call_id,name:item.name,input:JSON.parse(item.arguments)}]:item.type==='message'?[{type:'text',text:'done'}]:[]);
  return new Response(wire(message(blocks,items.some(item=>item.type==='function_call')?'tool_use':'end_turn',`msg-${index}`)),{headers:{'content-type':'text/event-stream'}});
 }}):undefined;
 const config={controlUrl:control.url.href,token:'fixture',journal,provider:native?.provider??provider,artifactRoot:root,compactThreshold:1000000,onFailure:()=>{}};
 let runtime=new Runtime({...config,tools:new ToolExecutor()});
 try{
  await runtime.tick();if(cancelOnRound){await entered.promise;await runtime.stop();}else await journal.done.promise;await runtime.flush();
  if(resume){runtime=new Runtime({...config,tools:new ToolExecutor()});await runtime.tick();await journal.done.promise;await runtime.flush();}
  const observations=journal.observations.forRun(assignment.run_id);
  const effects:string[]=[];
  for(const folder of await readdir(root)){const file=Bun.file(join(root,folder,'outputs/effects.txt'));if(await file.exists())effects.push(...(await file.text()).trim().split('\n'));}
  return {events,history,rounds:index,observations,effects,nativeRequests:native?.requests,checkpoint:journal.recoverable(assignment.run_id)};
 }finally{await runtime.stop();journal.close();await control.stop(true);await native?.server.stop(true);await rm(root,{recursive:true,force:true});}
}

for(const claude of [false,true])test(`repairs rejected mixed response without replaying earlier effects (${claude?'Claude':'GPT'})`,async()=>{
 // Given a completed earlier action, then a whole response with one valid and one invalid action.
 const rounds=[[effect('prior')],[effect('rejected'),call('bad','{}')],[effect('repaired')],[finish]];
 // When the runtime drives inference and real shell tools through its HTTP control boundary.
 const result=await scenario(rounds,claude);
 // Then only the earlier and repaired actions execute once; no rejected companion executes.
 expect(result.events.filter(e=>e.kind==='state').at(-1)).toMatchObject({state:'succeeded'});
 expect(result.observations.map(o=>o.action_id.split(':').at(-1))).toEqual(['prior','repaired']);
 expect(result.rounds).toBe(4);
 expect(result.effects).toEqual(['prior','repaired']);
});
test('cancellation during repair preserves bounded budget and earlier call receipts in checkpoint',async()=>{
 const result=await scenario([[effect('prior')],[call('bad','{}')]],false,3);
 expect(result.checkpoint?.argumentRepairs).toBe(1);
 expect(result.checkpoint?.seenCallIds).toEqual(['prior']);
 expect(result.events.filter(e=>e.kind==='state')).toEqual([]);
 expect(result.observations.map(o=>o.action_id.split(':').at(-1))).toEqual(['prior']);
});
test('a repaired response cannot reuse an earlier completed call id',async()=>{
 const result=await scenario([[effect('prior')],[call('bad','{}')],[effect('prior')]]);
 expect(result.events.filter(e=>e.kind==='state').at(-1)).toMatchObject({state:'unknown'});
 expect(result.observations.map(o=>o.action_id.split(':').at(-1))).toEqual(['prior']);
});
test('unknown tool hidden after invalid arguments cannot enter repair',async()=>{
 const result=await scenario([[call('bad','{}'),{type:'function_call',call_id:'unknown',name:'not-offered',arguments:'{}'}],[finish]]);
 expect(result.rounds).toBe(1);expect(result.observations).toEqual([]);
 expect(result.events.filter(e=>e.kind==='state').at(-1)).toMatchObject({state:'unknown'});
});
test('resume retains consumed repair budget and stops when the remaining repair fails',async()=>{
 const invalid=[call('bad','{}')];
 const result=await scenario([invalid,[],invalid,invalid,[effect('must-not-run')]],false,2,true);
 expect(result.rounds).toBe(4);expect(result.effects).toEqual([]);
 expect(result.checkpoint?.argumentRepairs).toBe(2);
 expect(result.events.filter(e=>e.kind==='state').at(-1)).toMatchObject({state:'failed'});
});
test('transport failure during repair remains unknown and is never inferred again',async()=>{
 const result=await scenario([[effect('prior')],[call('bad','{}')],[],[effect('must-not-run')]],false,undefined,false,3);
 expect(result.rounds).toBe(3);expect(result.effects).toEqual(['prior']);
 expect(result.events.filter(e=>e.kind==='state').at(-1)).toMatchObject({state:'unknown'});
});
test('exhausted malformed argument repair ends failed with no executed actions',async()=>{
 // Given three invalid completed responses.
 const invalid=[call('bad','{bad')];
 // When two bounded repairs also fail validation.
 const result=await scenario([invalid,invalid,invalid,[effect('must-not-run')]]);
 // Then inference stops truthfully at a known rejection boundary.
 expect(result.rounds).toBe(3);expect(result.observations).toEqual([]);
 expect(result.events.filter(e=>e.kind==='state').at(-1)).toMatchObject({state:'failed'});
});
