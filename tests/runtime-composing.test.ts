import {test,expect} from "bun:test";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {z} from "zod";
import type {Response as ModelResponse,ResponseStreamEvent} from "openai/resources/responses/responses";
import {consumeResponse,type Provider} from "../packages/provider";
import {ComposingRequest,ComposingState} from "../packages/protocol/composing";
import {Runtime} from "../services/daemon/runtime";
import {Journal} from "../services/daemon/journal";
import {ToolExecutor} from "../services/daemon/tools";
import {controlFixture} from "./control-fixture";
const f=controlFixture();
class ObservedJournal extends Journal{readonly finished=Promise.withResolvers<void>();override finish(run:string){super.finish(run);this.finished.resolve();}override suspend(run:string){super.suspend(run);this.finished.resolve();}}
for(const ending of ["completed","error","abort","unavailable"] as const)test(`runtime composes only between real text and ${ending}, without persisting transient events`,async()=>{
  await f.finishActive();const task=await f.newTask(),stored=Promise.withResolvers<void>(),providerStarted=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
  const transient:string[]=[];
  const server=Bun.serve({port:0,async fetch(request){
    if(new URL(request.url).pathname==='/v1/daemon/composing'){
      if(ending==='unavailable')return new Response('unavailable',{status:503});
      const event=ComposingRequest.parse(await request.clone().json());
      const response=await f.app.fetch(request);
      if(event.kind==='update'){transient.push(event.status);if(event.status==='composing'&&response.ok)stored.resolve();}
      return response;
    }
    return f.app.fetch(request);
  }});
  const root=await mkdtemp(join(tmpdir(),'composing-')),journal=new ObservedJournal(':memory:');
  const provider:Provider={respond:async(_input,_tools,signal,observer)=>{
    const response:ModelResponse={id:'response-1',created_at:0,output_text:'',error:null,incomplete_details:null,instructions:null,metadata:null,model:'fixture',object:'response',output:[{type:'message',id:'reply',role:'assistant',status:'completed',content:[{type:'output_text',text:'Finished',annotations:[]}]}],parallel_tool_calls:false,temperature:null,tool_choice:'auto',tools:[],top_p:null,status:'completed'};
    async function* wire(){
      yield {type:'response.created',response,sequence_number:0} satisfies ResponseStreamEvent;
      yield {type:'response.output_item.added',item:{type:'message',id:'reply',role:'assistant',status:'in_progress',content:[]},output_index:0,sequence_number:1} satisfies ResponseStreamEvent;
      yield {type:'response.output_text.delta',delta:'visible',item_id:'reply',output_index:0,content_index:0,sequence_number:2,logprobs:[]} satisfies ResponseStreamEvent;
      providerStarted.resolve();
      const stop=()=>release.resolve();signal.addEventListener('abort',stop,{once:true});
      try{await release.promise;signal.throwIfAborted();if(ending==='error')throw new TypeError('synthetic transport failure');}
      finally{signal.removeEventListener('abort',stop);}
      yield {type:'response.completed',response,sequence_number:3} satisfies ResponseStreamEvent;
    }
    return consumeResponse(wire(),observer);
  }};
  const runtime=new Runtime({controlUrl:server.url.href,token:f.machine,journal,provider,tools:new ToolExecutor(),artifactRoot:root,onFailure:()=>{}});
  const page=async()=>z.object({composing:ComposingState.nullable()}).parse(await(await f.request(`/v1/conversations/${task.message.conversation_id}/messages`)).json());
  try{
    await runtime.tick();await providerStarted.promise;
    if(ending!=='unavailable'){await stored.promise;expect((await page()).composing?.input_message_ids).toContain(task.message.id);}
    else expect((await page()).composing).toBeNull();
    if(ending==='abort')await runtime.stop();else release.resolve();
    await journal.finished.promise;await runtime.flush();
    expect((await page()).composing).toBeNull();
    expect(journal.pending()).toEqual([]);
    expect((await f.sql`SELECT count(*)::int AS count FROM assistant.events WHERE workspace_id=${f.workspace} AND kind='composing'`)[0]?.['count']).toBe(0);
    if(ending!=='unavailable')expect(transient.at(-1)).toBe('ended');
  }finally{release.resolve();await runtime.stop();journal.close();await server.stop(true);await rm(root,{recursive:true,force:true});}
});
