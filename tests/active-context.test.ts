import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Assignment } from "../packages/protocol/index.ts";
import type { Provider, ResponseInputItem } from "../packages/provider/index.ts";
import { compactedInput } from "../packages/provider/compaction.ts";
import { compactContext, compactedServerWindow, contextBudget, type RunCheckpoint } from "../services/daemon/active-context.ts";
import { Journal } from "../services/daemon/journal.ts";

export function assignment():Assignment { return {run_id:crypto.randomUUID(),task:{id:crypto.randomUUID(),conversation_id:crypto.randomUUID(),objective:"fixture",state:"running",reason:null,created_at:new Date().toISOString(),updated_at:new Date().toISOString()},messages:[],instructions:"",memory:[]}; }
const opaque:ResponseInputItem={type:"compaction",encrypted_content:"opaque-fixture"};
test('context estimate excludes binary image/file/opaque encodings while retaining measured tokens and new text',()=>{
  const binary='A'.repeat(1_000_000);
  const input:ResponseInputItem[]=[{role:'user',content:[
    {type:'input_text',text:'Inspect the supplied image.'},
    {type:'input_image',image_url:`data:image/png;base64,${binary}`,detail:'original'},
    {type:'input_file',file_data:binary,filename:'fixture.pdf'},
  ]},{type:'compaction',encrypted_content:binary}];
  expect(contextBudget(input,3000)).toBe(3000);
  expect(contextBudget(input,80000)).toBe(80000);
  input.push({type:'function_call_output',call_id:'read',output:'x'.repeat(70000)});
  expect(contextBudget(input,3000)).toBeGreaterThan(70000);
});
const pair:ResponseInputItem[]=[{type:"function_call",call_id:"effect",name:"shell",arguments:'{"command":"true"}'},{type:"function_call_output",call_id:"effect",output:"completed"}];
function provider(output:ResponseInputItem[]):Provider{return {compact:async()=>output,respond:async()=>{throw new TypeError("Unexpected inference");}};}

test("compaction retains canonical ordering and opaque fields plus policy, images and user instructions",async()=>{
  // Given completed tool pairs and distinct user/steering/image input.
  const policy:ResponseInputItem={role:"system",content:"fixture policy"};
  const users:ResponseInputItem[]=[{role:"user",content:"initial fixture"},{role:"user",content:[{type:"input_image",image_url:"data:image/png;base64,AA==",detail:"original"}]},{role:"user",content:"steering fixture"}];
  const canonical=[...users,opaque,...pair];
  // When
  const result=await compactContext(provider(canonical),{input:[policy,...users,...pair],signal:AbortSignal.timeout(1000)});
  // Then canonical items remain byte-for-byte and are not pruned/reconstructed.
  expect(result).toEqual([policy,...canonical]);expect(result[1]).toBe(canonical[0]);
});
for(const output of [[opaque],[{type:"compaction",encrypted_content:""}], [...pair.slice(0,1),opaque],[...pair.slice(1),opaque]])test("malformed or lossy compaction leaves the original transcript unchanged: "+JSON.stringify(output),async()=>{
  // Given
  const input:ResponseInputItem[]=[{role:"user",content:"preserved"},...pair],before=JSON.stringify(input);
  // When / Then
  await expect(compactContext({respond:provider([]).respond,compact:async()=>compactedInput({object:"response.compaction",output})},{input,signal:AbortSignal.timeout(1000)})).rejects.toThrow();
  expect(JSON.stringify(input)).toBe(before);
});
test("compaction never starts while a function result is missing",async()=>{
  // Given
  let calls=0;const input=pair.slice(0,1);
  // When / Then
  await expect(compactContext({respond:provider([]).respond,compact:async()=>{calls++;return [opaque];}},{input,signal:AbortSignal.timeout(1000)})).rejects.toThrow("incomplete_tool_boundary");expect(calls).toBe(0);
});
for(const boundary of ["checkpoint","started","completed"] as const)test(`SQLite restart resumes only effects already included at the checkpoint: ${boundary}`,async()=>{
  // Given a durable completed action and its transcript checkpoint.
  const dir=await mkdtemp(join(tmpdir(),"active-checkpoint-")),path=join(dir,"journal.sqlite"),work=assignment();
  const state:RunCheckpoint={version:1,assignment:work,input:[...pair],cursor:7,seenCallIds:["effect"],artifacts:{directory:dir,seen:["attachment"],inlineBytes:3},inputTokens:123};
  const first=new Journal(path);first.start(work.run_id);first.begin(work.run_id,"effect");first.complete("effect","completed");first.checkpoint(state);
  if(boundary!=="checkpoint")first.begin(work.run_id,"uncertain");
  if(boundary==="completed")first.complete("uncertain","external effect completed before checkpoint");
  first.close();
  // When the actual SQLite file is reopened after the crash boundary.
  const recovered=new Journal(path);
  // Then even a completed journal row after the checkpoint cannot be replayed.
  try { expect(recovered.recoverable(work.run_id)).toEqual(boundary==="checkpoint"?state:null);expect(()=>recovered.begin(work.run_id,"effect")).toThrow("reconciliation_required"); }
  finally {recovered.close();await rm(dir,{recursive:true});}
});

for(const trailing of [true,false])test(`server compaction selects a complete tool suffix with trailing marker=${trailing}`,()=>{
  // Given two possible compaction boundaries around a requested action.
  const first:ResponseInputItem={type:"compaction",encrypted_content:"first"},last:ResponseInputItem={type:"compaction",encrypted_content:"last"};
  const policy:ResponseInputItem={role:"system",content:"fixture"};
  const input:ResponseInputItem[]=[policy,{role:"user",content:"old"},first,...pair.slice(0,1),...(trailing?[last]:[]),...pair.slice(1)];
  // When
  const result=compactedServerWindow(input);
  // Then neither an orphan output nor an unpaired action is introduced.
  expect(result).toEqual([policy,first,...input.slice(3)]);
});
test("server compaction replaces prior history at latest complete boundary",()=>{
  // Given an earlier complete call and a later opaque boundary.
  const last:ResponseInputItem={type:"compaction",encrypted_content:"latest"};
  // When / Then
  expect(compactedServerWindow([...pair,opaque,last,{role:"user",content:"next"}])).toEqual([last,{role:"user",content:"next"}]);
});

test('old standalone marker cannot discard retained user input or become a fallback for an incomplete fresh server boundary',()=>{
 const user:ResponseInputItem={role:'user',content:'preserved upload metadata'};
 const input:ResponseInputItem[]=[user,opaque,...pair.slice(0,1),{type:'compaction',encrypted_content:'new'},...pair.slice(1)];
 expect(compactedServerWindow(input,2)).toBe(input);
 expect(compactedServerWindow([user,opaque],2)).toEqual([user,opaque]);
});
