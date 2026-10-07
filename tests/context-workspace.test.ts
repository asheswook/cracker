import { afterAll, expect, test } from "bun:test";
import ky from "ky";
import { z } from "zod";
import { createDatabase } from "../services/control/db.ts";
import { createApp } from "../services/control/app.ts";
import { hashToken, type Principal } from "../services/control/auth.ts";
import { contextSnapshot } from "../packages/context/store-read.ts";
import { rawSource } from "../packages/context/store-source.ts";
import { retainedContextSources, retainedContextNotes, snapshotSemanticContext, linkAssistantContext, writeContextNotes } from "../packages/context/store.ts";
import { reorganizeContexts, undoContextReorganization } from "../packages/context/store-reorganize.ts";
import { LinkResult, NotesResult, PrepareResult } from "../packages/context/schema.ts";
const sql=createDatabase(process.env['TEST_DATABASE_URL']??'postgres://assistant:assistant@127.0.0.1:55439/semantic_workspace_1007');
afterAll(()=>sql.end());
async function fixture() {
 const workspace=crypto.randomUUID();await sql`INSERT INTO assistant.workspaces(id,name) VALUES(${workspace},'workspace context QA')`;
 const owner=async()=>{
  const conversation=crypto.randomUUID(),task=crypto.randomUUID(),run=crypto.randomUUID(),vm=crypto.randomUUID(),token=crypto.randomUUID()+crypto.randomUUID();
  await sql`INSERT INTO assistant.conversations(id,workspace_id,title) VALUES(${conversation},${workspace},'separate original conversation')`;
  await sql`INSERT INTO assistant.vms(id,workspace_id,name) VALUES(${vm},${workspace},'fixture')`;
  await sql`INSERT INTO assistant.tasks(id,workspace_id,conversation_id,objective,state) VALUES(${task},${workspace},${conversation},'fixture','running')`;
  await sql`INSERT INTO assistant.runs(id,workspace_id,task_id,vm_id,state) VALUES(${run},${workspace},${task},${vm},'running')`;
  await sql`INSERT INTO assistant.credentials(token_hash,workspace_id,role,vm_id) VALUES(${await hashToken(token)},${workspace},'vm',${vm})`;
  const principal:Principal={workspace_id:workspace,vm_id:vm,role:'vm'};
  return {conversation,task,run,vm,token,principal,scope:{workspace,conversation}};
 };
 const a=await owner(),b=await owner(),app=createApp(sql,{semanticContexts:{}}),server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:app.fetch});
 const http=(who:typeof a)=>ky.create({prefixUrl:server.url.href,headers:{Authorization:`Bearer ${who.token}`},retry:0});
 const message=async(who:typeof a,content:string,role:'user'|'assistant'='user')=>{
  const id=crypto.randomUUID();await sql`INSERT INTO assistant.messages(id,workspace_id,conversation_id,task_id,role,content) VALUES(${id},${workspace},${who.conversation},${who.task},${role},${content})`;
  if(role==='user')await sql`INSERT INTO assistant.memory_retention_decisions(workspace_id,task_id,source_message_id,action) VALUES(${workspace},${who.task},${id},'inherit')`;return id;
 };
 const prepare=async(who:typeof a,id:string)=>PrepareResult.parse(await http(who).post(`v1/daemon/context/${who.run}/semantic/prepare`,{json:{message_id:id,history_after_sequence:0}}).json());
 const link=async(who:typeof a,id:string,context?:string)=>{
  const source=await prepare(who,id),target=context?await contextSnapshot(sql,who.scope,context):null;
  return LinkResult.parse(await http(who).post(`v1/daemon/context/${who.run}/semantic/link`,{json:{operation_id:crypto.randomUUID(),message_id:id,source_sha256:source.source.sha256,expected_link_revision:0,choice:target?{kind:'existing',context_id:target.context_id,expected_context_revision:target.revision}:{kind:'new',title:'Calendar account',scope:'Authoritative Calendar account correction'},status:'confirmed',evidence:[{message_id:id,quote:source.source.content}]}}).json());
 };
 const note=async(who:typeof a,id:string,context:string,supersedes:string|null=null)=>{
  const source=await rawSource(sql,who.scope,id),target=await contextSnapshot(sql,who.scope,context),noteId=crypto.randomUUID();
  const result=NotesResult.parse(await http(who).post(`v1/daemon/context/${who.run}/semantic/notes`,{json:{operation_id:crypto.randomUUID(),context_id:context,expected_revision:target.revision,source_message_id:id,source_sha256:await hashToken(JSON.stringify(source)),notes:[{id:noteId,kind:'decision',text:source.content,evidence:[{message_id:id,quote:source.content}],supersedes}]}}).json());return {noteId,result};
 };
 const originals=async()=>hashToken(JSON.stringify({messages:await sql`SELECT * FROM assistant.messages WHERE workspace_id=${workspace} ORDER BY id`,tasks:await sql`SELECT * FROM assistant.tasks WHERE workspace_id=${workspace} ORDER BY id`,runs:await sql`SELECT * FROM assistant.runs WHERE workspace_id=${workspace} ORDER BY id`}));
 return {workspace,a,b,http,message,prepare,link,note,originals,close:()=>server.stop(true)};
}
test('Calendar correction crosses genuine conversations A to B to A without moving originals or changing raw hashes',async()=>{
 const f=await fixture();try {
  const first=await f.message(f.a,'Calendar account is old-calendar@example.test'),correction=await f.message(f.b,'Correction: Calendar account is new-calendar@example.test'),back=await f.message(f.a,'Return to the corrected Calendar account');
  const originals=await f.originals(),raw=await rawSource(sql,f.a.scope,first),hash=await hashToken(JSON.stringify(raw));
  const initial=await f.link(f.a,first),ctx=initial.context.context_id,old=await f.note(f.a,first,ctx);
  const candidate=await f.prepare(f.b,correction);expect(candidate.candidates.some(context=>context.context_id===ctx)).toBe(true);expect(candidate.history.messages.every(message=>message.conversation_id===f.b.conversation)).toBe(true);expect(candidate.neighbors.every(message=>message.conversation_id===f.b.conversation)).toBe(true);
  await f.link(f.b,correction,ctx);const newer=await f.note(f.b,correction,ctx,old.noteId);await f.link(f.a,back,ctx);
  const snapshot=await contextSnapshot(sql,f.a.scope,ctx);expect(snapshot.notes.some(note=>note.id===newer.noteId&&note.text.includes('new-calendar'))).toBe(true);expect(snapshot.notes.some(note=>note.id===old.noteId)).toBe(false);
  expect(snapshot.recent_messages.find(message=>message.message_id===correction)?.conversation_id).toBe(f.b.conversation);expect(snapshot.recent_messages.find(message=>message.message_id===first)?.sha256).toBe(hash);expect('conversation_id' in raw).toBe(false);
  const home=z.object({conversation_id:z.uuid()}).parse((await sql`SELECT conversation_id FROM assistant.semantic_contexts WHERE id=${ctx}`)[0]);expect(home.conversation_id).toBe(f.a.conversation);
  const stored=z.object({link_home:z.uuid(),note_home:z.uuid(),source_home:z.uuid()}).parse((await sql`SELECT l.conversation_id AS link_home,n.conversation_id AS note_home,s.conversation_id AS source_home FROM assistant.semantic_context_links l JOIN assistant.semantic_context_notes n ON n.source_message_id=l.message_id JOIN assistant.semantic_context_sources s ON s.message_id=l.message_id WHERE l.message_id=${correction}`)[0]);expect(stored).toEqual({link_home:f.b.conversation,note_home:f.b.conversation,source_home:f.b.conversation});expect(await f.originals()).toBe(originals);
  const pages=await retainedContextSources(sql,f.a.scope,{context_id:ctx});expect(pages.sources.some(source=>source.message_id===correction&&source.conversation_id===f.b.conversation)).toBe(true);expect((await retainedContextNotes(sql,f.a.scope,{context_id:ctx})).notes.some(note=>note.id===newer.noteId)).toBe(true);
  const historical=await contextSnapshot(sql,f.b.scope,ctx,raw.sequence);expect(historical.notes.some(note=>note.id===old.noteId)).toBe(true);expect(historical.recent_messages.some(message=>message.message_id===correction)).toBe(false);
 }finally{await f.close();}
});
test('workspace references do not authorize foreign source inputs or cross-workspace access; retention follows real home',async()=>{
 const f=await fixture(),other=await fixture();try {
  const a=await f.message(f.a,'Calendar owner private turn'),b=await f.message(f.b,'Calendar reference'),foreign=await other.message(other.a,'Foreign workspace Calendar');
  const ctx=(await f.link(f.a,a)).context.context_id;await f.note(f.a,a,ctx);await f.link(f.b,b,ctx);
  await expect(f.prepare(f.b,a)).rejects.toThrow();await expect(contextSnapshot(sql,other.a.scope,ctx)).rejects.toThrow();
  const foreignContext=(await other.link(other.a,foreign)).context.context_id;await expect(f.link(f.b,await f.message(f.b,'Forbidden foreign Calendar'),foreignContext)).rejects.toThrow();
  await sql`UPDATE assistant.memory_retention_decisions SET action='deny_turn',quote='Calendar owner private turn' WHERE workspace_id=${f.workspace} AND source_message_id=${a}`;
  const allowed=await contextSnapshot(sql,f.b.scope,ctx);expect(allowed.recent_messages.some(message=>message.message_id===a)).toBe(false);expect(allowed.notes).toHaveLength(0);expect(allowed.recent_messages.some(message=>message.message_id===b)).toBe(true);
  const raw=await rawSource(sql,f.b.scope,b),request={operation_id:crypto.randomUUID(),context_id:ctx,expected_revision:allowed.revision,source_message_id:b,source_sha256:await hashToken(JSON.stringify(raw)),notes:[{id:crypto.randomUUID(),kind:'fact' as const,text:'Cross-home retained source',evidence:[{message_id:b,quote:raw.content}]}]};
  await expect(writeContextNotes(sql,f.a.principal,f.a.run,request)).rejects.toThrow();await writeContextNotes(sql,f.a.principal,f.a.run,{...request,mode:'backfill'});
  expect((await snapshotSemanticContext(sql,f.a.principal,f.a.run,ctx)).context.notes.some(note=>note.source_message_id===b)).toBe(true);
 }finally{await f.close();await other.close();}
});
test('assistant origin remains the exact run task despite a foreign context home',async()=>{
 const f=await fixture();try {
  const a=await f.message(f.a,'Calendar account initial'),b=await f.message(f.b,'Calendar account continuation'),assistant=await f.message(f.b,'Calendar account report','assistant'),ctx=(await f.link(f.a,a)).context.context_id;await f.link(f.b,b,ctx);
  const linked=await sql.begin(tx=>linkAssistantContext(tx,{...f.b.scope,run_id:f.b.run,context_id:ctx,message_id:assistant,source_message_id:b}));expect(linked?.originating_message_id).toBe(b);
  const another=await f.message(f.b,'Wrong origin report','assistant');await expect(sql.begin(tx=>linkAssistantContext(tx,{...f.b.scope,run_id:f.b.run,context_id:ctx,message_id:another,source_message_id:a}))).rejects.toThrow();
  const snapshot=await contextSnapshot(sql,f.a.scope,ctx);expect(snapshot.recent_messages.find(source=>source.message_id===assistant)?.conversation_id).toBe(f.b.conversation);
 }finally{await f.close();}
});
test('cross-conversation merge and undo preserve actual link provenance and reject stale or foreign context CAS',async()=>{
 const f=await fixture();try {
  const a=await f.message(f.a,'Calendar A'),b=await f.message(f.b,'Calendar B'),contextA=(await f.link(f.a,a)).context.context_id,contextB=(await f.link(f.b,b)).context.context_id;
  const originals=await f.originals(),principal:Principal={workspace_id:f.workspace,role:'client',vm_id:null};
  const revisions=await Promise.all([contextA,contextB].map(async context_id=>({context_id,expected_revision:(await contextSnapshot(sql,f.a.scope,context_id)).revision})));
  const applied=await reorganizeContexts(sql,{principal},{operation_id:crypto.randomUUID(),conversation_id:f.a.conversation,intent:'apply',contexts:revisions,moves:[{message_id:b,expected_link_revision:1,to:{kind:'existing',context_id:contextA}}],reason:'Explicit workspace topic merge'});expect(applied.status).toBe('applied');
  expect(z.object({conversation_id:z.uuid(),context_id:z.uuid()}).parse((await sql`SELECT conversation_id,context_id FROM assistant.semantic_context_links WHERE message_id=${b}`)[0])).toEqual({conversation_id:f.b.conversation,context_id:contextA});
  await undoContextReorganization(sql,{principal},{operation_id:crypto.randomUUID(),undo_operation_id:applied.operation_id,conversation_id:f.a.conversation});
  expect(z.object({conversation_id:z.uuid(),context_id:z.uuid()}).parse((await sql`SELECT conversation_id,context_id FROM assistant.semantic_context_links WHERE message_id=${b}`)[0])).toEqual({conversation_id:f.b.conversation,context_id:contextB});expect(await f.originals()).toBe(originals);
  await expect(reorganizeContexts(sql,{principal},{operation_id:crypto.randomUUID(),conversation_id:f.a.conversation,intent:'apply',contexts:revisions,moves:[{message_id:b,expected_link_revision:3,to:{kind:'existing',context_id:contextA}}],reason:'Stale context versions'})).rejects.toThrow();
 }finally{await f.close();}
});
test('simultaneous links from separate conversations serialize shared context revision CAS',async()=>{
 const f=await fixture(),release=Promise.withResolvers<void>();let held:Promise<unknown>|undefined;
 try {
  const initial=await f.message(f.a,'Calendar account concurrency'),ctx=(await f.link(f.a,initial)).context.context_id;
  const a=await f.message(f.a,'Calendar parallel A'),b=await f.message(f.b,'Calendar parallel B'),locked=Promise.withResolvers<number>();
  held=sql.begin(async tx=>{await tx`SET LOCAL statement_timeout='4s'`;await tx`SELECT id FROM assistant.semantic_contexts WHERE id=${ctx} FOR UPDATE`;locked.resolve(z.object({pid:z.number()}).parse((await tx`SELECT pg_backend_pid() AS pid`)[0]).pid);await release.promise;});
  const pid=await locked.promise,results=Promise.allSettled([f.link(f.a,a,ctx),f.link(f.b,b,ctx)]);
  let blocked=0;
  for(let attempt=0;attempt<200&&blocked<2;attempt++){
   blocked=z.object({count:z.coerce.number()}).parse((await sql`WITH RECURSIVE waiting(pid) AS (SELECT ${pid}::int UNION SELECT a.pid FROM pg_stat_activity a JOIN waiting w ON w.pid=ANY(pg_blocking_pids(a.pid))) SELECT count(*)-1 AS count FROM waiting`)[0]).count;
   if(blocked<2)await Bun.sleep(5);
  }
  release.resolve();await held;
  const settled=await results;expect(blocked).toBe(2);expect(settled.filter(result=>result.status==='fulfilled')).toHaveLength(1);
  const failure=settled.find(result=>result.status==='rejected');if(failure?.status!=='rejected')throw new TypeError('Concurrent stale revision accepted');
  const error=z.object({response:z.instanceof(Response)}).parse(failure.reason);expect(error.response.status).toBe(409);
  expect((await contextSnapshot(sql,f.a.scope,ctx)).revision).toBe(2);
  console.log(JSON.stringify({scenario:'cross-conversation CAS',blocked,outcomes:settled.map(result=>result.status),rejection_status:error.response.status}));
 }finally{release.resolve();await held;await f.close();}
});
test('cross-conversation split creates its home from moved source and preserves mixed-home evidence',async()=>{
 const f=await fixture();try{
  const a=await f.message(f.a,'Calendar first evidence'),b=await f.message(f.b,'Calendar second evidence'),ctx=(await f.link(f.a,a)).context.context_id;await f.link(f.b,b,ctx);
  const source=await rawSource(sql,f.b.scope,b),snapshot=await contextSnapshot(sql,f.a.scope,ctx),noteId=crypto.randomUUID();
  await writeContextNotes(sql,f.b.principal,f.b.run,{operation_id:crypto.randomUUID(),context_id:ctx,expected_revision:snapshot.revision,source_message_id:b,source_sha256:await hashToken(JSON.stringify(source)),notes:[{id:noteId,kind:'fact',text:'Two user sources support this topic',evidence:[{message_id:a,quote:'Calendar first evidence'},{message_id:b,quote:source.content}]}]});
  expect((await contextSnapshot(sql,f.a.scope,ctx)).notes.find(note=>note.id===noteId)?.evidence).toHaveLength(2);
  const original=await f.originals(),principal:Principal={workspace_id:f.workspace,role:'client',vm_id:null};
  const result=await reorganizeContexts(sql,{principal},{operation_id:crypto.randomUUID(),conversation_id:f.a.conversation,intent:'apply',contexts:[{context_id:ctx,expected_revision:(await contextSnapshot(sql,f.a.scope,ctx)).revision}],moves:[{message_id:b,expected_link_revision:1,to:{kind:'new',key:'split',title:'Split topic',scope:'Explicitly separated source'}}],reason:'User-directed split across original conversation homes'});
  const created=result.created_context_ids[0];if(!created)throw new TypeError('Split did not create context');
  expect(z.object({conversation_id:z.uuid(),initiating_message_id:z.uuid()}).parse((await sql`SELECT conversation_id,initiating_message_id FROM assistant.semantic_contexts WHERE id=${created}`)[0])).toEqual({conversation_id:f.b.conversation,initiating_message_id:b});
  expect((await contextSnapshot(sql,f.a.scope,ctx)).notes.some(note=>note.id===noteId)).toBe(false);
  expect((await contextSnapshot(sql,f.a.scope,created)).recent_messages.find(message=>message.message_id===b)?.conversation_id).toBe(f.b.conversation);
  await undoContextReorganization(sql,{principal},{operation_id:crypto.randomUUID(),undo_operation_id:result.operation_id,conversation_id:f.a.conversation});
  expect((await contextSnapshot(sql,f.b.scope,ctx)).notes.some(note=>note.id===noteId)).toBe(true);expect(await f.originals()).toBe(original);
 }finally{await f.close();}
});
test('file provenance stays in its source conversation and cross-workspace reorganization is rejected',async()=>{
 const f=await fixture(),foreign=await fixture();try{
  const a=await f.message(f.a,'Calendar file context'),b=await f.message(f.b,'Calendar file evidence'),ctx=(await f.link(f.a,a)).context.context_id,file=crypto.randomUUID();
  await sql`INSERT INTO assistant.artifacts(id,workspace_id,conversation_id,name,media_type,bytes,sha256,object_key,state,lease_id) VALUES(${file},${f.workspace},${f.b.conversation},'calendar.txt','text/plain',42,${'a'.repeat(64)},${'fixture/'+file},'ready',${crypto.randomUUID()})`;
  await sql`INSERT INTO assistant.message_artifacts(workspace_id,conversation_id,message_id,artifact_id,position) VALUES(${f.workspace},${f.b.conversation},${b},${file},0)`;
  const raw=await rawSource(sql,f.b.scope,b);await f.link(f.b,b,ctx);
  const snapshot=await contextSnapshot(sql,f.a.scope,ctx);expect(snapshot.files.map(item=>item.id)).toContain(file);expect(snapshot.recent_messages.find(message=>message.message_id===b)?.sha256).toBe(await hashToken(JSON.stringify(raw)));
  await expect((async()=>await sql`UPDATE assistant.semantic_context_links SET conversation_id=${f.a.conversation} WHERE workspace_id=${f.workspace} AND message_id=${b}`)()).rejects.toMatchObject({code:'23503'});
  const outsider=await foreign.message(foreign.a,'Calendar foreign topic'),foreignContext=(await foreign.link(foreign.a,outsider)).context;
  await expect(reorganizeContexts(sql,{principal:{workspace_id:f.workspace,role:'client',vm_id:null}},{operation_id:crypto.randomUUID(),conversation_id:f.a.conversation,intent:'apply',contexts:[{context_id:ctx,expected_revision:snapshot.revision},{context_id:foreignContext.context_id,expected_revision:foreignContext.revision}],moves:[{message_id:b,expected_link_revision:1,to:{kind:'existing',context_id:foreignContext.context_id}}],reason:'Invalid cross-workspace merge'})).rejects.toMatchObject({code:'invalid_context'});
  expect((await contextSnapshot(sql,f.a.scope,ctx)).recent_messages.find(message=>message.message_id===b)?.conversation_id).toBe(f.b.conversation);
 }finally{await f.close();await foreign.close();}
});
