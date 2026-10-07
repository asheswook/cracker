import { test, expect } from "bun:test";
import { z } from "zod";
import { Runtime } from '../services/daemon/runtime.ts';
import { Journal } from '../services/daemon/journal.ts';
import { ToolExecutor } from '../services/daemon/tools.ts';
import type { Provider } from '../packages/provider/index.ts';
import { DaemonEvent, type Assignment } from '../packages/protocol/index.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
for(const resolution of ["poll","close"] as const) test(`final response waits for explicit yielded shell resolution: ${resolution}`, async()=>{
const dir=await mkdtemp(join(tmpdir(),'pending-final-review-'));
const finished=Promise.withResolvers<void>();
class ObservedJournal extends Journal { override finish(run:string){super.finish(run);finished.resolve();} }
const journal=new ObservedJournal(':memory:');
const work:Assignment={run_id:crypto.randomUUID(),task:{id:crypto.randomUUID(),conversation_id:crypto.randomUUID(),objective:'finish background job',state:'running',reason:null,created_at:new Date().toISOString(),updated_at:new Date().toISOString()},messages:[],instructions:'',memory:[]};
let assigned=false,round=0,session="",exited=false;const events:DaemonEvent[]=[];
const server=Bun.serve({port:0,async fetch(request){const path=new URL(request.url).pathname;if(path==='/v1/daemon/poll'){const assignment=assigned?null:work;assigned=true;return Response.json({assignment,commands:[],messages:[]});}if(path==='/v1/daemon/events'){events.push(DaemonEvent.parse(await request.json()));return Response.json({accepted:true});}return Response.json({messages:[],skills:[],servers:[]});}});
const provider:Provider={respond:async(input)=>{
for(const item of input)if(item.type==='function_call_output'&&typeof item.output==='string'){
try{const parsed=z.object({session_id:z.string(),status:z.string()}).safeParse(JSON.parse(item.output));if(parsed.success){session=parsed.data.session_id;exited=parsed.data.status==='exited';}}catch(error){if(!(error instanceof SyntaxError))throw error;}
}
return ({id:'fixture',created_at:0,output_text:'',error:null,incomplete_details:null,instructions:null,metadata:null,model:'fixture',object:'response',output:round++===0?[{type:'function_call',call_id:'start',name:'shell_start',arguments:JSON.stringify({command:`printf ready; sleep 1; printf done > '${join(dir,'done')}'`,cwd:null,yield_ms:1000,max_output_chars:1000})}]:round>2&&!exited?[{type:'function_call',call_id:`poll${round}`,name:'shell_session',arguments:JSON.stringify({session_id:session,action:resolution,input:null,yield_ms:1000,max_output_chars:1000})}]:[{type:'message',id:'final',role:'assistant',status:'completed',phase:'final_answer',content:[{type:'output_text',text:'Done',annotations:[]}]}],parallel_tool_calls:false,temperature:null,tool_choice:'auto',tools:[],top_p:null,status:'completed'});}};
const runtime=new Runtime({controlUrl:server.url.href,token:'fixture',provider,journal,tools:new ToolExecutor(),artifactRoot:dir});
try{await runtime.tick();await finished.promise;await runtime.flush();expect(events.flatMap(e=>e.kind==='state'?[e.state]:[])).toEqual(['succeeded']);
expect(await Bun.file(join(dir,'done')).exists()).toBe(resolution==='poll');
expect(round).toBeGreaterThan(2);
expect(events.flatMap(e=>e.kind==='message'?[e.content]:[])).toEqual(['Done']);
expect(journal.observations.forRun(work.run_id).filter(e=>e.tool_name==='shell_start')).toHaveLength(1);
;}finally{await runtime.stop();journal.close();await server.stop(true);await rm(dir,{recursive:true,force:true});}

});
