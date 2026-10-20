import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import ky from "ky";
import type { Response as ModelResponse } from "openai/resources/responses/responses";
import { DaemonEvent, type Assignment, type Message } from "../packages/protocol/index.ts";
import type { Provider, ResponseInputItem } from "../packages/provider/index.ts";
import { Runtime } from "../services/daemon/runtime.ts";
import { Journal } from "../services/daemon/journal.ts";
import { TaskArtifacts } from "../services/daemon/artifacts.ts";
import { ToolExecutor } from "../services/daemon/tools.ts";

class ObservedJournal extends Journal {readonly finished=Promise.withResolvers<void>();override finish(run:string):void{super.finish(run);this.finished.resolve();}}
function response(output:ModelResponse["output"]):ModelResponse{return {id:crypto.randomUUID(),object:"response",created_at:0,output,output_text:"",model:"fixture",error:null,incomplete_details:null,instructions:null,metadata:null,parallel_tool_calls:false,temperature:null,top_p:null,tool_choice:"auto",tools:[],status:"completed"};}
for(const mode of ["safe","pending_input","uncertain","validation_retry","validation_uncertain"] as const)test(`restart recovery at ${mode} boundary preserves history and never replays uncertain effects`,async()=>{
  // Given a real artifact file, SQLite checkpoint, completed historic effect, and HTTP control seam.
  const root=await mkdtemp(join(tmpdir(),"runtime-checkpoint-")),path=join(root,"journal.sqlite");
  const work:Assignment={run_id:crypto.randomUUID(),task:{id:crypto.randomUUID(),conversation_id:crypto.randomUUID(),objective:"fixture",state:"running",reason:null,created_at:new Date().toISOString(),updated_at:new Date().toISOString()},messages:[],instructions:"",memory:[]};
  const recovery:Assignment={...work,run_id:crypto.randomUUID(),recovery:{mode:"explain_only",source_run_id:work.run_id,reason:"uncertain local effects",completed_actions:1,uncertain_actions:1,history_available:false}};
  const events:DaemonEvent[]=[],history:ResponseInputItem[][]=[],offeredCounts:number[]=[];let resumeRequests=0,rejected=false;
  const steering:Message={id:crypto.randomUUID(),conversation_id:work.task.conversation_id,role:"user",content:"steering fixture",sequence:2,created_at:new Date().toISOString(),client_message_id:null};
  const server=Bun.serve({port:0,async fetch(request){
    const url=new URL(request.url);
    if(url.pathname==="/v1/daemon/extensions")return Response.json({skills:[],servers:[]});
    if(url.pathname==="/v1/daemon/poll")return Response.json({assignment:null,commands:[],messages:[],recovery_run_id:work.run_id});
    if(url.pathname.startsWith("/v1/daemon/resume/")){resumeRequests++;if(mode==="validation_retry")expect(await request.json()).toEqual({checkpoint_cursor:1,desktop_control_scoped:true});if(mode==="validation_uncertain")expect(await request.json()).toEqual({desktop_control_scoped:true,recovery:{completed_actions:1,uncertain_actions:1,history_available:false}});return Response.json({assignment:mode==="validation_uncertain"?recovery:work});}
    if(url.pathname==="/v1/daemon/events"){
      const event=DaemonEvent.parse(await request.json());
      if(mode==="pending_input"&&!rejected&&event.kind==="state"&&event.state==="succeeded"){rejected=true;return Response.json({error:{code:"pending_input"}},{status:409});}
      events.push(event);return Response.json({accepted:true});
    }
    return Response.json({messages:mode==="pending_input"&&Number(url.searchParams.get("after"))<2?[steering]:[]});
  }});
  const artifacts=await TaskArtifacts.create({http:ky.create({prefixUrl:server.url.href}),runId:work.run_id,conversationId:work.task.conversation_id,root});
  const proof=join(artifacts.outputDirectory,"proof.txt");await Bun.write(proof,"historic");
  const first=new Journal(path);first.start(work.run_id);first.begin(work.run_id,"historic");first.complete("historic","written");
  const phasedHistory:ResponseInputItem[]=(["commentary","final_answer"] as const).map(phase=>({type:"message",id:crypto.randomUUID(),role:"assistant",status:"completed",phase,content:[{type:"output_text",text:phase,annotations:[]}]}));
  first.checkpoint({version:1,assignment:work,input:[{role:"user",content:"fixture original"},...phasedHistory,{type:"function_call",call_id:"historic",name:"shell",arguments:'{"command":"historic"}'},{type:"function_call_output",call_id:"historic",output:"written"}],cursor:1,seenCallIds:["historic"],artifacts:artifacts.checkpoint(),inputTokens:1});
  if(mode==="uncertain"||mode==="validation_uncertain")first.begin(work.run_id,"uncertain");
  if(mode==="pending_input")first.completeTurn({kind:"state",event_id:crypto.randomUUID(),run_id:work.run_id,state:"succeeded",reason:null});
  if(mode==="validation_retry"||mode==="validation_uncertain")first.finish(work.run_id);
  first.close();
  const recovered=new ObservedJournal(path);
  const provider:Provider={respond:async(input,tools)=>{history.push(input);offeredCounts.push(tools.length);return history.length===1?response([{type:"compaction",id:"before",encrypted_content:"opaque-before"},{type:"function_call",call_id:"fresh",name:"shell",arguments:JSON.stringify({command:'printf fresh >> "$OUTPUT_DIR/proof.txt"'})},{type:"compaction",id:"after",encrypted_content:"opaque-after"}]):response([{type:"message",id:"final",role:"assistant",status:"completed",content:[{type:"output_text",text:"fixture done",annotations:[]}]}]);}};
  const runtime=new Runtime({controlUrl:server.url.href,token:"fixture",journal:recovered,provider,tools:new ToolExecutor(),artifactRoot:root});
  try{
    // When a new runtime recovers the reopened SQLite file.
    if(mode==="validation_retry"||mode==="validation_uncertain")await runtime.tick();else await runtime.recover();
    await recovered.finished.promise;
    await runtime.flush();
    if(mode==="validation_uncertain"){
      expect(await Bun.file(proof).text()).toBe("historic");
      expect(resumeRequests).toBe(1);expect(history).toHaveLength(2);
      expect(recovery.run_id).not.toBe(work.run_id);expect(offeredCounts).toEqual([0,0]);
      expect(events.filter(event=>event.kind==="state").map(event=>[event.run_id,event.state])).toEqual([[recovery.run_id,"failed"]]);
      expect(recovered.observations.forRun(recovery.run_id)).toEqual([]);
      expect(recovered.recoverySummary(work.run_id)).toEqual({completed_actions:1,uncertain_actions:1,history_available:false});
      return;
    }
    // Then prior effects are not replayed, new steering is applied, and uncertain effects never start inference.
    expect(await Bun.file(proof).text()).toBe(mode==="uncertain"?"historic":"historicfresh");
    expect(resumeRequests).toBe(mode==="uncertain"?0:1);expect(history).toHaveLength(mode==="uncertain"?0:2);
    expect(events.some(event=>event.kind==="state"&&event.state===(mode==="uncertain"?"unknown":"succeeded"))).toBe(true);
    if(mode!=="uncertain")for(const item of phasedHistory)expect(history[0]).toContainEqual(item);
    if(mode==="pending_input")expect(events.some(event=>event.kind==="input_applied"&&event.message_id===steering.id)).toBe(true);
    if(mode!=="uncertain"){expect(history[0]?.some(item=>item.type==="function_call_output"&&item.call_id==="historic")).toBe(true);expect(history[1]?.filter(item=>item.type==="function_call_output").map(item=>item.call_id)).toEqual(["fresh"]);expect(history[1]?.some(item=>item.type==="compaction"&&item.encrypted_content==="opaque-before")).toBe(true);}
  }finally{await runtime.stop();recovered.close();await server.stop(true);await rm(root,{recursive:true});}
});
