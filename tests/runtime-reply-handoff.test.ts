import {test,expect} from "bun:test";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {z} from "zod";
import type {Response as ModelResponse,ResponseOutputItem} from "openai/resources/responses/responses";
import type {Provider} from "../packages/provider";
import {DaemonEvent} from "../packages/protocol";
import {ComposingRequest,ComposingState,ReplyHandoffState} from "../packages/protocol/composing";
import {Runtime} from "../services/daemon/runtime";
import {Journal} from "../services/daemon/journal";
import {ToolExecutor} from "../services/daemon/tools";
import {controlFixture} from "./control-fixture";

const f=controlFixture();
const Page=z.object({composing:ComposingState.nullable(),reply_handoff:ReplyHandoffState.nullable(),messages:z.array(z.object({role:z.string(),content:z.string()}))});
class ObservedJournal extends Journal{readonly finished=Promise.withResolvers<void>();override finish(run:string){super.finish(run);this.finished.resolve();}override suspend(run:string){super.suspend(run);this.finished.resolve();}}
const message=(refusal=false,commentary=false):ResponseOutputItem=>({type:"message",id:"reply",role:"assistant",status:"completed",phase:commentary?"commentary":"final_answer",content:refusal?[{type:"refusal",refusal:"Refused fixture"}]:[{type:"output_text",text:"Validated fixture",annotations:[]}]});
const call:ResponseOutputItem={type:"function_call",call_id:"call",name:"shell",arguments:JSON.stringify({command:"printf verified"})};
const response=(output:ResponseOutputItem[]):ModelResponse=>({id:"response",created_at:0,output_text:"",error:null,incomplete_details:null,instructions:null,metadata:null,model:"fixture",object:"response",output,parallel_tool_calls:false,temperature:null,tool_choice:"auto",tools:[],top_p:null,status:"completed"});

for(const mode of ["final","multi-item","commentary","calls-no-reply","withheld","refusal","invalid","error","abort","abort-delivery","retry"] as const)test(`runtime reply handoff validates, publishes, and clears: ${mode}`,async()=>{
  // Given: real control HTTP/PostgreSQL and SQLite outbox, with a gated provider boundary.
  await f.finishActive();const task=await f.newTask();
  const composingStored=Promise.withResolvers<void>(),settlingStored=Promise.withResolvers<void>(),releaseValidation=Promise.withResolvers<void>();
  const earlyComposing=Promise.withResolvers<void>(),earlySettling=Promise.withResolvers<void>();
  const endedStored=Promise.withResolvers<void>();
  const publication=Promise.withResolvers<void>(),releasePublication=Promise.withResolvers<void>();
  const terminalBoundary=Promise.withResolvers<void>(),releaseBoundary=Promise.withResolvers<void>();
  const updates:ComposingRequest[]=[],messageIds:string[]=[];
  const root=await mkdtemp(join(tmpdir(),"reply-handoff-")),journal=new ObservedJournal(":memory:");
  let failDelivery=mode==="retry",round=0;
  const server=Bun.serve({port:0,async fetch(request){
    const path=new URL(request.url).pathname;
    if(path==="/v1/daemon/composing"){
      const update=ComposingRequest.parse(await request.clone().json());
      const result=await f.app.fetch(request);updates.push(update);
      if(update.kind==="update"&&result.ok){
        if(update.status==="composing"){if(update.item_id==="early")earlyComposing.resolve();else composingStored.resolve();}
        if(update.status==="settling"){if(update.item_id==="early")earlySettling.resolve();else settlingStored.resolve();}
        if(update.status==="ended")endedStored.resolve();
        if(update.status==="delivering")expect(journal.pending().some(event=>event.event_id===update.delivery_event_id)).toBe(true);
      }
      return result;
    }
    if(path==="/v1/daemon/events"){
      const event=DaemonEvent.parse(await request.clone().json());
      if(event.kind==="message"){
        messageIds.push(event.event_id);publication.resolve();await releasePublication.promise;
        if(failDelivery)return new Response("retry fixture",{status:503});
      }
    }
    return f.app.fetch(request);
  }});
  const page=async()=>Page.parse(await(await f.request(`/v1/conversations/${task.message.conversation_id}/messages`)).json());
  class BoundaryTools extends ToolExecutor{
    override hasPendingShellSessions(){return mode==="withheld"&&round===1;}
    override async run(name:string,args:string,signal:AbortSignal){
      const visible=await page();expect(visible.composing).toBeNull();expect(visible.reply_handoff).toBeNull();
      expect(visible.messages.filter(item=>item.role==="assistant")).toHaveLength(mode==="commentary"?1:0);
      terminalBoundary.resolve();await releaseBoundary.promise;
      return super.run(name,args,signal);
    }
  }
  const provider:Provider={respond:async(_input,_tools,signal,observer)=>{
    round++;
    if(round>1){terminalBoundary.resolve();await releaseBoundary.promise;throw new TypeError("fixture completed boundary");}
    if(mode==="multi-item"){
      observer?.({type:"text_delta",response_id:"response",item_id:"early"});await earlyComposing.promise;
      observer?.({type:"text_done",response_id:"response",item_id:"early"});await earlySettling.promise;
    }
    observer?.({type:"text_delta",response_id:"response",item_id:"reply"});await composingStored.promise;
    if(mode==="multi-item")expect((await page()).composing?.item_id).toBe("reply");
    observer?.({type:"text_done",response_id:"response",item_id:"reply"});await settlingStored.promise;
    const abort=()=>releaseValidation.resolve();signal.addEventListener("abort",abort,{once:true});
    try{await releaseValidation.promise;signal.throwIfAborted();}finally{signal.removeEventListener("abort",abort);}
    if(mode==="error")throw new TypeError("fixture provider failure");
    observer?.({type:"response_done",response_id:"response"});
    if(mode==="invalid")return response([message(),{...call,arguments:"{"}]);
    if(mode==="commentary")return response([call,message(false,true)]);
    if(mode==="calls-no-reply")return response([message(),call]);
    if(mode==="multi-item")return response([{type:"message",id:"early",role:"assistant",status:"completed",phase:"commentary",content:[{type:"output_text",text:"Early fixture",annotations:[]}]},message()]);
    return response([message(mode==="refusal")]);
  }};
  const runtime=new Runtime({controlUrl:server.url.href,token:f.machine,journal,provider,tools:new BoundaryTools(),artifactRoot:root,onFailure:()=>{}});
  try{
    // When: completed text waits for the validated response envelope.
    await runtime.tick();await settlingStored.promise;
    const settling=await page();expect(settling.composing).toBeNull();expect(settling.reply_handoff?.status).toBe("settling");
    expect(settling.messages.filter(item=>item.role==="assistant")).toEqual([]);
    if(mode==="abort")await runtime.stop();else releaseValidation.resolve();
    if(mode==="final"||mode==="multi-item"||mode==="refusal"||mode==="commentary"||mode==="abort-delivery"||mode==="retry"){
      await publication.promise;
      // Then: the durable event and handoff share identity before HTTP delivery applies it.
      const delivering=await page();expect(delivering.composing).toBeNull();
      expect(delivering.reply_handoff?.status).toBe("delivering");expect(delivering.reply_handoff?.delivery_event_id).toBe(messageIds[0]);
      expect(delivering.reply_handoff?.item_id).toBe("reply");
      expect(delivering.reply_handoff?.expires_at).toBe(settling.reply_handoff?.expires_at);
      if(mode==="abort-delivery"){
        const stopping=runtime.stop();await endedStored.promise;
        expect((await page()).reply_handoff).toBeNull();
        releasePublication.resolve();await stopping;
      }
      releasePublication.resolve();
    }
    if(mode==="commentary"||mode==="calls-no-reply"||mode==="withheld"){
      await terminalBoundary.promise;
      const boundary=await page();expect(boundary.composing).toBeNull();expect(boundary.reply_handoff).toBeNull();
      releaseBoundary.resolve();
    }
    await journal.finished.promise;
    if(mode==="retry"){
      expect(journal.pending().filter(event=>event.kind==="message").map(event=>event.event_id)).toEqual(messageIds);
      failDelivery=false;
    }
    await runtime.flush();
    const final=await page();expect(final.composing).toBeNull();expect(final.reply_handoff).toBeNull();
    const expected=mode==="refusal"?["Refused fixture"]:mode==="multi-item"?["Early fixture","Validated fixture"]:["final","commentary","abort-delivery","retry"].includes(mode)?["Validated fixture"]:[];
    expect(final.messages.filter(item=>item.role==="assistant").map(item=>item.content)).toEqual(expected);
    if(mode==="retry"){expect(messageIds).toHaveLength(2);expect(messageIds[0]).toBe(messageIds[1]);}
  }finally{
    releaseValidation.resolve();releasePublication.resolve();releaseBoundary.resolve();failDelivery=false;
    await runtime.stop();journal.close();await server.stop(true);await rm(root,{recursive:true,force:true});
  }
});
