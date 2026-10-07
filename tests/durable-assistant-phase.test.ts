import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Assignment, DaemonEvent, Message } from "../packages/protocol/index.ts";
import { OpenAIProvider } from "../packages/provider/index.ts";
import { anthropicTranscript } from "../packages/provider/anthropic-messages.ts";
import { createDatabase } from "../services/control/db.ts";
import { createApp } from "../services/control/app.ts";
import { hashToken } from "../services/control/auth.ts";
import { Runtime } from "../services/daemon/runtime.ts";
import { Journal } from "../services/daemon/journal.ts";
import { ToolExecutor } from "../services/daemon/tools.ts";

class ObservedJournal extends Journal {
  readonly finished = Promise.withResolvers<void>();
  override finish(run: string): void { super.finish(run); this.finished.resolve(); }
}
const stored = {id:crypto.randomUUID(),conversation_id:crypto.randomUUID(),role:"assistant",content:"legacy",sequence:1,created_at:new Date().toISOString(),client_message_id:null} as const;
const phase = z.enum(["commentary", "final_answer"]);
const wireMessage = z.object({role:z.literal("assistant"),phase:phase.nullish(),content:z.unknown()});
const wireRequest = z.object({input:z.array(z.unknown())});
function completion(value: "commentary" | "final_answer", text: string): Response {
  return new Response(`data: ${JSON.stringify({type:"response.completed",response:{id:crypto.randomUUID(),status:"completed",output:[{type:"message",id:crypto.randomUUID(),role:"assistant",status:"completed",phase:value,content:[{type:"output_text",text,annotations:[]}]}]}})}\n\n`, {headers:{"Content-Type":"text/event-stream"}});
}
for (const view of ["work", "full"] as const) test(`same-task ${view} reassignment resends durable phases on actual Responses HTTP`, async () => {
  // Given: real PG/control HTTP/provider HTTP, and no checkpoint in the replacement daemon.
  const database = z.string().url().parse(process.env["TEST_DATABASE_URL"]);
  const sql = createDatabase(database);
  const workspace=crypto.randomUUID(), vm=crypto.randomUUID(), conversation=crypto.randomUUID(), task=crypto.randomUUID();
  const machine=crypto.randomUUID()+crypto.randomUUID(), client=crypto.randomUUID()+crypto.randomUUID();
  const root=await mkdtemp(join(tmpdir(),"durable-phase-")), waiting=Promise.withResolvers<void>();
  const requests: z.infer<typeof wireRequest>[] = [], emitted: unknown[] = [], assignments: Assignment[] = [];
  const upstream=Bun.serve({port:0,async fetch(request){
    requests.push(wireRequest.parse(await request.json()));
    switch(requests.length){
      case 1:return completion("commentary","progress");
      case 2:return completion("final_answer","first answer");
      case 3:waiting.resolve();return new Response(new ReadableStream(),{headers:{"Content-Type":"text/event-stream"}});
      case 4:return completion("final_answer","continued answer");
      default:throw new TypeError("Unexpected provider request");
    }
  }});
  const previous=process.env["OPENAI_BASE_URL"];process.env["OPENAI_BASE_URL"]=upstream.url.href;
  const provider=new OpenAIProvider({mode:"api",model:"fixture",apiKey:"local-fixture"});
  const app=createApp(sql);
  const headers={Authorization:`Bearer ${client}`,"Content-Type":"application/json"};
  const server=Bun.serve({port:0,async fetch(request){
    const url=new URL(request.url);
    const event=url.pathname==="/v1/daemon/events"?await request.clone().json():undefined;
    if(view==="full"&&url.pathname==="/v1/daemon/poll"&&url.searchParams.get("view")==="work"){
      url.searchParams.set("view","full");
    }
    const response=await app.fetch(url.href===request.url?request:new Request(url,request));
    if(url.pathname==="/v1/daemon/poll"&&response.ok){
      const body=z.object({assignment:Assignment.nullable()}).parse(await response.clone().json());
      if(body.assignment)assignments.push(body.assignment);
    }
    if(event){
      emitted.push(event);
      const parsed=DaemonEvent.parse(event);
      if(parsed.kind==="message"&&parsed.content==="first answer"&&response.ok){
        const steering=await app.request(`/v1/conversations/${conversation}/messages`,{method:"POST",headers,body:JSON.stringify({client_message_id:crypto.randomUUID(),content:"continue this task"})});
        if(!steering.ok)throw new TypeError("Steering rejected");
      }
    }
    return response;
  }});
  const firstJournal=new Journal(":memory:"), secondJournal=new ObservedJournal(":memory:");
  const first=new Runtime({controlUrl:server.url.href,token:machine,journal:firstJournal,provider,tools:new ToolExecutor(),artifactRoot:root});
  const second=new Runtime({controlUrl:server.url.href,token:machine,journal:secondJournal,provider,tools:new ToolExecutor(),artifactRoot:root});
  try {
    await sql`INSERT INTO assistant.workspaces(id,name) VALUES(${workspace},'durable-phase')`;
    await sql`INSERT INTO assistant.vms(id,workspace_id,name) VALUES(${vm},${workspace},'vm')`;
    await sql`INSERT INTO assistant.credentials(token_hash,workspace_id,role,vm_id) VALUES(${await hashToken(machine)},${workspace},'vm',${vm}),(${await hashToken(client)},${workspace},'client',NULL)`;
    await sql`INSERT INTO assistant.conversations(id,workspace_id,title) VALUES(${conversation},${workspace},'phase')`;
    await sql`INSERT INTO assistant.tasks(id,workspace_id,conversation_id,objective) VALUES(${task},${workspace},${conversation},'phase')`;
    await sql`INSERT INTO assistant.messages(workspace_id,conversation_id,task_id,role,content) VALUES(${workspace},${conversation},${task},'assistant','legacy')`;
    await first.tick();await waiting.promise;
    expect((await app.request(`/v1/vms/${vm}/control`,{method:"POST",headers,body:JSON.stringify({kind:"takeover"})})).status).toBe(200);
    await first.tick();
    expect(z.object({state:z.string()}).parse((await sql`SELECT state FROM assistant.tasks WHERE id=${task}`)[0]).state).toBe("paused");
    await first.stop();
    expect(secondJournal.suspended()).toEqual([]);
    // When: returning control without local resume proof closes the paused run and reassigns its task.
    expect((await app.request(`/v1/vms/${vm}/control`,{method:"POST",headers,body:JSON.stringify({kind:"return_control"})})).status).toBe(200);
    await second.tick();await second.tick();await secondJournal.finished.promise;await second.flush();
    // Then: both assignment shapes and the real SDK HTTP request retain exact provider phases.
    const replay=requests[3]?.input.flatMap(item=>{const parsed=wireMessage.safeParse(item);return parsed.success?[parsed.data]:[];});
    const rows=await sql`SELECT * FROM assistant.messages WHERE task_id=${task} ORDER BY sequence`;
    const artifact={view,emitted,assignments,requests,replay,rows,runs:await sql`SELECT id,task_id,state FROM assistant.runs WHERE task_id=${task} ORDER BY created_at`};
    const evidence=process.env["PHASE_EVIDENCE_DIR"];
    if(evidence)await Bun.write(join(evidence,`reassignment-${view}.json`),JSON.stringify(artifact,null,2));
    expect(assignments).toHaveLength(2);
    expect(assignments[1]?.task.id).toBe(task);expect(assignments[1]?.run_id).not.toBe(assignments[0]?.run_id);
    expect(replay).toEqual([{role:"assistant",content:"legacy"},{role:"assistant",content:"progress",phase:"commentary"},{role:"assistant",content:"first answer",phase:"final_answer"}]);
    expect(emitted.filter(item=>z.object({kind:z.literal("command_ack"),resume_safe:z.literal(false)}).safeParse(item).success)).toHaveLength(1);
    expect(rows.filter(row=>row["role"]==="user").every(row=>row["phase"]===null)).toBe(true);
  } finally {
    await first.stop();await second.stop();firstJournal.close();secondJournal.close();provider.close();
    if(previous===undefined)delete process.env["OPENAI_BASE_URL"];else process.env["OPENAI_BASE_URL"]=previous;
    await server.stop(true);await upstream.stop(true);await sql.end();await rm(root,{recursive:true,force:true});
  }
},15000);

test("message phase accepts old payloads and rejects non-assistant or invalid phases",()=>{
  // Given / When / Then: the wire boundary accepts absent/null legacy metadata, never invented final phases.
  expect(Message.parse(stored)).not.toHaveProperty("phase");
  expect(Message.parse({...stored,phase:null})).toHaveProperty("phase",null);
  for(const role of ["user","system"])expect(Message.parse({...stored,role,phase:null})).toHaveProperty("phase",null);
  const oldEvent={kind:"message",event_id:crypto.randomUUID(),run_id:crypto.randomUUID(),content:"legacy"};
  expect(DaemonEvent.parse(oldEvent)).not.toHaveProperty("phase");
  expect(DaemonEvent.parse({...oldEvent,phase:null})).toHaveProperty("phase",null);
  for(const value of ["commentary","final_answer"]){
    expect(Message.parse({...stored,phase:value})).toHaveProperty("phase",value);
    for(const role of ["user","system"])expect(Message.safeParse({...stored,role,phase:value}).success).toBe(false);
    expect(DaemonEvent.parse({kind:"message",event_id:crypto.randomUUID(),run_id:crypto.randomUUID(),content:"x",phase:value})).toHaveProperty("phase",value);
  }
  expect(Message.safeParse({...stored,phase:"analysis"}).success).toBe(false);
  expect(DaemonEvent.safeParse({kind:"message",event_id:crypto.randomUUID(),run_id:crypto.randomUUID(),content:"x",phase:"analysis"}).success).toBe(false);
});

test("Claude transcript is identical for known and unknown assistant phases",()=>{
  // Given: known-phase Responses output and its legacy equivalent.
  const known=[{type:"message",id:"fixture",role:"assistant",status:"completed",phase:"commentary",content:[{type:"output_text",text:"progress",annotations:[]}]}] as const;
  // When / Then: conversion ignores Responses-specific metadata without affecting Claude content.
  const output={...known[0],content:[...known[0].content].map(part=>({...part,annotations:[]}))};
  const {phase:omitted,...unknown}=output;
  expect(omitted).toBe("commentary");
  expect(anthropicTranscript([output,{role:"user",content:"continue"}],"fixture")).toEqual(anthropicTranscript([unknown,{role:"user",content:"continue"}],"fixture"));
});

test("migration preserves unknown history and enforces assistant-only known phases",async()=>{
  // Given: an isolated pre-migration database with legacy messages.
  const url=new URL(z.string().url().parse(process.env["TEST_DATABASE_URL"]));
  if(!["localhost","127.0.0.1"].includes(url.hostname))throw new TypeError("Local migration fixture required");
  url.pathname="/postgres";
  const admin=createDatabase(url.href),name=`phase_migration_${crypto.randomUUID().replaceAll("-","")}`;
  await admin.unsafe(`CREATE DATABASE ${name}`);url.pathname=`/${name}`;
  const sql=createDatabase(url.href);
  try{
    await sql`CREATE SCHEMA assistant`;
    await sql.unsafe(await Bun.file(new URL("../infra/migrations/001_control.sql",import.meta.url)).text());
    const workspace=crypto.randomUUID(),conversation=crypto.randomUUID();
    await sql`INSERT INTO workspaces(id,name) VALUES(${workspace},'phase-migration')`;
    await sql`INSERT INTO conversations(id,workspace_id,title) VALUES(${conversation},${workspace},'phase')`;
    for(const role of ["assistant","user","system"])await sql`INSERT INTO messages(workspace_id,conversation_id,role,content) VALUES(${workspace},${conversation},${role},'legacy')`;
    // When: apply only the new additive migration over populated legacy storage.
    await sql.unsafe(await Bun.file(new URL("../infra/migrations/030_assistant_message_phase.sql",import.meta.url)).text());
    // Then: legacy rows stay null, legal assistant phases persist, and invalid role/phase pairs fail CHECK.
    expect((await sql`SELECT phase FROM messages`).map(row=>row["phase"])).toEqual([null,null,null]);
    for(const value of ["commentary","final_answer"])await sql`INSERT INTO messages(workspace_id,conversation_id,role,content,phase) VALUES(${workspace},${conversation},'assistant','known',${value})`;
    const rejected=[];
    for(const [role,value] of [["assistant","analysis"],["user","commentary"],["user","final_answer"],["system","commentary"],["system","final_answer"]]){
      const result=sql`INSERT INTO messages(workspace_id,conversation_id,role,content,phase) VALUES(${workspace},${conversation},${role??null},'invalid',${value??null})`;
      await expect(result.then(()=>undefined)).rejects.toMatchObject({code:"23514",constraint_name:"messages_assistant_phase_check"});
      rejected.push({role,phase:value,code:"23514"});
    }
    const rows=await sql`SELECT role,content,phase FROM messages ORDER BY sequence`;
    expect(rows.map(row=>row["phase"])).toEqual([null,null,null,"commentary","final_answer"]);
    const evidence=process.env["PHASE_EVIDENCE_DIR"];
    if(evidence)await Bun.write(join(evidence,"migration-constraints.json"),JSON.stringify({rows,rejected},null,2));
  }finally{await sql.end();await admin.unsafe(`DROP DATABASE ${name}`);await admin.end();}
});
