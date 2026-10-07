import { persistFixtureExtraction as persistExtraction } from "./memory-fixture-retention";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { z } from "zod";
import { createDatabase } from "../services/control/db.ts";
import { createApp } from "../services/control/app.ts";
import { hashToken } from "../services/control/auth.ts";
import { retrieveMemory } from "../packages/memory/persist.ts";
import { inputHash, type Claim, type Source, type ExtractionRequest } from "../packages/memory/schema.ts";
import { MemoryView } from "../packages/memory/views.ts";
const sql=createDatabase(process.env["TEST_DATABASE_URL"]??"postgres://assistant:assistant@127.0.0.1:55439/assistant_dev");
const workspace=crypto.randomUUID(),vm=crypto.randomUUID(),conversation=crypto.randomUUID(),otherConversation=crypto.randomUUID(),task=crypto.randomUUID(),run=crypto.randomUUID();
const token=crypto.randomUUID()+crypto.randomUUID(),app=createApp(sql),headers={authorization:`Bearer ${token}`,"content-type":"application/json"};
const principal={workspace_id:workspace,vm_id:vm,role:"vm" as const};
beforeAll(async()=>{
  await sql`INSERT INTO workspaces(id,name) VALUES(${workspace},'manual-memory-test')`;
  await sql`INSERT INTO credentials(token_hash,workspace_id,role) VALUES(${await hashToken(token)},${workspace},'client')`;
  await sql`INSERT INTO vms(id,workspace_id,name) VALUES(${vm},${workspace},'fixture')`;
  await sql`INSERT INTO conversations(id,workspace_id,title) VALUES(${conversation},${workspace},'memory'),(${otherConversation},${workspace},'other')`;
  await sql`INSERT INTO tasks(id,workspace_id,conversation_id,objective,state) VALUES(${task},${workspace},${conversation},'memory','failed')`;
  await sql`INSERT INTO runs(id,workspace_id,task_id,vm_id,state) VALUES(${run},${workspace},${task},${vm},'failed')`;
});
afterAll(async()=>{await sql.end();});
async function source(content:string):Promise<Source>{
  return z.object({id:z.uuid(),role:z.literal("user"),content:z.string(),created_at:z.string()}).parse((await sql`INSERT INTO messages(workspace_id,conversation_id,task_id,role,content) VALUES(${workspace},${conversation},${task},'user',${content}) RETURNING *`)[0]);
}
function claim(evidence:Source,values:Partial<Claim>={}):Claim{return {kind:"assertion",context:"fixture-context",entity:"user",predicate:"preference",text:evidence.content,epistemic_status:"reported",value:evidence.content,unit:null,valid_from:null,valid_to:null,time_precision:"unknown",evidence:{source_message_id:evidence.id,quote:evidence.content},supersedes_id:null,correction:false,due_at:null,due_timezone:null,...values};}
async function extract(sources:readonly Source[],claims:readonly Claim[]){
  const request:ExtractionRequest={run_id:run,derivation_id:crypto.randomUUID(),input_hash:await inputHash(sources),source_ids:sources.map(s=>s.id),extraction:{schema_version:1,claims:[...claims]}};
  const result=await persistExtraction(sql,principal,request);
  const memories=z.array(z.object({id:z.uuid(),text:z.string(),predicate:z.string()})).parse(await sql`SELECT m.id,m.text,a.predicate FROM memory_assertions a JOIN memories m ON m.id=a.id WHERE a.derivation_id=${request.derivation_id}`);
  return {result,memories};
}
async function correct(id:string,text:string,client_correction_id=crypto.randomUUID()){
  return app.request(`/v1/memory/${id}/corrections`,{method:"POST",headers,body:JSON.stringify({text,client_correction_id})});
}
async function firstMemory(text:string){const s=await source(text);const {memories}=await extract([s],[claim(s)]);const memory=memories[0];if(!memory)throw new TypeError("Fixture assertion missing");return {s,id:memory.id};}
test("correction preserves original typed value/audit, returns real source and scoped reported override",async()=>{
  const {s,id}=await firstMemory("My limit is 12 requests");
  await sql`UPDATE memory_assertions SET typed_value='{"value":12,"unit":"requests"}'::jsonb,epistemic_status='inferred' WHERE id=${id}`;
  const response=await correct(id,"My limit is 40 requests");expect(response.status).toBe(201);
  const memory=z.object({memory:MemoryView}).parse(await response.json()).memory;
  expect(memory.provenance).toBe("user_correction");expect(memory.epistemic_status).toBe("reported");expect(memory.source_excerpt).toBe(s.content);expect(memory.conversation_id).toBe(conversation);expect(memory.supersedes_id).toBe(id);
  const old=z.object({typed_value:z.unknown(),closed:z.boolean(),text:z.string()}).parse((await sql`SELECT a.typed_value,a.known_to IS NOT NULL AS closed,m.text FROM memory_assertions a JOIN memories m ON m.id=a.id WHERE a.id=${id}`)[0]);
  expect(old).toEqual({typed_value:{value:12,unit:"requests"},closed:true,text:s.content});
  const current=await retrieveMemory(sql,workspace,conversation);expect(current.some(m=>m.id===id)).toBe(false);expect(current.some(m=>m.id===memory.id&&m.text.includes("reported; user_correction"))).toBe(true);
  expect(current.find(m=>m.id===memory.id)?.text).toContain(`context=fixture-context; predicate=preference; source=${s.id}`);
  expect((await retrieveMemory(sql,workspace,otherConversation)).some(m=>m.id===memory.id)).toBe(false);
  expect(JSON.stringify(memory)).not.toContain(await hashToken(token));
});
test("retries are idempotent and stale concurrent edits cannot branch history",async()=>{
  const {id}=await firstMemory("Version original"),key=crypto.randomUUID();
  expect((await correct(id,"Version one",key)).status).toBe(201);expect((await correct(id,"Version one",key)).status).toBe(201);
  expect((await correct(id,"Conflicting retry",key)).status).toBe(409);expect((await correct(id,"Stale version" )).status).toBe(409);
  const next=crypto.randomUUID();expect((await correct(key,"Version two",next)).status).toBe(201);
  const history=z.object({history:z.array(z.object({text:z.string(),current:z.boolean()}))}).parse(await (await app.request(`/v1/memory/${next}/history`,{headers})).json()).history;
  expect(history.map(v=>v.text)).toEqual(["Version original","Version one","Version two"]);expect(history.map(v=>v.current)).toEqual([false,false,true]);
});
test("same-source sibling survives correction and same-identity re-extraction paraphrase is suppressed",async()=>{
  const s=await source("Coffee is preferred. Budget is ten."),one=claim(s,{text:"Coffee preference",evidence:{source_message_id:s.id,quote:"Coffee is preferred."}}),two=claim(s,{predicate:"constraint",text:"Budget ten",evidence:{source_message_id:s.id,quote:"Budget is ten."}});
  const {memories}=await extract([s],[one,two]);const original=memories.find(m=>m.predicate==="preference"),sibling=memories.find(m=>m.predicate==="constraint");if(!original||!sibling)throw new TypeError("Fixture claims missing");
  const key=crypto.randomUUID();expect((await correct(original.id,"Tea preference",key)).status).toBe(201);
  const extra=await source("New extraction snapshot");
  const again=await extract([s,extra],[{...one,text:"Paraphrased coffee preference"},{...two,text:"Another budget wording"}]);expect(again.result.count).toBe(1);
  expect((await retrieveMemory(sql,workspace,conversation)).some(m=>m.id===sibling.id)).toBe(true);
  expect((await sql`SELECT 1 FROM memory_suppressions WHERE workspace_id=${workspace} AND source_message_id=${s.id}`).length).toBe(0);
  expect((await app.request(`/v1/memory/${key}`,{method:"DELETE",headers})).status).toBe(200);
  const current=await retrieveMemory(sql,workspace,conversation);expect(current.some(m=>m.id===key||m.id===original.id)).toBe(false);expect(current.some(m=>m.id===sibling.id)).toBe(true);
});
test("global user note stays global after correction without creating messages or tasks",async()=>{
  const before=z.object({messages:z.coerce.number(),tasks:z.coerce.number()}).parse((await sql`SELECT (SELECT count(*) FROM messages WHERE workspace_id=${workspace}) AS messages,(SELECT count(*) FROM tasks WHERE workspace_id=${workspace}) AS tasks`)[0]);
  const note=z.object({memory:z.object({id:z.uuid()})}).parse(await (await app.request('/v1/memory',{method:'POST',headers,body:JSON.stringify({text:"Global note"})})).json()).memory;
  const key=crypto.randomUUID();expect((await correct(note.id,"Correct global note",key)).status).toBe(201);
  expect((await retrieveMemory(sql,workspace,otherConversation)).some(m=>m.id===key)).toBe(true);
  const after=z.object({messages:z.coerce.number(),tasks:z.coerce.number()}).parse((await sql`SELECT (SELECT count(*) FROM messages WHERE workspace_id=${workspace}) AS messages,(SELECT count(*) FROM tasks WHERE workspace_id=${workspace}) AS tasks`)[0]);expect(after).toEqual(before);
});
test("tenant boundaries, blank corrections, and deleted targets are rejected",async()=>{
  expect((await correct(crypto.randomUUID(),"Other workspace target")).status).toBe(404);
  const {id}=await firstMemory("Deleted original");expect((await correct(id,"   ")).status).toBe(400);
  expect((await app.request(`/v1/memory/${id}`,{method:"DELETE",headers})).status).toBe(200);expect((await correct(id,"Cannot resurrect")).status).toBe(409);
});
test("later explicit user extraction supersedes manual version and history includes both provenance types",async()=>{
  const original=await firstMemory("Initial coffee preference"),manual=crypto.randomUUID();
  expect((await correct(original.id,"Tea preference",manual)).status).toBe(201);
  const newer=await source("Correction: now prefer water");
  const next=await extract([newer],[claim(newer,{supersedes_id:manual,correction:true})]);
  expect(next.result.count).toBe(1);const current=next.memories[0];if(!current)throw new TypeError("Missing later correction");
  const retrieved=await retrieveMemory(sql,workspace,conversation);expect(retrieved.some(m=>m.id===manual)).toBe(false);expect(retrieved.some(m=>m.id===current.id)).toBe(true);
  const listing=z.object({memories:z.array(MemoryView)}).parse(await (await app.request('/v1/memory',{headers})).json());expect(listing.memories.some(m=>m.id===manual)).toBe(false);
  const history=z.object({history:z.array(z.object({id:z.uuid(),current:z.boolean()}))}).parse(await (await app.request(`/v1/memory/${current.id}/history`,{headers})).json()).history;
  expect(history.map(m=>m.id)).toEqual([original.id,manual,current.id]);expect(history.map(m=>m.current)).toEqual([false,false,true]);
  expect((await correct(manual,"Stale manual update")).status).toBe(409);
  const final=crypto.randomUUID();expect((await correct(current.id,"Final manual preference",final)).status).toBe(201);
  expect((await app.request(`/v1/memory/${final}`,{method:'DELETE',headers})).status).toBe(200);
  expect((await retrieveMemory(sql,workspace,conversation)).some(m=>[original.id,manual,current.id,final].includes(m.id))).toBe(false);
});
test("changed source spans cannot revive corrected claim; different value of same predicate remains eligible",async()=>{
  const s=await source("Coffee is preferred. Jazz is preferred."),old=claim(s,{text:"Coffee preference",value:"coffee",evidence:{source_message_id:s.id,quote:"Coffee is preferred."}});
  const first=await extract([s],[old]);const original=first.memories[0];if(!original)throw new TypeError("Missing fixture");
  const manual=crypto.randomUUID();expect((await correct(original.id,"Tea preference",manual)).status).toBe(201);expect((await app.request(`/v1/memory/${manual}`,{method:'DELETE',headers})).status).toBe(200);
  const extra=await source("Fresh snapshot");
  const next=await extract([s,extra],[{...old,text:"Prefers coffee",evidence:{source_message_id:s.id,quote:s.content}},{...old,text:"Jazz preference",value:"jazz",evidence:{source_message_id:s.id,quote:s.content}}]);
  expect(next.result.count).toBe(1);expect(next.memories.map(m=>m.text)).toEqual(["Jazz preference"]);
});
test("simultaneous corrections serialize and a real foreign workspace memory remains private",async()=>{
  const {id}=await firstMemory("Concurrent memory");const results=await Promise.all([correct(id,"First edit"),correct(id,"Second edit")]);expect(results.map(r=>r.status).sort()).toEqual([201,409]);
  const foreign=crypto.randomUUID(),other=crypto.randomUUID();await sql`INSERT INTO workspaces(id,name) VALUES(${foreign},'foreign-memory')`;await sql`INSERT INTO memories(id,workspace_id,text) VALUES(${other},${foreign},'Private foreign memory')`;
  expect((await correct(other,"Cannot edit")).status).toBe(404);expect((await app.request(`/v1/memory/${other}/history`,{headers})).status).toBe(404);expect((await app.request(`/v1/memory/${other}`,{method:'DELETE',headers})).status).toBe(404);
});
