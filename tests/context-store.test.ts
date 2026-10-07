import { afterAll, beforeAll, expect, test } from "bun:test";
import { z } from "zod";
import { Hono } from "hono";
import { createDatabase } from "../services/control/db";
import type { AppEnv, Principal } from "../services/control/auth";
import { inputHash } from "../packages/memory/source";
import { DomainError } from "../packages/protocol";
import { prepareSemanticContext, assessSemanticRetention, linkContext, writeContextNotes, snapshotSemanticContext, linkAssistantContext } from "../packages/context/store";
import type { LinkRequest, NotesRequest } from "../packages/context/schema";
import { semanticContextRoutes } from "../services/control/routes/semantic-context";
const url=process.env['TEST_DATABASE_URL']??'postgres://assistant:assistant@127.0.0.1:55439/semantic_context_1006';
const sql=createDatabase(url);
beforeAll(async()=>{const p=Bun.spawn(['bun','scripts/migrate.ts'],{env:{...process.env,DATABASE_URL:url},stdout:'pipe',stderr:'pipe'});expect(await p.exited).toBe(0)});
afterAll(async()=>{await sql.end()});
async function fixture(content='Use the amber observatory project and its telescope calibration.',assessed=true) {
 const workspace=crypto.randomUUID(),conversation=crypto.randomUUID(),vm=crypto.randomUUID(),task=crypto.randomUUID(),run=crypto.randomUUID();
 await sql`INSERT INTO assistant.workspaces(id,name) VALUES(${workspace},'semantic QA')`;
 await sql`INSERT INTO assistant.conversations(id,workspace_id,title) VALUES(${conversation},${workspace},'context fixture')`;
 await sql`INSERT INTO assistant.vms(id,workspace_id,name) VALUES(${vm},${workspace},'fixture VM')`;
 await sql`INSERT INTO assistant.tasks(id,workspace_id,conversation_id,objective,state) VALUES(${task},${workspace},${conversation},'context fixture','running')`;
 await sql`INSERT INTO assistant.runs(id,workspace_id,task_id,vm_id) VALUES(${run},${workspace},${task},${vm})`;
 const principal:Principal={workspace_id:workspace,role:'vm',vm_id:vm};
 async function message(text:string,role:'user'|'assistant'|'system'='user',taskId:string|null=task){const id=crypto.randomUUID();await sql`INSERT INTO assistant.messages(id,workspace_id,conversation_id,task_id,role,content) VALUES(${id},${workspace},${conversation},${taskId},${role},${text})`;if(role==='user'&&assessed){if(taskId)await sql`INSERT INTO assistant.memory_retention_decisions(workspace_id,task_id,source_message_id,action) VALUES(${workspace},${taskId},${id},'inherit')`;else await sql`INSERT INTO assistant.semantic_source_retention(workspace_id,conversation_id,source_message_id,action) VALUES(${workspace},${conversation},${id},'inherit')`;}return id}
 const id=await message(content);
 return {workspace,conversation,vm,task,run,principal,id,content,message};
}
async function initial(f:Awaited<ReturnType<typeof fixture>>) {
 const prepared=await prepareSemanticContext(sql,f.principal,f.run,{message_id:f.id});
 const request:z.input<typeof LinkRequest>={operation_id:crypto.randomUUID(),message_id:f.id,source_sha256:prepared.source.sha256,expected_link_revision:0,choice:{kind:'new',title:'Amber Observatory',scope:'Telescope calibration and observations'},status:'provisional',evidence:[{message_id:f.id,quote:f.content}]};
 return {prepared,request,result:await linkContext(sql,f.principal,f.run,request)};
}
async function code(action:Promise<unknown>,expected:string){try{await action;throw new Error('Expected rejection '+expected)}catch(error){expect(error).toBeInstanceOf(DomainError);if(error instanceof DomainError)expect(error.code).toBe(expected);else throw error}}

test('primary message linkage is idempotent by full payload, versioned and retained after task completion',async()=>{
 const f=await fixture(),{request,result}=await initial(f);
 expect(result.link.revision).toBe(1);expect(result.context.revision).toBe(1);
 expect(await linkContext(sql,f.principal,f.run,request)).toEqual(result);
 await code(linkContext(sql,f.principal,f.run,{...request,status:'confirmed'}),'idempotency_conflict');
 const next=await linkContext(sql,f.principal,f.run,{...request,operation_id:crypto.randomUUID(),expected_link_revision:1,choice:{kind:'existing',context_id:result.context.context_id,expected_context_revision:1},status:'confirmed'});
 expect(next.link.revision).toBe(2);expect(next.context.revision).toBe(2);
 await sql`UPDATE assistant.runs SET state='succeeded' WHERE id=${f.run}`;
 expect(await linkContext(sql,f.principal,f.run,request)).toEqual(result);
 expect(await sql`SELECT * FROM assistant.semantic_context_link_revisions WHERE workspace_id=${f.workspace}`).toHaveLength(2);
});

test('run ownership, conversation scope, task source, and stale source are enforced',async()=>{
 const f=await fixture(),other=await fixture(),p=await prepareSemanticContext(sql,f.principal,f.run,{message_id:f.id});
 await code(prepareSemanticContext(sql,other.principal,f.run,{message_id:f.id}),'stale_run');
 await code(prepareSemanticContext(sql,{...f.principal,role:'client',vm_id:null},f.run,{message_id:f.id}),'forbidden');
 await code(prepareSemanticContext(sql,f.principal,f.run,{message_id:other.id,mode:'backfill'}),'invalid_source');
 const old=await f.message('Earlier historical user source','user',null);
 await code(prepareSemanticContext(sql,f.principal,f.run,{message_id:old}),'invalid_source');
 expect((await prepareSemanticContext(sql,f.principal,f.run,{message_id:old,mode:'backfill'})).source.message_id).toBe(old);
 await sql`UPDATE assistant.messages SET content='changed source' WHERE id=${f.id}`;
 await code(linkContext(sql,f.principal,f.run,{operation_id:crypto.randomUUID(),message_id:f.id,source_sha256:p.source.sha256,expected_link_revision:0,choice:{kind:'new',title:'Changed',scope:'Changed'},status:'confirmed',evidence:[{message_id:f.id,quote:'changed source'}]}),'stale_source');
});

test('old lexical candidate beyond recent eight and the primary linked context are always discoverable',async()=>{
 const f=await fixture(),a=await initial(f);
 for(let n=0;n<20;n++) {
  const message=await f.message('Unrelated subject '+n),prepared=await prepareSemanticContext(sql,f.principal,f.run,{message_id:message});
  await linkContext(sql,f.principal,f.run,{operation_id:crypto.randomUUID(),message_id:message,source_sha256:prepared.source.sha256,expected_link_revision:0,choice:{kind:'new',title:'Unrelated '+n,scope:'separate subject'},status:'confirmed',evidence:[{message_id:message,quote:prepared.source.content}]});
 }
 const fresh=await f.message('Return to telescope calibration at the amber observatory');
 const p=await prepareSemanticContext(sql,f.principal,f.run,{message_id:fresh});
 expect(p.candidates.some(c=>c.context_id===a.result.context.context_id)).toBe(true);
 await sql`UPDATE assistant.semantic_contexts SET title='Old',scope='Old' WHERE id=${a.result.context.context_id}`;
 expect((await prepareSemanticContext(sql,f.principal,f.run,{message_id:f.id})).candidates.some(c=>c.context_id===a.result.context.context_id)).toBe(true);
});

test('history pages are chronological across more than eight historical tasks without executing them',async()=>{
 const f=await fixture();let last=f.id;
 for(let n=0;n<40;n++){const task=crypto.randomUUID();await sql`INSERT INTO assistant.tasks(id,workspace_id,conversation_id,objective,state) VALUES(${task},${f.workspace},${f.conversation},'historical','succeeded')`;last=await f.message('Historical source '+n,'user',task)}
 const first=await prepareSemanticContext(sql,f.principal,f.run,{message_id:last,mode:'backfill',history_after_sequence:0});
 expect(first.history.messages).toHaveLength(32);expect(first.history.has_more).toBe(true);
 const cursor=first.history.next_after_sequence;if(cursor===null)throw new Error('missing cursor');
 const second=await prepareSemanticContext(sql,f.principal,f.run,{message_id:last,mode:'backfill',history_after_sequence:cursor});
 const all=[...first.history.messages,...second.history.messages];expect(all).toHaveLength(41);expect(new Set(all.map(m=>m.message_id)).size).toBe(41);
 expect(all.map(m=>m.sequence)).toEqual(all.map(m=>m.sequence).sort((a,b)=>a-b));
 expect(await sql`SELECT id FROM assistant.tasks WHERE workspace_id=${f.workspace} AND state='succeeded'`).toHaveLength(40);
});

test('attachment-only message accepts complete real filename but rejects invented or partial quote',async()=>{
 const f=await fixture('');const artifact=crypto.randomUUID();
 await sql`INSERT INTO assistant.artifacts(id,workspace_id,conversation_id,name,media_type,bytes,sha256,object_key,state,lease_id) VALUES(${artifact},${f.workspace},${f.conversation},'observatory-notes.txt','text/plain',42,${'a'.repeat(64)},${'fixture/'+artifact},'ready',${crypto.randomUUID()})`;
 await sql`INSERT INTO assistant.message_artifacts(workspace_id,conversation_id,message_id,artifact_id,position) VALUES(${f.workspace},${f.conversation},${f.id},${artifact},0)`;
 const p=await prepareSemanticContext(sql,f.principal,f.run,{message_id:f.id});
 const body:z.input<typeof LinkRequest>={operation_id:crypto.randomUUID(),message_id:f.id,source_sha256:p.source.sha256,expected_link_revision:0,choice:{kind:'new',title:'File',scope:'File context'},status:'provisional',evidence:[{message_id:f.id,quote:'notes.txt'}]};
 await code(linkContext(sql,f.principal,f.run,body),'invalid_evidence');
 const result=await linkContext(sql,f.principal,f.run,{...body,evidence:[{message_id:f.id,quote:'observatory-notes.txt'}]});
 expect(result.context.files.map(file=>file.id)).toEqual([artifact]);
});

test('notes preserve revisions and supersession and reject stale writes or fake evidence',async()=>{
 const f=await fixture(),a=await initial(f),note=crypto.randomUUID();
 const body:z.input<typeof NotesRequest>={operation_id:crypto.randomUUID(),context_id:a.result.context.context_id,expected_revision:1,source_message_id:f.id,source_sha256:a.prepared.source.sha256,notes:[{id:note,kind:'decision',text:'Use the observatory project',evidence:[{message_id:f.id,quote:'amber observatory project'}]}]};
 const saved=await writeContextNotes(sql,f.principal,f.run,body);expect(saved.context.notes[0]?.basis).toBe('user_statement');expect(saved.context.revision).toBe(2);
 expect(await writeContextNotes(sql,f.principal,f.run,body)).toEqual(saved);
 await code(writeContextNotes(sql,f.principal,f.run,{...body,operation_id:crypto.randomUUID()}),'stale_revision');
 await code(writeContextNotes(sql,f.principal,f.run,{...body,operation_id:crypto.randomUUID(),expected_revision:2,notes:[{id:crypto.randomUUID(),kind:'fact',text:'fake',evidence:[{message_id:f.id,quote:'not in the source'}]}]}),'invalid_evidence');
 await code(writeContextNotes(sql,f.principal,f.run,{...body,operation_id:crypto.randomUUID(),expected_revision:2,notes:[{id:crypto.randomUUID(),kind:'constraint',text:'Same source cannot revise history',evidence:[{message_id:f.id,quote:'telescope calibration'}],supersedes:note}]}),'invalid_supersession');
 const later=await f.message('Correct the constraint: use telescope calibration.'),p=await prepareSemanticContext(sql,f.principal,f.run,{message_id:later});
 await linkContext(sql,f.principal,f.run,{operation_id:crypto.randomUUID(),message_id:later,source_sha256:p.source.sha256,expected_link_revision:0,choice:{kind:'existing',context_id:a.result.context.context_id,expected_context_revision:2},status:'confirmed',evidence:[{message_id:later,quote:p.source.content}]});
 const correction=await writeContextNotes(sql,f.principal,f.run,{...body,operation_id:crypto.randomUUID(),expected_revision:3,source_message_id:later,source_sha256:p.source.sha256,notes:[{id:crypto.randomUUID(),kind:'constraint',text:'Calibrate the telescope',evidence:[{message_id:later,quote:'telescope calibration'}],supersedes:note,valid_from:'2026-10-06T00:00:00Z'}]});
 expect(correction.context.notes).toHaveLength(1);expect(correction.context.notes[0]?.supersedes).toBe(note);
 const historical=await prepareSemanticContext(sql,f.principal,f.run,{message_id:f.id,mode:'backfill'});expect(historical.candidates.find(c=>c.context_id===a.result.context.context_id)?.notes.map(n=>n.id)).toEqual([note]);
 expect(await sql`SELECT id FROM assistant.semantic_context_notes WHERE context_id=${a.result.context.context_id}`).toHaveLength(2);
});

test('assistant linking is tied to run user context and mixed note batch uses per-note evidence roles',async()=>{
 const f=await fixture(),a=await initial(f),assistant=await f.message('I completed the calibration.','assistant');
 const scope={workspace:f.workspace,conversation:f.conversation,run_id:f.run,context_id:a.result.context.context_id,message_id:assistant};
 await sql.begin(tx=>linkAssistantContext(tx,scope));await sql.begin(tx=>linkAssistantContext(tx,scope));
 const snapshot=await snapshotSemanticContext(sql,f.principal,f.run,scope.context_id);const source=snapshot.context.recent_messages.find(m=>m.message_id===assistant);if(!source)throw new Error('Missing assistant source');
 expect(snapshot.context.recent_messages.some(m=>m.message_id===f.id)).toBe(true);
 const body:z.input<typeof NotesRequest>={operation_id:crypto.randomUUID(),context_id:scope.context_id,expected_revision:snapshot.context.revision,source_message_id:assistant,source_sha256:source.sha256,notes:[{id:crypto.randomUUID(),kind:'decision',text:'Use observatory',evidence:[{message_id:f.id,quote:'amber observatory project'}]},{id:crypto.randomUUID(),kind:'outcome',text:'Assistant reports calibration complete',evidence:[{message_id:assistant,quote:'I completed the calibration.'}]}]};
 const saved=await writeContextNotes(sql,f.principal,f.run,body);expect(saved.context.notes.find(n=>n.kind==='decision')?.basis).toBe('user_statement');expect(saved.context.notes.find(n=>n.kind==='outcome')?.basis).toBe('assistant_report');
 await code(writeContextNotes(sql,f.principal,f.run,{...body,operation_id:crypto.randomUUID(),expected_revision:saved.context.revision,notes:[{id:crypto.randomUUID(),kind:'fact',text:'Calibration is proven',evidence:[{message_id:assistant,quote:'completed'},{message_id:f.id,quote:'Use'}]}]}),'unsupported_fact');
 const foreign=await fixture(),b=await initial(foreign);
 await code(sql.begin(tx=>linkAssistantContext(tx,{...scope,context_id:b.result.context.context_id})),'invalid_context');
});

test('unassessed retention blocks linking; validated quoted deny blocks notes and literal quoted text is not regex-denied',async()=>{
 const f=await fixture('Do not remember this secret telescope password.',false);
 const prepared=await prepareSemanticContext(sql,f.principal,f.run,{message_id:f.id});expect(prepared.source.retention_allowed).toBe(false);
 await code(initial(f),'retention_denied');
 const assessment={input_hash:await inputHash(prepared.retention_context.sources),decisions:[{source_message_id:f.id,action:'deny_turn' as const,quote:f.content}]};
 const result=await assessSemanticRetention(sql,f.principal,f.run,{message_id:f.id,assessment});expect(result.retention_allowed).toBe(false);
 await code(initial(f),'retention_denied');
 const quoted=await fixture('Translate the quoted sentence "Do not remember this" into French.');
 expect((await initial(quoted)).prepared.source.retention_allowed).toBe(true);
});

test('retention pages are source-bounded, legacy-compatible and stale assessments cannot bypass missing predecessors',async()=>{
 const f=await fixture('Historical initial user',false);let last=f.id;
 for(let n=0;n<34;n++)last=await f.message('Earlier request '+n);
 const future=await f.message('Future request not yet applicable');
 const p=await prepareSemanticContext(sql,f.principal,f.run,{message_id:last});expect(p.retention_context.sources).toHaveLength(32);expect(p.retention_context.sources.some(s=>s.id===future)).toBe(false);
 const assess=async(message_id:string,sources:typeof p.retention_context.sources)=>assessSemanticRetention(sql,f.principal,f.run,{message_id,assessment:{input_hash:await inputHash(sources),decisions:sources.map(s=>({source_message_id:s.id,action:'inherit',quote:null}))}});
 const first=await assess(last,p.retention_context.sources);expect(first.retention_allowed).toBe(false);expect(first.retention_context.sources).toHaveLength(3);
 const final=await assess(last,first.retention_context.sources);expect(final.retention_allowed).toBe(true);
 const legacy=await f.message('Legacy taskless source','user',null);
 const old=await prepareSemanticContext(sql,f.principal,f.run,{message_id:legacy,mode:'backfill'});
 const legacyResult=await assessSemanticRetention(sql,f.principal,f.run,{message_id:legacy,mode:'backfill',assessment:{input_hash:await inputHash(old.retention_context.sources),decisions:old.retention_context.sources.map(s=>({source_message_id:s.id,action:'inherit',quote:null}))}});expect(legacyResult.retention_allowed).toBe(true);
 await code(assessSemanticRetention(sql,f.principal,f.run,{message_id:future,assessment:{input_hash:'a'.repeat(64),decisions:[]}}),'retention_snapshot_stale');
});

test('competing versioned commits cannot silently overwrite each other',async()=>{
 const f=await fixture(),a=await initial(f),ids=await Promise.all([f.message('First follow-up'),f.message('Second follow-up')]);
 const requests=await Promise.all(ids.map(async id=>{const p=await prepareSemanticContext(sql,f.principal,f.run,{message_id:id});return {operation_id:crypto.randomUUID(),message_id:id,source_sha256:p.source.sha256,expected_link_revision:0,choice:{kind:'existing' as const,context_id:a.result.context.context_id,expected_context_revision:1},status:'confirmed' as const,evidence:[{message_id:id,quote:p.source.content}]}}));
 const results=await Promise.allSettled(requests.map(body=>linkContext(sql,f.principal,f.run,body)));
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
});

test('prepare classifier runs outside transactions',async()=>{
 const f=await fixture();await initial(f);const fresh=await f.message('A new telescope request');
 let entered:()=>void=()=>undefined,release:()=>void=()=>undefined;
 const started=new Promise<void>(resolve=>{entered=resolve}),gate=new Promise<void>(resolve=>{release=resolve});
 const app=new Hono<AppEnv>();app.use('*',async(c,next)=>{c.set('principal',f.principal);await next()});
 app.route('/',semanticContextRoutes(sql,{classify:async()=>{entered();await gate;return {context_id:null,outcome:'uncertain',scores:[],model:'test'}}}));
 const response=app.request(`/context/${f.run}/semantic/prepare`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message_id:fresh})});
 await started;
 try{await sql.begin(async tx=>{await tx`SET LOCAL lock_timeout='200ms'`;await tx`UPDATE assistant.conversations SET title='not locked during inference' WHERE id=${f.conversation}`})}finally{release()}
 expect((await response).status).toBe(200);
});

test('terminal run backfill does not resume execution; future sources and derived notes do not leak backwards',async()=>{
 const f=await fixture(),a=await initial(f),later=await f.message('Later distinct outcome');
 const p=await prepareSemanticContext(sql,f.principal,f.run,{message_id:later});
 const b=await linkContext(sql,f.principal,f.run,{operation_id:crypto.randomUUID(),message_id:later,source_sha256:p.source.sha256,expected_link_revision:0,choice:{kind:'new',title:'Future private topic',scope:'Future-only details'},status:'confirmed',evidence:[{message_id:later,quote:p.source.content}]});
 await sql`UPDATE assistant.runs SET state='succeeded' WHERE id=${f.run}`;await sql`UPDATE assistant.tasks SET state='succeeded' WHERE id=${f.task}`;
 await code(prepareSemanticContext(sql,f.principal,f.run,{message_id:f.id}),'stale_run');
 const old=await prepareSemanticContext(sql,f.principal,f.run,{message_id:f.id,mode:'backfill'});expect(old.candidates.some(c=>c.context_id===b.context.context_id)).toBe(false);expect(old.candidates.flatMap(c=>c.recent_messages).every(m=>m.sequence<=old.source.sequence)).toBe(true);
 expect((await snapshotSemanticContext(sql,f.principal,f.run,a.result.context.context_id,'backfill')).context.context_id).toBe(a.result.context.context_id);
 expect(z.object({state:z.string()}).parse((await sql`SELECT state FROM assistant.runs WHERE id=${f.run}`)[0]).state).toBe('succeeded');
});

test('reassigning a source excludes obsolete notes from old context while preserving revision audit',async()=>{
 const f=await fixture(),a=await initial(f),note=crypto.randomUUID();
 await writeContextNotes(sql,f.principal,f.run,{operation_id:crypto.randomUUID(),context_id:a.result.context.context_id,expected_revision:1,source_message_id:f.id,source_sha256:a.prepared.source.sha256,notes:[{id:note,kind:'fact',text:'Observatory reference',evidence:[{message_id:f.id,quote:'amber observatory'}]}]});
 const moved=await linkContext(sql,f.principal,f.run,{...a.request,operation_id:crypto.randomUUID(),expected_link_revision:1,choice:{kind:'new',title:'Corrected scope',scope:'A different observatory'}});
 expect((await snapshotSemanticContext(sql,f.principal,f.run,a.result.context.context_id)).context.notes).toHaveLength(0);expect(moved.context.notes).toHaveLength(0);expect((await snapshotSemanticContext(sql,f.principal,f.run,a.result.context.context_id)).context.recent_messages).toHaveLength(0);
 expect((await prepareSemanticContext(sql,f.principal,f.run,{message_id:f.id})).candidates.some(c=>c.context_id===a.result.context.context_id)).toBe(false);
 expect(await sql`SELECT id FROM assistant.semantic_context_notes WHERE id=${note}`).toHaveLength(1);
});


test('retention retries preserve the recorded full decision and reject altered replay',async()=>{
 const f=await fixture('Remember this exact preference.',false),p=await prepareSemanticContext(sql,f.principal,f.run,{message_id:f.id});
 const request={message_id:f.id,assessment:{input_hash:await inputHash(p.retention_context.sources),decisions:[{source_message_id:f.id,action:'allow' as const,quote:f.content}]}};
 const first=await assessSemanticRetention(sql,f.principal,f.run,request);
 expect(await assessSemanticRetention(sql,f.principal,f.run,request)).toEqual(first);
 await code(assessSemanticRetention(sql,f.principal,f.run,{...request,assessment:{...request.assessment,decisions:[{source_message_id:f.id,action:'inherit',quote:null}]}}),'retention_decision_conflict');
 expect(await sql`SELECT source_message_id FROM assistant.memory_retention_decisions WHERE workspace_id=${f.workspace}`).toHaveLength(1);
});


test('HTTP retention, link and snapshot expose persisted sources while rejecting another conversation',async()=>{
 const f=await fixture('Keep the cyan telescope preference.',false),other=await fixture(),otherContext=await initial(other);
 const app=new Hono<AppEnv>();app.use('*',async(c,next)=>{c.set('principal',f.principal);await next()});
 app.onError((error,c)=>error instanceof DomainError?c.json({error:error.code},error.status):c.json({error:'unexpected'},500));
 app.route('/',semanticContextRoutes(sql));
 const call=(path:string,body:unknown)=>app.request(`/context/${f.run}/semantic/${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const prepared=await prepareSemanticContext(sql,f.principal,f.run,{message_id:f.id});
 const retention=await call('retention',{message_id:f.id,assessment:{input_hash:await inputHash(prepared.retention_context.sources),decisions:[{source_message_id:f.id,action:'inherit',quote:null}]}});expect(retention.status).toBe(200);expect(z.object({retention_allowed:z.boolean()}).parse(await retention.json()).retention_allowed).toBe(true);
 const linked=await call('link',{operation_id:crypto.randomUUID(),message_id:f.id,source_sha256:prepared.source.sha256,expected_link_revision:0,choice:{kind:'new',title:'Cyan',scope:'Telescope choice'},status:'confirmed',evidence:[{message_id:f.id,quote:f.content}]});expect(linked.status).toBe(200);
 const context=z.object({context:z.object({context_id:z.uuid()})}).parse(await linked.json()).context;
 const snapshot=await call('snapshot',{context_id:context.context_id});expect(snapshot.status).toBe(200);expect(z.object({context:z.object({recent_messages:z.array(z.object({message_id:z.uuid()}))})}).parse(await snapshot.json()).context.recent_messages.map(m=>m.message_id)).toEqual([f.id]);
 expect((await call('snapshot',{context_id:otherContext.result.context.context_id})).status).toBe(404);
});


test('assistant reports cannot supersede established user decisions even with a newer source',async()=>{
 const f=await fixture(),a=await initial(f),note=crypto.randomUUID();
 await writeContextNotes(sql,f.principal,f.run,{operation_id:crypto.randomUUID(),context_id:a.result.context.context_id,expected_revision:1,source_message_id:f.id,source_sha256:a.prepared.source.sha256,notes:[{id:note,kind:'decision',text:'User chose observatory',evidence:[{message_id:f.id,quote:f.content}]}]});
 const assistant=await f.message('I chose a different project.','assistant');
 await sql.begin(tx=>linkAssistantContext(tx,{workspace:f.workspace,conversation:f.conversation,run_id:f.run,context_id:a.result.context.context_id,message_id:assistant}));
 const snapshot=await snapshotSemanticContext(sql,f.principal,f.run,a.result.context.context_id),source=snapshot.context.recent_messages.find(m=>m.message_id===assistant);if(!source)throw new Error('Missing assistant source');
 await code(writeContextNotes(sql,f.principal,f.run,{operation_id:crypto.randomUUID(),context_id:a.result.context.context_id,expected_revision:3,source_message_id:assistant,source_sha256:source.sha256,notes:[{id:crypto.randomUUID(),kind:'outcome',text:'Assistant replaced user choice',evidence:[{message_id:assistant,quote:source.content}],supersedes:note}]}),'invalid_supersession');
 expect((await snapshotSemanticContext(sql,f.principal,f.run,a.result.context.context_id)).context.notes.map(n=>n.id)).toEqual([note]);
});

test('durable notes continue beyond 128 active records while responses remain bounded',async()=>{
 const f=await fixture(),a=await initial(f),evidence=JSON.stringify([{message_id:f.id,quote:f.content}]);
 await sql`INSERT INTO assistant.semantic_context_notes(id,workspace_id,conversation_id,context_id,context_revision,kind,text,evidence,basis,source_message_id,source_sha256,source_sequence) SELECT gen_random_uuid(),${f.workspace},${f.conversation},${a.result.context.context_id},1,'fact','Existing source-bound fact',${evidence}::text::jsonb,'user_statement',${f.id},${a.prepared.source.sha256},${a.prepared.source.sequence} FROM generate_series(1,128)`;
 const saved=await writeContextNotes(sql,f.principal,f.run,{operation_id:crypto.randomUUID(),context_id:a.result.context.context_id,expected_revision:1,source_message_id:f.id,source_sha256:a.prepared.source.sha256,notes:[{id:crypto.randomUUID(),kind:'fact',text:'Additional durable fact',evidence:[{message_id:f.id,quote:f.content}]}]});
 expect(saved.context.notes).toHaveLength(16);expect(await sql`SELECT id FROM assistant.semantic_context_notes WHERE context_id=${a.result.context.context_id}`).toHaveLength(129);
});


test('suppressed context sources hide derived metadata, raw messages and notes',async()=>{
 const f=await fixture(),a=await initial(f);
 await sql`INSERT INTO assistant.memory_suppressions(workspace_id,source_message_id) VALUES(${f.workspace},${f.id})`;
 const snapshot=await snapshotSemanticContext(sql,f.principal,f.run,a.result.context.context_id);
 expect(snapshot.context.recent_messages).toHaveLength(0);expect(snapshot.context.notes).toHaveLength(0);
 expect(snapshot.context.title).not.toBe(a.result.context.title);expect(snapshot.context.scope).not.toBe(a.result.context.scope);
});


test('prepare skips inference for pending retention and previously linked messages',async()=>{
 const pending=await fixture('Unassessed source',false),linked=await fixture();await initial(linked);
 let calls=0;
 for(const f of [pending,linked]) {
  const app=new Hono<AppEnv>();app.use('*',async(c,next)=>{c.set('principal',f.principal);await next()});
  app.route('/',semanticContextRoutes(sql,{retrieve:async()=>{calls++;return []},classify:async()=>{calls++;return {context_id:null,outcome:'new',scores:[],model:'test'}}}));
  expect((await app.request(`/context/${f.run}/semantic/prepare`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message_id:f.id})})).status).toBe(200);
 }
 expect(calls).toBe(0);
});

test('retrieval outage retains lexical candidates and abstains without invoking classification',async()=>{
 const f=await fixture(),a=await initial(f),fresh=await f.message('Return to amber observatory');let classified=false;
 const app=new Hono<AppEnv>();app.use('*',async(c,next)=>{c.set('principal',f.principal);await next()});
 app.route('/',semanticContextRoutes(sql,{retrieve:async()=>{throw new DOMException('Embedding provider timed out','TimeoutError')},classify:async()=>{classified=true;return {context_id:null,outcome:'new',scores:[],model:'test'}}}));
 const response=await app.request(`/context/${f.run}/semantic/prepare`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message_id:fresh})});expect(response.status).toBe(200);
 const body=z.object({decision:z.object({outcome:z.string()}),candidates:z.array(z.object({context_id:z.uuid()}))}).parse(await response.json());
 expect(body.decision.outcome).toBe('uncertain');expect(body.candidates.some(c=>c.context_id===a.result.context.context_id)).toBe(true);expect(classified).toBe(false);
});
