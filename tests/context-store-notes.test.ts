import { afterAll, beforeAll, expect, test } from "bun:test";
import { z } from "zod";
import { Hono } from "hono";
import { PrepareResult, SemanticSource, SemanticSnapshotRequest } from "../packages/context/schema";
import { semanticContextRoutes } from "../services/control/routes/semantic-context";
import { createDatabase } from "../services/control/db";
import { hashToken, type Principal, type AppEnv } from "../services/control/auth";
import { rawSource } from "../packages/context/store-source";
import { prepareSemanticContext, linkContext, linkAssistantContext, retainedContextNotes, retainedContextSources, snapshotSemanticContext } from "../packages/context/store";
import { DomainError } from "../packages/protocol";
const url=process.env['TEST_DATABASE_URL']??'postgres://assistant:assistant@127.0.0.1:55439/semantic_context_1006';
const sql=createDatabase(url);
beforeAll(async()=>{const p=Bun.spawn(['bun','scripts/migrate.ts'],{env:{...process.env,DATABASE_URL:url},stdout:'pipe',stderr:'pipe'});expect(await p.exited).toBe(0)});
afterAll(()=>sql.end());
async function fixture() {
 const workspace=crypto.randomUUID(),conversation=crypto.randomUUID(),vm=crypto.randomUUID(),task=crypto.randomUUID(),run=crypto.randomUUID(),message=crypto.randomUUID();
 await sql`INSERT INTO assistant.workspaces(id,name) VALUES(${workspace},'note retrieval QA')`;
 await sql`INSERT INTO assistant.conversations(id,workspace_id,title) VALUES(${conversation},${workspace},'note retrieval')`;
 await sql`INSERT INTO assistant.vms(id,workspace_id,name) VALUES(${vm},${workspace},'fixture')`;
 await sql`INSERT INTO assistant.tasks(id,workspace_id,conversation_id,objective,state) VALUES(${task},${workspace},${conversation},'notes','running')`;
 await sql`INSERT INTO assistant.runs(id,workspace_id,task_id,vm_id) VALUES(${run},${workspace},${task},${vm})`;
 await sql`INSERT INTO assistant.messages(id,workspace_id,conversation_id,task_id,role,content) VALUES(${message},${workspace},${conversation},${task},'user','Original exact evidence')`;
 await sql`INSERT INTO assistant.memory_retention_decisions(workspace_id,task_id,source_message_id,action) VALUES(${workspace},${task},${message},'inherit')`;
 const principal:Principal={workspace_id:workspace,role:'vm',vm_id:vm};
 const prepared=await prepareSemanticContext(sql,principal,run,{message_id:message});
 const linked=await linkContext(sql,principal,run,{operation_id:crypto.randomUUID(),message_id:message,source_sha256:prepared.source.sha256,expected_link_revision:0,choice:{kind:'new',title:'Original topic',scope:'Source-bound notes'},status:'confirmed',evidence:[{message_id:message,quote:'Original exact evidence'}]});
 return {workspace,conversation,task,run,message,principal,source:prepared.source,context:linked.context};
}

test('classifier outage preserves retrieved evidence for fallback without linking the new message',async()=>{
 const f=await fixture(),fresh=crypto.randomUUID();
 await sql`INSERT INTO assistant.messages(id,workspace_id,conversation_id,task_id,role,content) VALUES(${fresh},${f.workspace},${f.conversation},${f.task},'user','Return to original topic')`;
 await sql`INSERT INTO assistant.memory_retention_decisions(workspace_id,task_id,source_message_id,action) VALUES(${f.workspace},${f.task},${fresh},'inherit')`;
 let calls=0;
 const app=new Hono<AppEnv>();app.use('*',async(c,next)=>{c.set('principal',f.principal);await next()});
 app.onError((_error,c)=>c.json({error:'classifier unavailable'},500));
 app.route('/',semanticContextRoutes(sql,{retrieve:async()=>[{context_id:f.context.context_id,source_windows:[{message_id:f.message,start:0,end:23}]}],classify:async()=>{calls++;throw new DOMException('Classifier timed out','TimeoutError')}}));
 const response=await app.request(`/context/${f.run}/semantic/prepare`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message_id:fresh})});
 expect(response.status).toBe(200);
 const body=PrepareResult.parse(await response.json());
 expect(body.decision).toEqual({context_id:null,outcome:'uncertain',scores:[],model:'classifier-unavailable'});
 expect(body.source.message_id).toBe(fresh);expect(body.linked).toBeNull();expect(calls).toBe(1);
 expect(body.candidates[0]?.context_id).toBe(f.context.context_id);
 expect(body.candidates[0]?.recent_messages[0]?.content).toBe('Original exact evidence');
 expect(await sql`SELECT 1 FROM assistant.semantic_context_links WHERE message_id=${fresh}`).toHaveLength(0);
 expect(await sql`SELECT 1 FROM assistant.tasks WHERE workspace_id=${f.workspace}`).toHaveLength(1);
});

test('snapshot preserves query-ranked source windows instead of chronological ordering',async()=>{
 const f=await fixture(),later=crypto.randomUUID(),content='Later reference';
 await sql`INSERT INTO assistant.messages(id,workspace_id,conversation_id,task_id,role,content) VALUES(${later},${f.workspace},${f.conversation},${f.task},'user',${content})`;
 await sql`INSERT INTO assistant.memory_retention_decisions(workspace_id,task_id,source_message_id,action) VALUES(${f.workspace},${f.task},${later},'inherit')`;
 const prepared=await prepareSemanticContext(sql,f.principal,f.run,{message_id:later});
 await linkContext(sql,f.principal,f.run,{operation_id:crypto.randomUUID(),message_id:later,source_sha256:prepared.source.sha256,expected_link_revision:0,choice:{kind:'existing',context_id:f.context.context_id,expected_context_revision:1},status:'confirmed',evidence:[{message_id:later,quote:content}]});
 const windows=[{message_id:later,start:0,end:content.length},{message_id:f.message,start:0,end:23}];
 const result=await snapshotSemanticContext(sql,f.principal,f.run,f.context.context_id,'live',[],[],windows);
 expect(result.context.retrieval.source_windows).toEqual(windows);
 expect(result.context.recent_messages.map(source=>source.message_id)).toEqual([f.message,later]);
});

test('classifier fallback does not accept a context outside the offered candidates',async()=>{
 const f=await fixture(),fresh=crypto.randomUUID();
 await sql`INSERT INTO assistant.messages(id,workspace_id,conversation_id,task_id,role,content) VALUES(${fresh},${f.workspace},${f.conversation},${f.task},'user','Return to original topic')`;
 await sql`INSERT INTO assistant.memory_retention_decisions(workspace_id,task_id,source_message_id,action) VALUES(${f.workspace},${f.task},${fresh},'inherit')`;
 const app=new Hono<AppEnv>();app.use('*',async(c,next)=>{c.set('principal',f.principal);await next()});
 app.onError((error,c)=>error instanceof DomainError?c.json({error:error.code},error.status):c.json({error:'unexpected'},500));
 app.route('/',semanticContextRoutes(sql,{classify:async()=>({context_id:crypto.randomUUID(),outcome:'existing',scores:[],model:'fixture'})}));
 const response=await app.request(`/context/${f.run}/semantic/prepare`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message_id:fresh})});
 expect(response.status).toBe(503);expect(await response.json()).toEqual({error:'invalid_context_decision'});
 expect(await sql`SELECT 1 FROM assistant.semantic_context_links WHERE message_id=${fresh}`).toHaveLength(0);
});

test('selected historical notes and validated keyset pages expose more than recent16 without crossing scope',async()=>{
 const f=await fixture(),evidence=JSON.stringify([{message_id:f.message,quote:'Original exact evidence'}]);
 const inserted=z.array(z.object({id:z.uuid(),context_revision:z.number()})).parse(await sql`INSERT INTO assistant.semantic_context_notes(id,workspace_id,conversation_id,context_id,context_revision,kind,text,evidence,basis,source_message_id,source_sha256,source_sequence) SELECT gen_random_uuid(),${f.workspace},${f.conversation},${f.context.context_id},n,'fact','Historical note '||n,${evidence}::text::jsonb,'user_statement',${f.message},${f.source.sha256},${f.source.sequence} FROM generate_series(1,40) n RETURNING id,context_revision`);
 const oldest=inserted.find(note=>note.context_revision===1);if(!oldest)throw new Error('Missing fixture note');
 const ordinary=await snapshotSemanticContext(sql,f.principal,f.run,f.context.context_id);expect(ordinary.context.notes).toHaveLength(16);expect(ordinary.context.notes.some(note=>note.id===oldest.id)).toBe(false);
 const selected=await snapshotSemanticContext(sql,f.principal,f.run,f.context.context_id,'live',[oldest.id]);expect(selected.context.notes).toHaveLength(17);expect(selected.context.notes.some(note=>note.id===oldest.id)).toBe(true);expect(selected.context.retrieval.note_ids).toEqual([oldest.id]);
 const linked=await linkContext(sql,f.principal,f.run,{operation_id:crypto.randomUUID(),message_id:f.message,source_sha256:f.source.sha256,expected_link_revision:1,choice:{kind:'existing',context_id:f.context.context_id,expected_context_revision:1},status:'confirmed',evidence:[{message_id:f.message,quote:'Original exact evidence'}],note_ids:selected.context.retrieval.note_ids});expect(linked.context.notes.some(note=>note.id===oldest.id)).toBe(true);
 const ids:string[]=[];let cursor:string|undefined;
 do{const page=await retainedContextNotes(sql,f,{context_id:f.context.context_id,limit:17,...(cursor?{after_id:cursor}:{})});ids.push(...page.notes.map(note=>note.id));cursor=page.next_after_id??undefined}while(cursor);
 expect(new Set(ids).size).toBe(40);
 expect((await retainedContextNotes(sql,{workspace:crypto.randomUUID(),conversation:f.conversation},{context_id:f.context.context_id})).notes).toHaveLength(0);
 await sql`INSERT INTO assistant.memory_suppressions(workspace_id,source_message_id) VALUES(${f.workspace},${f.message})`;
 const suppressed=await retainedContextNotes(sql,f,{context_id:f.context.context_id,limit:1});expect(suppressed.notes).toHaveLength(0);expect(suppressed.next_after_id).not.toBeNull();
 expect((await snapshotSemanticContext(sql,f.principal,f.run,f.context.context_id,'live',[oldest.id])).context.notes).toHaveLength(0);
});

test('assistant event skips semantic persistence when the current user turn forbids retention',async()=>{
 const f=await fixture(),user=crypto.randomUUID(),assistant=crypto.randomUUID();
 await sql`INSERT INTO assistant.messages(id,workspace_id,conversation_id,task_id,role,content) VALUES(${user},${f.workspace},${f.conversation},${f.task},'user','Do not remember this turn')`;
 await sql`INSERT INTO assistant.memory_retention_decisions(workspace_id,task_id,source_message_id,action,quote) VALUES(${f.workspace},${f.task},${user},'deny_turn','Do not remember this turn')`;
 await sql`INSERT INTO assistant.messages(id,workspace_id,conversation_id,task_id,role,content) VALUES(${assistant},${f.workspace},${f.conversation},${f.task},'assistant','Private response')`;
 const result=await sql.begin(tx=>linkAssistantContext(tx,{workspace:f.workspace,conversation:f.conversation,run_id:f.run,context_id:f.context.context_id,message_id:assistant}));
 expect(result).toBeNull();expect(await sql`SELECT 1 FROM assistant.semantic_context_sources WHERE workspace_id=${f.workspace} AND message_id=${assistant}`).toHaveLength(0);expect(await sql`SELECT 1 FROM assistant.semantic_context_links WHERE workspace_id=${f.workspace} AND message_id=${assistant}`).toHaveLength(0);expect(await sql`SELECT 1 FROM assistant.messages WHERE id=${assistant}`).toHaveLength(1);
});


test('source pages preserve full text, reject stale hashes and retrieve selected older members',async()=>{
 const f=await fixture(),ids:string[]=[],originalTime='2023-04-05T06:07:08.000Z',long='prefix '+'.'.repeat(20000)+' meaningful ending';
 for(let n=0;n<8;n++) {
  const id=crypto.randomUUID(),content=n===0?long:'New source '+n;ids.push(id);
  await sql`INSERT INTO assistant.messages(id,workspace_id,conversation_id,task_id,role,content,created_at) VALUES(${id},${f.workspace},${f.conversation},${f.task},'user',${content},${originalTime})`;
  await sql`INSERT INTO assistant.memory_retention_decisions(workspace_id,task_id,source_message_id,action) VALUES(${f.workspace},${f.task},${id},'inherit')`;
  const prepared=await prepareSemanticContext(sql,f.principal,f.run,{message_id:id});
  await linkContext(sql,f.principal,f.run,{operation_id:crypto.randomUUID(),message_id:id,source_sha256:prepared.source.sha256,expected_link_revision:0,choice:{kind:'existing',context_id:f.context.context_id,expected_context_revision:n+1},status:'confirmed',evidence:[{message_id:id,quote:content.slice(0,100)}]});
 }
 const oldest=ids[0];if(!oldest)throw new Error('Missing oldest source');
 const page=await retainedContextSources(sql,f,{context_id:f.context.context_id,limit:2});expect(page.sources.find(source=>source.message_id===oldest)?.content).toBe(long);expect(page.sources.every(source=>source.linked_context_id===f.context.context_id)).toBe(true);expect(page.next_after_sequence).not.toBeNull();
 const initial=await retainedContextSources(sql,f,{context_id:f.context.context_id,through:f.source.sequence});expect(initial.sources.map(source=>source.message_id)).toEqual([f.message]);
 const ordinary=await snapshotSemanticContext(sql,f.principal,f.run,f.context.context_id);expect(ordinary.context.recent_messages.some(source=>source.message_id===oldest)).toBe(false);
 const selected=await snapshotSemanticContext(sql,f.principal,f.run,f.context.context_id,'live',[],[oldest]);expect(selected.context.recent_messages.some(source=>source.message_id===oldest)).toBe(true);
 const fresh=crypto.randomUUID();
 await sql`INSERT INTO assistant.messages(id,workspace_id,conversation_id,task_id,role,content) VALUES(${fresh},${f.workspace},${f.conversation},${f.task},'user','Recall the meaningful ending')`;
 await sql`INSERT INTO assistant.memory_retention_decisions(workspace_id,task_id,source_message_id,action) VALUES(${f.workspace},${f.task},${fresh},'inherit')`;
 const app=new Hono<AppEnv>();app.use('*',async(c,next)=>{c.set('principal',f.principal);await next()});
 app.route('/',semanticContextRoutes(sql,{retrieve:async()=>[{context_id:f.context.context_id,source_windows:[{message_id:oldest,start:20000,end:22000}]}]}));
 const response=await app.request(`/context/${f.run}/semantic/prepare`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message_id:fresh})});expect(response.status).toBe(200);
 const prepared=PrepareResult.parse(await response.json()),candidate=prepared.candidates.find(context=>context.context_id===f.context.context_id);if(!candidate)throw new Error('Missing retrieved context');
 const hit=candidate.recent_messages.find(source=>source.message_id===oldest);expect(hit?.content).toBe(long.slice(20000));expect(hit?.content_offset).toBe(20000);expect(hit?.created_at).toBe(originalTime);expect(hit?.truncated).toBe(true);expect(hit?.sha256).toBe(page.sources.find(source=>source.message_id===oldest)?.sha256);
 const linked=await linkContext(sql,f.principal,f.run,{operation_id:crypto.randomUUID(),message_id:fresh,source_sha256:prepared.source.sha256,expected_link_revision:0,choice:{kind:'existing',context_id:f.context.context_id,expected_context_revision:candidate.revision},status:'confirmed',evidence:[{message_id:fresh,quote:prepared.source.content}],...candidate.retrieval});
 expect(linked.context.recent_messages.find(source=>source.message_id===oldest)?.content).toBe(long.slice(20000));expect(linked.context.recent_messages.some(source=>source.message_id===fresh)).toBe(true);expect(linked.context.recent_messages.find(source=>source.message_id===oldest)?.created_at).toBe(originalTime);
 expect(SemanticSnapshotRequest.safeParse({context_id:f.context.context_id,source_windows:[{message_id:oldest,start:0,end:2401}]}).success).toBe(false);
 await sql`UPDATE assistant.messages SET content='Changed content after linking' WHERE id=${oldest}`;
 expect((await retainedContextSources(sql,f,{context_id:f.context.context_id})).sources.some(source=>source.message_id===oldest)).toBe(false);
});


test('assistant origin keeps response A eligible when unassessed user B arrives during inference',async()=>{
 const f=await fixture(),next=crypto.randomUUID(),assistant=crypto.randomUUID();
 await sql`INSERT INTO assistant.messages(id,workspace_id,conversation_id,task_id,role,content) VALUES(${next},${f.workspace},${f.conversation},${f.task},'user','A new unrelated request B')`;
 await sql`INSERT INTO assistant.messages(id,workspace_id,conversation_id,task_id,role,content) VALUES(${assistant},${f.workspace},${f.conversation},${f.task},'assistant','Response to original request A')`;
 const link=await sql.begin(tx=>linkAssistantContext(tx,{workspace:f.workspace,conversation:f.conversation,run_id:f.run,context_id:f.context.context_id,message_id:assistant,source_message_id:f.message}));
 expect(link?.originating_message_id).toBe(f.message);
 const snapshot=await snapshotSemanticContext(sql,f.principal,f.run,f.context.context_id);expect(snapshot.context.recent_messages.find(source=>source.message_id===assistant)?.retention_allowed).toBe(true);
 expect((await retainedContextSources(sql,f,{context_id:f.context.context_id})).sources.some(source=>source.message_id===assistant)).toBe(true);
 await sql`INSERT INTO assistant.memory_suppressions(workspace_id,source_message_id) VALUES(${f.workspace},${f.message})`;
 expect((await snapshotSemanticContext(sql,f.principal,f.run,f.context.context_id)).context.recent_messages.some(source=>source.message_id===assistant)).toBe(false);
});


test('explicitly suppressed assistant source stays unrecorded even with an allowed user origin',async()=>{
 const f=await fixture(),assistant=crypto.randomUUID();
 await sql`INSERT INTO assistant.messages(id,workspace_id,conversation_id,task_id,role,content) VALUES(${assistant},${f.workspace},${f.conversation},${f.task},'assistant','Suppressed assistant source')`;
 await sql`INSERT INTO assistant.memory_suppressions(workspace_id,source_message_id) VALUES(${f.workspace},${assistant})`;
 expect(await sql.begin(tx=>linkAssistantContext(tx,{workspace:f.workspace,conversation:f.conversation,run_id:f.run,context_id:f.context.context_id,message_id:assistant,source_message_id:f.message}))).toBeNull();
 expect(await sql`SELECT 1 FROM assistant.semantic_context_sources WHERE workspace_id=${f.workspace} AND message_id=${assistant}`).toHaveLength(0);
});


test('source digest binds original creation time while legacy wire payloads retain nullable compatibility',async()=>{
 const f=await fixture(),raw=await rawSource(sql,f,f.message);
 const recorded=z.object({created_at:z.string()}).parse((await sql`SELECT created_at FROM assistant.messages WHERE workspace_id=${f.workspace} AND id=${f.message}`)[0]).created_at;
 expect(f.source.created_at).toBe(recorded);
 expect(f.source.sha256).toBe(await hashToken(JSON.stringify({...raw,created_at:recorded})));
 expect(f.source.sha256).not.toBe(await hashToken(JSON.stringify({...raw,created_at:'2001-01-01T00:00:00.000Z'})));
 const {created_at,...legacy}=f.source;expect(SemanticSource.parse(legacy).created_at).toBeNull();
});
