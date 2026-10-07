import {test,expect} from "bun:test";
import {Journal} from "../services/daemon/journal.ts";
import {Runtime} from "../services/daemon/runtime.ts";
import {ToolExecutor} from "../services/daemon/tools.ts";
import type {Assignment} from "../packages/protocol/index.ts";

for(const code of ["resume_unavailable","command_pending","control_unavailable","run_busy"] as const)test(`resume refusal ${code} retains only retryable suspended work`,async()=>{
  // Given a locally safe checkpoint whose control lease refuses recovery.
  const work:Assignment={run_id:crypto.randomUUID(),task:{id:crypto.randomUUID(),conversation_id:crypto.randomUUID(),objective:"fixture",state:"running",reason:null,created_at:new Date().toISOString(),updated_at:new Date().toISOString()},messages:[],instructions:"",memory:[]};
  const journal=new Journal(":memory:");journal.start(work.run_id);journal.checkpoint({version:1,assignment:work,input:[],cursor:0,seenCallIds:[],artifacts:{directory:"unused",seen:[],inlineBytes:0},inputTokens:0});
  let inference=0;
  const server=Bun.serve({port:0,fetch(){return Response.json({error:{code}},{status:409});}});
  const runtime=new Runtime({controlUrl:server.url.href,token:"fixture",journal,tools:new ToolExecutor(),provider:{respond:async()=>{inference++;throw new TypeError("No authorized inference");}}});
  try{
    // When
    await runtime.recover();
    // Then cancellation/terminal refusal stops retries, while pending control barriers remain retryable.
    expect(journal.suspended()).toEqual(code==="resume_unavailable"?[]:[work.run_id]);expect(inference).toBe(0);
  }finally{await runtime.stop();journal.close();await server.stop(true);}
});
