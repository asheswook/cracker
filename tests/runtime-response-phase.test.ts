import {test,expect} from "bun:test";
import {mkdtemp,rm,readdir} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {z} from "zod";
import type {Response,ResponseOutputItem} from "openai/resources/responses/responses";
import {createDatabase} from "../services/control/db.ts";
import {createApp} from "../services/control/app.ts";
import {hashToken} from "../services/control/auth.ts";
import {DesktopError} from "../services/daemon/desktop-protocol.ts";
import {Runtime,type RuntimeFailure} from "../services/daemon/runtime.ts";
import {Journal} from "../services/daemon/journal.ts";
import {ToolExecutor} from "../services/daemon/tools.ts";
import type {Provider,ResponseInputItem} from "../packages/provider/index.ts";
class ObservedJournal extends Journal{readonly finished=Promise.withResolvers<void>();override finish(run:string):void{super.finish(run);this.finished.resolve();}}
const message=(phase:"commentary"|"final_answer",text:string):ResponseOutputItem=>({type:"message",id:crypto.randomUUID(),role:"assistant",status:"completed",phase,content:[{type:"output_text",text,annotations:[]}]});
const call=(id:string,args:string):ResponseOutputItem=>({type:"function_call",call_id:id,name:"shell",arguments:args});
const shell=()=>call('first',JSON.stringify({command:'printf actual-effect > "$OUTPUT_DIR/proof.txt"'}));
function response(output:ResponseOutputItem[]):Response{return {id:crypto.randomUUID(),created_at:0,output_text:'',error:null,incomplete_details:null,instructions:null,metadata:null,model:'fixture',object:'response',output,parallel_tool_calls:false,temperature:null,tool_choice:'auto',tools:[],top_p:null,status:'completed'};}
class FeedbackTools extends ToolExecutor {
 onRun: (()=>Promise<void>)|undefined;
 override async run(name:string,args:string,signal:AbortSignal){await this.onRun?.();return super.run(name,args,signal);}
}
async function scenario(outputs:ResponseOutputItem[][],tools=new ToolExecutor()){
 const sql=createDatabase(process.env['TEST_DATABASE_URL']??'postgres://assistant:assistant@127.0.0.1:55439/assistant_dev'),workspace=crypto.randomUUID(),vm=crypto.randomUUID(),conversation=crypto.randomUUID(),task=crypto.randomUUID(),token=crypto.randomUUID()+crypto.randomUUID();
 const dir=await mkdtemp(join(tmpdir(),'response-phase-')),journal=new ObservedJournal(':memory:'),history:ResponseInputItem[][]=[];
 const app=createApp(sql),server=Bun.serve({port:0,fetch:app.fetch});
 const messagesAtTool:string[][]=[];
 if(tools instanceof FeedbackTools)tools.onRun=async()=>{messagesAtTool.push(z.array(z.object({content:z.string()})).parse(await sql`SELECT content FROM assistant.messages WHERE conversation_id=${conversation} AND role='assistant' ORDER BY sequence`).map(row=>row.content));};
 const provider:Provider={respond:async(input)=>{history.push([...input]);const output=outputs[history.length-1];if(!output)throw new TypeError('Unexpected provider round');return response(output);}};
 const failures:RuntimeFailure[]=[];
 const runtime=new Runtime({onFailure:event=>failures.push(event),controlUrl:server.url.href,token,journal,provider,tools,artifactRoot:dir});
 try{
  await sql`INSERT INTO assistant.workspaces(id,name) VALUES(${workspace},'response-phase-test')`;
  await sql`INSERT INTO assistant.vms(id,workspace_id,name) VALUES(${vm},${workspace},'vm')`;
  await sql`INSERT INTO assistant.credentials(token_hash,workspace_id,role,vm_id) VALUES(${await hashToken(token)},${workspace},'vm',${vm})`;
  await sql`INSERT INTO assistant.conversations(id,workspace_id,title) VALUES(${conversation},${workspace},'response phases')`;
  await sql`INSERT INTO assistant.tasks(id,workspace_id,conversation_id,objective) VALUES(${task},${workspace},${conversation},'fixture')`;
  await runtime.tick();await journal.finished.promise;await runtime.flush();
  const state=z.object({state:z.string()}).parse((await sql`SELECT state FROM assistant.tasks WHERE id=${task}`)[0]).state;
  const run=z.object({id:z.uuid()}).parse((await sql`SELECT id FROM assistant.runs WHERE task_id=${task}`)[0]).id;
  const folders=await readdir(dir);const effects=await Promise.all(folders.map(folder=>Bun.file(join(dir,folder,'outputs/proof.txt')).exists()));
  const messages=z.array(z.object({content:z.string()})).parse(await sql`SELECT content FROM assistant.messages WHERE conversation_id=${conversation} AND role='assistant' ORDER BY sequence`);
  const phases=(await sql`SELECT phase FROM assistant.messages WHERE conversation_id=${conversation} AND role='assistant' ORDER BY sequence`).map(row=>row['phase']);
  const blocks=(await sql`SELECT blocks FROM assistant.messages WHERE conversation_id=${conversation} AND role='assistant' ORDER BY sequence`).map(row=>row['blocks']??null);
  return {state,history,effect:effects.some(Boolean),zeroActions:journal.resumeSafe(run),messages,phases,blocks,messagesAtTool,failures,observations:journal.observations.forRun(run)};
 }finally{await runtime.stop();journal.close();await server.stop(true);await sql`UPDATE assistant.credentials SET revoked_at=now() WHERE workspace_id=${workspace}`;await sql.end();await rm(dir,{recursive:true,force:true});}
}
test('validated model progress is persisted before tools even when the call precedes commentary',async()=>{
 // Given / When: a completed provider response, real control HTTP and PG, and a real shell effect.
 const result=await scenario([[shell(),message('commentary','I will inspect the files and report back here.')],[message('final_answer','Inspection completed.')]],new FeedbackTools());
 // Then: progress is already visible when execution begins, and completion remains last.
 expect(result.messagesAtTool).toEqual([['I will inspect the files and report back here.']]);
 expect(result.effect).toBe(true);expect(result.state).toBe('succeeded');
 expect(result.messages.map(row=>row.content)).toEqual(['I will inspect the files and report back here.','Inspection completed.']);
});
test('replayed model progress is delivered once while new findings remain visible',async()=>{
 // Given / When: retry-equivalent commentary with different provider IDs, followed by a real new finding.
 const result=await scenario([[message('commentary','Inspecting the files.')],[message('commentary','Inspecting the files.'),shell()],[message('commentary','Found two relevant files.')],[message('final_answer','Done.')]],new FeedbackTools());
 // Then
 expect(result.messages.map(row=>row.content)).toEqual(['Inspecting the files.','Found two relevant files.','Done.']);
 expect(result.messagesAtTool).toEqual([['Inspecting the files.']]);expect(result.state).toBe('succeeded');
});
test('phase-less opening text alongside tool calls is delivered before the tools run',async()=>{
 // Given: a provider without phases (Claude through the subscription proxy) sends an opening with its first call.
 const plain=(text:string):ResponseOutputItem=>({type:'message',id:crypto.randomUUID(),role:'assistant',status:'completed',content:[{type:'output_text',text,annotations:[]}]});
 // When
 const result=await scenario([[plain('파일을 확인하고 여기 알려드릴게요.'),shell()],[plain('확인했습니다.')]],new FeedbackTools());
 // Then: the opening is visible while the tool runs, and the completion follows.
 expect(result.messagesAtTool).toEqual([['파일을 확인하고 여기 알려드릴게요.']]);
 expect(result.messages.map(row=>row.content)).toEqual(['파일을 확인하고 여기 알려드릴게요.','확인했습니다.']);
 expect(result.effect).toBe(true);expect(result.state).toBe('succeeded');
});
test('text explicitly marked final is still held while tool calls run',async()=>{
 const result=await scenario([[message('final_answer','Premature answer'),shell()],[message('final_answer','Actual completion')]],new FeedbackTools());
 expect(result.messagesAtTool).toEqual([[]]);
 expect(result.messages.map(row=>row.content)).toEqual(['Actual completion']);
});
test('show_result stores a card message with its receipt and keeps the summary as text',async()=>{
 // Given: the model reports a completed post with show_result, then a short final reply.
 const card:ResponseOutputItem={type:'function_call',call_id:'card1',name:'show_result',arguments:JSON.stringify({action:'posted',channel:'Slack #개발',target:null,title:null,body:'오늘 13:30 회의 있습니다.',url:'https://example.slack.com/archives/C0/p1',at:'2026-10-24T12:15:00+09:00',summary:'Slack #개발에 일정을 올렸습니다.'})};
 // When
 const result=await scenario([[card],[message('final_answer','끝났습니다.')]]);
 // Then
 expect(result.state).toBe('succeeded');
 expect(result.messages.map(row=>row.content)).toEqual(['Slack #개발에 일정을 올렸습니다.','끝났습니다.']);
 expect(result.blocks[0]).toEqual([{kind:'result',action:'posted',channel:'Slack #개발',target:null,title:null,body:'오늘 13:30 회의 있습니다.',url:'https://example.slack.com/archives/C0/p1',at:'2026-10-24T12:15:00+09:00'}]);
 expect(result.blocks[1]).toBeNull();
});
test('show_result drops a non-http link and an unparseable time instead of failing',async()=>{
 const card:ResponseOutputItem={type:'function_call',call_id:'card2',name:'show_result',arguments:JSON.stringify({action:'sent',channel:'Gmail',target:'Elena',title:'Deck',body:null,url:'javascript:alert(1)',at:'tomorrow',summary:'메일을 보냈습니다.'})};
 const result=await scenario([[card],[message('final_answer','보냈습니다.')]]);
 expect(result.state).toBe('succeeded');
 expect(result.blocks[0]).toEqual([{kind:'result',action:'sent',channel:'Gmail',target:'Elena',title:'Deck',body:null,url:null,at:null}]);
});
test('a simple final response receives no synthetic progress message',async()=>{
 // Given / When
 const result=await scenario([[message('final_answer','Four.')]]);
 // Then
 expect(result.messages).toEqual([{content:'Four.'}]);expect(result.state).toBe('succeeded');
});
test('provider text without a phase remains unknown in durable storage',async()=>{
 const result=await scenario([[{type:'message',id:'legacy-output',role:'assistant',status:'completed',content:[{type:'output_text',text:'Legacy output',annotations:[]}]}]]);
 expect(result.state).toBe('succeeded');expect(result.phases).toEqual([null]);
});
test('reasoning summaries never become user-visible progress',async()=>{
 const reasoning:ResponseOutputItem={type:'reasoning',id:'private-reasoning',summary:[{type:'summary_text',text:'Private deliberation fixture'}],encrypted_content:'opaque-private-fixture'};
 const result=await scenario([[reasoning,message('commentary','Checking the file.'),shell()],[message('final_answer','Checked.')]],new FeedbackTools());
 expect(result.messages.map(row=>row.content)).toEqual(['Checking the file.','Checked.']);
 expect(result.messagesAtTool).toEqual([['Checking the file.']]);
});
test('commentary-only continues; mixed final plus calls executes first; explicit history preserves phase and reasoning',async()=>{
 // Given / When: actual PG/control/SQLite and shell, with a provider wire-equivalent sequence.
 const reasoning:ResponseOutputItem={type:'reasoning',id:'reasoning1',summary:[],encrypted_content:'opaque-fixture'};
 const result=await scenario([[reasoning,message('commentary','Starting the task')],[message('final_answer','Premature answer'),shell()],[message('final_answer','Actual completion')]]);
 // Then
 expect(result.state).toBe('succeeded');expect(result.history).toHaveLength(3);expect(result.effect).toBe(true);
 expect(result.history[1]?.some(item=>item.type==='message'&&'phase' in item&&item.phase==='commentary')).toBe(true);
 expect(result.history[1]).toContainEqual(reasoning);
 expect(result.history[2]?.some(item=>item.type==='function_call_output'&&item.call_id==='first')).toBe(true);
 expect(result.messages.map(m=>m.content)).toEqual(['Starting the task','Actual completion']);
});
for(const invalid of [call('second','{bad'),call('second','{}'),call('first',JSON.stringify({command:'echo duplicate'})),{type:'function_call',call_id:'second',name:'not_offered',arguments:'{}'} satisfies ResponseOutputItem])test('malformed later call prevents all earlier shell effects and messages: '+JSON.stringify(invalid),async()=>{
 // Given / When: a valid effect precedes a malformed/duplicate/unknown call in the same response.
 const invalidArguments=invalid.type==='function_call'&&invalid.name==='shell'&&invalid.call_id==='second';
 const rejected=[message('commentary','Unvalidated progress'),shell(),invalid];
 const result=await scenario(invalidArguments?[rejected,rejected,rejected]:[rejected]);
 // Then
 expect(result.state).toBe(invalidArguments?'failed':'unknown');expect(result.effect).toBe(false);expect(result.zeroActions).toBe(true);expect(result.messages).toEqual([]);
});
test('refusal fails the task and prevents companion tool side effects',async()=>{
 // Given / When
 const result=await scenario([[shell(),{type:'message',id:'refusal',role:'assistant',status:'completed',phase:'final_answer',content:[{type:'refusal',refusal:'The provider declined this fixture.'}]}]]);
 // Then
 expect(result.state).toBe('failed');expect(result.effect).toBe(false);expect(result.zeroActions).toBe(true);expect(result.messages).toEqual([{content:'The provider declined this fixture.'}]);
 expect(result.phases).toEqual([null]);
});

class FailingCleanupTools extends ToolExecutor{private resets=0;override async resetDesktop(workspace?:string):Promise<void>{this.resets++;if(this.resets>1)throw new TypeError('fixture input release failure');await super.resetDesktop(workspace);}}
test('final answer cannot publish success when desktop cleanup fails',async()=>{
 const result=await scenario([[message('final_answer','Answer text')]],new FailingCleanupTools());
 expect(result.state).toBe('unknown');expect(result.effect).toBe(false);
});

class FrameTools extends ToolExecutor{calls=0;override async run(name:string,args:string,signal:AbortSignal){if(name!=="computer_exec")return super.run(name,args,signal);this.calls++;return {text:"captured",image:`final${this.calls}`,images:[`first${this.calls}`,`second${this.calls}`,`third${this.calls}`,`final${this.calls}`]};}}
test('multiple screenshot batches retain unseen frames and defer excess capture before dispatch',async()=>{
 const tools=new FrameTools();const capture=(id:string):ResponseOutputItem=>({type:"function_call",call_id:id,name:"computer_exec",arguments:JSON.stringify({code:"await desktop.screenshot()",timeout_ms:1000})});
 const result=await scenario([[capture("cap1"),capture("cap2"),capture("cap3")],[message("final_answer","done")]],tools);
 expect(result.state).toBe("succeeded");expect(tools.calls).toBe(2);
 expect(result.observations).toHaveLength(2);
 expect(result.observations.map(item=>item.image_delivery)).toEqual(["appended","appended"]);
 expect(result.observations.map(item=>item.frames.length)).toEqual([4,4]);
 expect(result.observations[0]?.arguments_sha256).toBe(result.observations[1]?.arguments_sha256);
 expect(result.observations[0]?.frames[0]?.sha256).not.toBe(result.observations[1]?.frames[0]?.sha256);
 const second=result.history[1]??[];
 const frames=second.flatMap(item=>"content" in item&&typeof item.content!=="string"&&item.content?item.content.flatMap(part=>part.type==="input_image"?[part.image_url]:[]):[]);
 expect(frames).toEqual(["first1","second1","third1","final1","first2","second2","third2","final2"]);
 expect(second.some(item=>item.type==="function_call_output"&&item.call_id==="cap3"&&String(item.output).includes("Skipped before execution"))).toBe(true);
});

class VariableFrameTools extends ToolExecutor{
 calls=0;
 override async run(name:string,args:string,signal:AbortSignal){
  if(name!=="computer_exec")return super.run(name,args,signal);
  this.calls++;const images=Array.from({length:this.calls===2?4:1},(_,i)=>`batch${this.calls}-frame${i}`);
  return {text:"captured",images};
 }
}
test('runtime keeps all unseen batch frames and only enough consumed frames to fill two',async()=>{
 const tools=new VariableFrameTools();const capture=(id:string):ResponseOutputItem=>({type:"function_call",call_id:id,name:"computer_exec",arguments:JSON.stringify({code:"await desktop.screenshot()",timeout_ms:1000})});
 const result=await scenario([[capture("a")],[capture("b")],[capture("c")],[message("final_answer","done")]],tools);
 const frames=result.history.map(input=>input.flatMap(item=>"content" in item&&typeof item.content!=="string"&&item.content?item.content.flatMap(part=>part.type==="input_image"?[part.image_url]:[]):[]));
 expect(result.state).toBe("succeeded");expect(frames).toEqual([[],["batch1-frame0"],["batch2-frame0","batch2-frame1","batch2-frame2","batch2-frame3"],["batch2-frame3","batch3-frame0"]]);
 expect(result.history[3]?.filter(item=>item.type==="function_call_output")).toHaveLength(3);
});

class BusyDesktopTools extends ToolExecutor{override async run():Promise<never>{const error=new DesktopError("desktop_busy");error.message="synthetic-sensitive-details";throw error;}}
test('actual runtime records fixed desktop failure metadata and quarantines failed first call',async()=>{
 const result=await scenario([[{type:"function_call",call_id:"busy",name:"computer_exec",arguments:JSON.stringify({code:"return null",timeout_ms:1000})}]],new BusyDesktopTools());
 expect(result.observations[0]?.image_delivery).toBe("pending");expect(result.observations[0]?.completed_at).toBeNull();
 expect(result.state).toBe("unknown");expect(result.failures).toHaveLength(1);expect(result.failures[0]).toMatchObject({event:"runtime.failure",type:"desktop",code:"desktop_busy"});expect(JSON.stringify(result.failures)).not.toContain("synthetic-sensitive-details");
});

class OversizedFrameTools extends ToolExecutor {
 override async run(){return {text:"capture completed",images:["A".repeat(12*1024*1024)]};}
}
class RepeatedFrameTools extends ToolExecutor {
 calls=0;
 override async run(){this.calls++;return {text:'observed',image:this.calls%2?'page-a':'page-b'};}
}
test('repeated visual observations guide subsequent inference without blocking tools or publishing a fake failure',async()=>{
 const tools=new RepeatedFrameTools();
 const calls:ResponseOutputItem[][]=Array.from({length:7},(_,index)=>[{type:'function_call',call_id:`revisit-${index}`,name:'computer_exec',arguments:JSON.stringify({code:'return null',timeout_ms:1000})}]);
 const result=await scenario([...calls,[message('final_answer','Compared the evidence')]],tools);
 expect(tools.calls).toBe(7);expect(result.state).toBe('succeeded');
 expect(result.history[5]?.some(item=>'content' in item&&typeof item.content==='string'&&item.content.startsWith('Visual observation note:'))).toBe(false);
 expect(result.history[6]?.filter(item=>'content' in item&&typeof item.content==='string'&&item.content.startsWith('Visual observation note:'))).toHaveLength(1);
 expect(result.history[7]?.filter(item=>'content' in item&&typeof item.content==='string'&&item.content.startsWith('Visual observation note:'))).toHaveLength(1);
 expect(result.messages).toEqual([{content:'Compared the evidence'}]);
});
test('runtime records rejected oversized capture without claiming model image delivery',async()=>{
 const result=await scenario([[{type:"function_call",call_id:"large",name:"computer_exec",arguments:JSON.stringify({code:"await desktop.screenshot()",timeout_ms:1000})}],[message("final_answer","done")]],new OversizedFrameTools());
 expect(result.state).toBe("succeeded");
 expect(result.observations[0]?.image_delivery).toBe("budget_rejected");
 expect(result.observations[0]?.image_count).toBe(1);
 expect(result.observations[0]?.frames[0]?.encoded_bytes).toBe(12*1024*1024);
 expect(result.history[1]?.some(item=>"content" in item&&typeof item.content==="string"&&item.content.includes("image delivery unavailable"))).toBe(true);
 expect(result.history[1]?.some(item=>"content" in item&&Array.isArray(item.content)&&item.content.some(part=>part.type==="input_image"))).toBe(false);
});
