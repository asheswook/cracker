import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import ky from "ky";
import type { Response as ModelResponse } from "openai/resources/responses/responses";
import type { Assignment } from "../packages/protocol/index.ts";
import type { Provider } from "../packages/provider/index.ts";
import { Runtime } from "../services/daemon/runtime.ts";
import { Journal } from "../services/daemon/journal.ts";
import { TaskArtifacts } from "../services/daemon/artifacts.ts";
import { ToolExecutor } from "../services/daemon/tools.ts";

class ObservedJournal extends Journal { readonly finished=Promise.withResolvers<void>(); override finish(run:string):void {super.finish(run);this.finished.resolve();} }
function response(output:ModelResponse["output"]):ModelResponse {return {id:crypto.randomUUID(),object:"response",created_at:0,output,output_text:"",model:"fixture",error:null,incomplete_details:null,instructions:null,metadata:null,parallel_tool_calls:false,temperature:null,top_p:null,tool_choice:"auto",tools:[],status:"completed"};}

for (const mode of ["fresh", "recovered", "return_control", "retry_manifest"] as const) test(`enabled skill is available to ${mode} execution`, async()=>{
  const root=await mkdtemp(join(tmpdir(),"extension-recovery-"));
  const now=new Date().toISOString(),skillId=crypto.randomUUID();
  const skill={id:skillId,vm_id:crypto.randomUUID(),name:"Fixture skill",description:"Fixture",enabled:true,revision:1,observed_revision:1,state:"ready",tool_count:0,error_code:null,observed_at:now,updated_at:now};
  const work:Assignment={run_id:crypto.randomUUID(),task:{id:crypto.randomUUID(),conversation_id:crypto.randomUUID(),objective:"load enabled skill",state:"running",reason:null,created_at:now,updated_at:now},messages:[],instructions:"",memory:[]};
  const mcp={...skill,id:crypto.randomUUID(),name:"Fixture MCP",config:{transport:"stdio",command:process.execPath,args:[join(process.cwd(),"tests/mcp-extension-fixture.ts")]},secret_keys:[],secrets:{}};
  const returnCommand={id:crypto.randomUUID(),task_id:null,kind:"return_control",created_at:now};
  let manifestRequests=0,skillRequests=0,rounds=0;let mcpOffered=false,catalogFresh=false;
  const outputs:string[]=[];
  const server=Bun.serve({port:0,fetch(request){
    const path=new URL(request.url).pathname;
    if(path==="/v1/daemon/extensions"){manifestRequests++;if(mode==="retry_manifest"&&manifestRequests===1)return Response.json({error:"unavailable"},{status:503});return Response.json({skills:[skill],servers:[mcp]});}
    if(path===`/v1/daemon/extensions/skills/${skillId}`){skillRequests++;return Response.json({id:skillId,name:skill.name,revision:1,content:"fixture skill instructions"});}
    if(path==="/v1/daemon/poll")return Response.json({assignment:mode==="fresh"?work:null,commands:mode==="return_control"?[returnCommand]:[],messages:[]});
    if(path.startsWith("/v1/daemon/resume/"))return Response.json({assignment:work});
    if(path.includes("/context"))return Response.json({messages:[]});
    return Response.json({accepted:true,messages:[]});
  }});
  const path=join(root,"journal.sqlite");
  if(mode!=="fresh"){
    const artifacts=await TaskArtifacts.create({http:ky.create({prefixUrl:server.url.href,timeout:5000,retry:0}),runId:work.run_id,conversationId:work.task.conversation_id,root});
    const old=new Journal(path);old.start(work.run_id);if(mode==="return_control")old.setControl("user");
    old.checkpoint({version:1,assignment:work,input:[{role:"system",content:JSON.stringify({kind:"enabled_skill_catalog",skills:[{...skill,name:"StaleSkill"}]})},{role:"user",content:"Load the enabled fixture skill."}],cursor:0,seenCallIds:[],artifacts:artifacts.checkpoint(),inputTokens:1});old.close();
  }
  const journal=new ObservedJournal(path);
  const provider:Provider={respond:async(input,tools)=>{
    const mcpTool=tools.find(tool=>tool.type==="function"&&tool.name.includes("fixture_echo"));
    mcpOffered=mcpTool?.type==="function";catalogFresh=JSON.stringify(input).includes("Fixture skill")&&!JSON.stringify(input).includes("StaleSkill");
    rounds++;
    for(const item of input)if(item.type==="function_call_output"&&typeof item.output==="string")outputs.push(item.output);
    return rounds===1?response([{type:"function_call",call_id:"load-fixture",name:"load_skill",arguments:JSON.stringify({skill_id:skillId})},...(mcpTool?.type==="function"?[{type:"function_call" as const,call_id:"mcp-fixture",name:mcpTool.name,arguments:JSON.stringify({value:"recovery-proof"})}]:[])]):response([{type:"message",id:"final",role:"assistant",status:"completed",content:[{type:"output_text",text:"fixture finished",annotations:[]}]}]);
  }};
  const runtime=new Runtime({controlUrl:server.url.href,token:"fixture",journal,provider,tools:new ToolExecutor(),artifactRoot:root});
  try{
    if(mode==="fresh")await runtime.tick();else {if(mode==="retry_manifest"){await expect(runtime.recover()).rejects.toThrow();expect(rounds).toBe(0);expect(journal.suspended()).toEqual([work.run_id]);}await runtime.recover();if(mode==="return_control"){expect(rounds).toBe(0);await runtime.tick();}}
    await journal.finished.promise;await runtime.flush();
    console.log(JSON.stringify({mode,manifestRequests,skillRequests,mcpOffered,catalogFresh}));
    expect(outputs.some(output=>output.includes("fixture skill instructions"))).toBe(true);
    expect(manifestRequests).toBeGreaterThan(0);expect(skillRequests).toBe(1);
    expect(mcpOffered).toBe(true);expect(catalogFresh).toBe(true);
    expect(outputs.some(output=>output.includes("recovery-proof::"))).toBe(true);
  }finally{await runtime.stop();journal.close();await server.stop(true);await rm(root,{recursive:true});}
});
