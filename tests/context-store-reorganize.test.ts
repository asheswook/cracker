import { afterAll, beforeAll, expect, test } from "bun:test";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Principal } from "../services/control/auth";
import { createDatabase } from "../services/control/db";
import { DomainError } from "../packages/protocol";
import { prepareSemanticContext, linkContext, writeContextNotes, snapshotSemanticContext, linkAssistantContext } from "../packages/context/store";
import { reorganizeContexts, undoContextReorganization, contextProposals } from "../packages/context/store-reorganize";
import type { ReorganizeRequest } from "../packages/context/reorganize-schema";
import { semanticContextClientRoutes } from "../services/control/routes/semantic-context";
const url=process.env['TEST_DATABASE_URL']??'postgres://assistant:assistant@127.0.0.1:55439/semantic_context_1006',sql=createDatabase(url);
beforeAll(async()=>{const p=Bun.spawn(['bun','scripts/migrate.ts'],{env:{...process.env,DATABASE_URL:url},stdout:'pipe',stderr:'pipe'});expect(await p.exited).toBe(0)});
afterAll(()=>sql.end());
async function fixture(status:'confirmed'|'provisional'='confirmed') {
 const workspace=crypto.randomUUID(),conversation=crypto.randomUUID(),vm=crypto.randomUUID(),task=crypto.randomUUID(),run=crypto.randomUUID();
 await sql`INSERT INTO assistant.workspaces(id,name) VALUES(${workspace},'organization QA')`;
 await sql`INSERT INTO assistant.conversations(id,workspace_id,title) VALUES(${conversation},${workspace},'organization')`;
 await sql`INSERT INTO assistant.vms(id,workspace_id,name) VALUES(${vm},${workspace},'fixture')`;
 await sql`INSERT INTO assistant.tasks(id,workspace_id,conversation_id,objective,state) VALUES(${task},${workspace},${conversation},'organization','running')`;
 await sql`INSERT INTO assistant.runs(id,workspace_id,task_id,vm_id) VALUES(${run},${workspace},${task},${vm})`;
 const principal:Principal={workspace_id:workspace,role:'vm',vm_id:vm},client:Principal={workspace_id:workspace,role:'client',vm_id:null};
 async function message(content:string){const id=crypto.randomUUID();await sql`INSERT INTO assistant.messages(id,workspace_id,conversation_id,task_id,role,content) VALUES(${id},${workspace},${conversation},${task},'user',${content})`;await sql`INSERT INTO assistant.memory_retention_decisions(workspace_id,task_id,source_message_id,action) VALUES(${workspace},${task},${id},'inherit')`;return prepareSemanticContext(sql,principal,run,{message_id:id})}
 const first=await message('Topic A original'),a=await linkContext(sql,principal,run,{operation_id:crypto.randomUUID(),message_id:first.source.message_id,source_sha256:first.source.sha256,expected_link_revision:0,choice:{kind:'new',title:'A',scope:'Original A'},status,evidence:[{message_id:first.source.message_id,quote:first.source.content}]});
 const second=await message('Topic A second'),a2=await linkContext(sql,principal,run,{operation_id:crypto.randomUUID(),message_id:second.source.message_id,source_sha256:second.source.sha256,expected_link_revision:0,choice:{kind:'existing',context_id:a.context.context_id,expected_context_revision:1},status,evidence:[{message_id:second.source.message_id,quote:second.source.content}]});
 const third=await message('Topic B original'),b=await linkContext(sql,principal,run,{operation_id:crypto.randomUUID(),message_id:third.source.message_id,source_sha256:third.source.sha256,expected_link_revision:0,choice:{kind:'new',title:'B',scope:'Original B'},status,evidence:[{message_id:third.source.message_id,quote:third.source.content}]});
 const request:z.input<typeof ReorganizeRequest>={operation_id:crypto.randomUUID(),conversation_id:conversation,intent:'apply',contexts:[{context_id:a.context.context_id,expected_revision:2},{context_id:b.context.context_id,expected_revision:1}],moves:[a.link,a2.link].map(link=>({message_id:link.message_id,expected_link_revision:1,to:{kind:'existing',context_id:b.context.context_id}})),reason:'Correct topic membership'};
 return {workspace,conversation,task,run,principal,client,first:first.source,second:second.source,third:third.source,a:a.context.context_id,b:b.context.context_id,request};
}
async function rejects(action:Promise<unknown>,code:string){try{await action;throw new Error('Expected '+code)}catch(error){expect(error).toBeInstanceOf(DomainError);if(error instanceof DomainError)expect(error.code).toBe(code);else throw error}}
async function membership(f:Awaited<ReturnType<typeof fixture>>) {return z.array(z.object({message_id:z.uuid(),context_id:z.uuid(),revision:z.number(),status:z.string()})).parse(await sql`SELECT message_id,context_id,revision,status FROM assistant.semantic_context_links WHERE workspace_id=${f.workspace} ORDER BY message_id`)}

test('client merge and undo are atomic, revisioned, idempotent and preserve note audit',async()=>{
 const f=await fixture(),note=crypto.randomUUID();
 await writeContextNotes(sql,f.principal,f.run,{operation_id:crypto.randomUUID(),context_id:f.a,expected_revision:2,source_message_id:f.first.message_id,source_sha256:f.first.sha256,notes:[{id:note,kind:'fact',text:'Original A fact',evidence:[{message_id:f.first.message_id,quote:f.first.content}]}]});
 const request={...f.request,contexts:[{context_id:f.a,expected_revision:3},{context_id:f.b,expected_revision:1}]};
 const result=await reorganizeContexts(sql,{principal:f.client},request);expect(result.status).toBe('applied');expect(result.moves).toHaveLength(2);expect((await membership(f)).every(link=>link.context_id===f.b)).toBe(true);
 expect((await snapshotSemanticContext(sql,f.principal,f.run,f.a)).context.notes).toHaveLength(0);expect(await reorganizeContexts(sql,{principal:f.client},request)).toEqual(result);
 await rejects(reorganizeContexts(sql,{principal:f.client},{...request,reason:'Changed payload'}),'idempotency_conflict');
 const undo={operation_id:crypto.randomUUID(),undo_operation_id:result.operation_id,conversation_id:f.conversation};
 const restored=await undoContextReorganization(sql,{principal:f.client},undo);expect(restored.status).toBe('undone');expect((await membership(f)).filter(link=>link.context_id===f.a)).toHaveLength(2);expect((await snapshotSemanticContext(sql,f.principal,f.run,f.a)).context.notes.map(item=>item.id)).toEqual([note]);
 expect(await undoContextReorganization(sql,{principal:f.client},undo)).toEqual(restored);expect(await sql`SELECT 1 FROM assistant.semantic_context_link_revisions WHERE workspace_id=${f.workspace}`).toHaveLength(7);
});

test('split shares one new target and undo retains its empty audited context',async()=>{
 const f=await fixture(),to={kind:'new' as const,key:'split',title:'Split topic',scope:'Explicit corrected topic'};
 const result=await reorganizeContexts(sql,{principal:f.client},{...f.request,contexts:[{context_id:f.a,expected_revision:2}],moves:f.request.moves.map(move=>({...move,to}))});
 expect(result.created_context_ids).toHaveLength(1);expect(new Set(result.moves.map(move=>move.after.context_id)).size).toBe(1);
 await undoContextReorganization(sql,{principal:f.client},{operation_id:crypto.randomUUID(),undo_operation_id:result.operation_id,conversation_id:f.conversation});
 const id=result.created_context_ids[0];if(!id)throw new Error('Missing target');
 expect((await snapshotSemanticContext(sql,f.principal,f.run,id)).context.recent_messages).toHaveLength(0);expect(await sql`SELECT 1 FROM assistant.semantic_contexts WHERE id=${id}`).toHaveLength(1);
});

test('daemon confirmed moves become pending proposals and client HTTP approval resolves them',async()=>{
 const f=await fixture(),proposal=await reorganizeContexts(sql,{principal:f.principal,run:f.run},f.request);expect(proposal.status).toBe('proposal');expect((await membership(f)).filter(link=>link.context_id===f.a)).toHaveLength(2);
 const app=new Hono<AppEnv>();app.use('*',async(c,next)=>{c.set('principal',f.client);await next()});app.route('/',semanticContextClientRoutes(sql));
 const list=await app.request('/contexts/proposals?conversation_id='+f.conversation);expect(list.status).toBe(200);expect(z.object({proposals:z.array(z.object({operation_id:z.uuid()}))}).parse(await list.json()).proposals.map(item=>item.operation_id)).toEqual([proposal.operation_id]);
 const response=await app.request('/contexts/reorganize',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...f.request,operation_id:crypto.randomUUID(),proposal_id:proposal.operation_id})});expect(response.status).toBe(200);expect((await membership(f)).every(link=>link.context_id===f.b)).toBe(true);expect((await contextProposals(sql,f.client,{conversation_id:f.conversation})).proposals).toHaveLength(0);
});

test('daemon provisional apply and own undo preserve provisional authority',async()=>{
 const f=await fixture('provisional'),actor={principal:f.principal,run:f.run};
 const before=await membership(f),proposal=await reorganizeContexts(sql,actor,f.request);expect(proposal.status).toBe('proposal');expect(await membership(f)).toEqual(before);
 const automatic_review={confidence:0.99,margin:0.3,evidence:[f.first,f.second,f.third].map(source=>({message_id:source.message_id,quote:source.content}))};
 const result=await reorganizeContexts(sql,actor,{...f.request,operation_id:crypto.randomUUID(),automatic_review});expect(result.status).toBe('applied');expect(result.moves.every(move=>move.after.status==='provisional')).toBe(true);
 const undo=await undoContextReorganization(sql,actor,{operation_id:crypto.randomUUID(),undo_operation_id:result.operation_id,conversation_id:f.conversation});expect(undo.status).toBe('undone');expect((await membership(f)).filter(link=>link.context_id===f.a)).toHaveLength(2);
});

test('automatic review requires confidence, separation and destination evidence without changing membership',async()=>{
 const f=await fixture('provisional'),actor={principal:f.principal,run:f.run},before=await membership(f);
 const review={confidence:0.99,margin:0.3,evidence:[f.first,f.second,f.third].map(source=>({message_id:source.message_id,quote:source.content}))};
 for(const automatic_review of [{...review,confidence:0.97},{...review,margin:0.19},{...review,evidence:review.evidence.slice(0,2)}]) {
  expect((await reorganizeContexts(sql,actor,{...f.request,operation_id:crypto.randomUUID(),automatic_review})).status).toBe('proposal');expect(await membership(f)).toEqual(before);
 }
 await rejects(reorganizeContexts(sql,actor,{...f.request,operation_id:crypto.randomUUID(),automatic_review:{...review,evidence:review.evidence.map((item,index)=>index===2?{...item,quote:'invented evidence'}:item)}}),'invalid_evidence');expect(await membership(f)).toEqual(before);
});

test('stale membership or incomplete context revisions reject the whole batch',async()=>{
 const f=await fixture(),before=await membership(f);
 await rejects(reorganizeContexts(sql,{principal:f.client},{...f.request,moves:f.request.moves.map((move,index)=>({...move,expected_link_revision:index===1?9:1}))}),'stale_revision');expect(await membership(f)).toEqual(before);
 await rejects(reorganizeContexts(sql,{principal:f.client},{...f.request,contexts:[{context_id:f.a,expected_revision:2}]}),'invalid_context_versions');expect(await membership(f)).toEqual(before);
 await sql`UPDATE assistant.messages SET content='Changed source' WHERE id=${f.second.message_id}`;
 await rejects(reorganizeContexts(sql,{principal:f.client},f.request),'stale_source');expect(await membership(f)).toEqual(before);
});

test('inconsistent new target metadata and forbidden source retention leave no partial contexts',async()=>{
 const f=await fixture(),before=await membership(f);
 await rejects(reorganizeContexts(sql,{principal:f.client},{...f.request,contexts:[{context_id:f.a,expected_revision:2}],moves:f.request.moves.map((move,index)=>({...move,to:{kind:'new',key:'same',title:'Different '+index,scope:'scope'}}))}),'invalid_reorganization');expect(await membership(f)).toEqual(before);expect(await sql`SELECT 1 FROM assistant.semantic_contexts WHERE workspace_id=${f.workspace}`).toHaveLength(2);
 await sql`INSERT INTO assistant.memory_suppressions(workspace_id,source_message_id) VALUES(${f.workspace},${f.second.message_id})`;
 await rejects(reorganizeContexts(sql,{principal:f.client},f.request),'retention_denied');expect(await membership(f)).toEqual(before);
});

test('undo rejects intervening context edits and daemon cannot undo client confirmed moves',async()=>{
 const f=await fixture(),result=await reorganizeContexts(sql,{principal:f.client},f.request),undo={operation_id:crypto.randomUUID(),undo_operation_id:result.operation_id,conversation_id:f.conversation};
 await rejects(undoContextReorganization(sql,{principal:f.principal,run:f.run},undo),'forbidden');
 const target=result.contexts.find(context=>context.context_id===f.b);if(!target)throw new Error('Missing context');
 await writeContextNotes(sql,f.principal,f.run,{operation_id:crypto.randomUUID(),context_id:f.b,expected_revision:target.revision,source_message_id:f.first.message_id,source_sha256:f.first.sha256,notes:[{id:crypto.randomUUID(),kind:'fact',text:'Newer context state',evidence:[{message_id:f.first.message_id,quote:f.first.content}]}]});
 await rejects(undoContextReorganization(sql,{principal:f.client},undo),'stale_revision');expect((await membership(f)).every(link=>link.context_id===f.b)).toBe(true);
});

test('assistant origin survives reorganization and undo with its generating user',async()=>{
 const f=await fixture(),assistant=crypto.randomUUID();await sql`INSERT INTO assistant.messages(id,workspace_id,conversation_id,task_id,role,content) VALUES(${assistant},${f.workspace},${f.conversation},${f.task},'assistant','Original A answer')`;
 await sql.begin(tx=>linkAssistantContext(tx,{workspace:f.workspace,conversation:f.conversation,run_id:f.run,context_id:f.a,message_id:assistant,source_message_id:f.first.message_id}));
 const result=await reorganizeContexts(sql,{principal:f.client},{...f.request,contexts:[{context_id:f.a,expected_revision:3},{context_id:f.b,expected_revision:1}],moves:[...f.request.moves,{message_id:assistant,expected_link_revision:1,to:{kind:'existing',context_id:f.b}}]});expect(result.moves.find(move=>move.after.message_id===assistant)?.after.originating_message_id).toBe(f.first.message_id);
 const undo=await undoContextReorganization(sql,{principal:f.client},{operation_id:crypto.randomUUID(),undo_operation_id:result.operation_id,conversation_id:f.conversation});expect(undo.moves.find(move=>move.after.message_id===assistant)?.after.originating_message_id).toBe(f.first.message_id);
});


test('reorganization cannot target another workspace or replay as another actor',async()=>{
 const f=await fixture(),other=await fixture(),before=await membership(f);
 await rejects(reorganizeContexts(sql,{principal:f.client},{...f.request,contexts:[{context_id:f.a,expected_revision:2},{context_id:other.b,expected_revision:1}],moves:f.request.moves.map(move=>({...move,to:{kind:'existing',context_id:other.b}}))}),'invalid_context');expect(await membership(f)).toEqual(before);
 await rejects(reorganizeContexts(sql,{principal:other.client},f.request),'not_found');
 const result=await reorganizeContexts(sql,{principal:f.client},f.request);
 await rejects(reorganizeContexts(sql,{principal:f.principal,run:f.run},f.request),'idempotency_conflict');expect(result.status).toBe('applied');
});

test('daemon single-link endpoint cannot downgrade or reassign confirmed membership',async()=>{
 const f=await fixture(),before=await membership(f);
 const base={operation_id:crypto.randomUUID(),message_id:f.first.message_id,source_sha256:f.first.sha256,expected_link_revision:1,evidence:[{message_id:f.first.message_id,quote:f.first.content}]};
 await rejects(linkContext(sql,f.principal,f.run,{...base,status:'provisional',choice:{kind:'existing',context_id:f.a,expected_context_revision:2}}),'reorganization_required');
 await rejects(linkContext(sql,f.principal,f.run,{...base,status:'confirmed',choice:{kind:'existing',context_id:f.b,expected_context_revision:1}}),'reorganization_required');
 expect(await membership(f)).toEqual(before);
});
