import { afterAll, beforeAll, expect, test } from "bun:test";
import { z } from "zod";
import { createDatabase } from "../services/control/db";
import { hashToken, type Principal } from "../services/control/auth";
import { createApp } from "../services/control/app";
import { applyEvent } from "../services/control/repository/daemon-events";
import { DaemonEvent, DomainError } from "../packages/protocol";
import { rawSource } from "../packages/context/store-read";
import { ensureExchange, attributeMember, writeEdge, undoEdge, readStructure } from "../packages/context/structure-store";
import type { EdgeRequest } from "../packages/context/structure-schema";
import { readStructureCorpus } from '../packages/context/structure-corpus-store';

const url=process.env['TEST_DATABASE_URL']??'postgres://assistant:assistant@127.0.0.1:55439/assistant_test';
const sql=createDatabase(url);
beforeAll(async()=>{const p=Bun.spawn(['bun','scripts/migrate.ts'],{env:{...process.env,DATABASE_URL:url},stdout:'pipe',stderr:'pipe'});const status=await p.exited;if(status)throw new Error(await new Response(p.stderr).text());expect(status).toBe(0)});
afterAll(async()=>{await sql.end()});
async function fixture() {
 const workspace=crypto.randomUUID(),conversation=crypto.randomUUID(),vm=crypto.randomUUID(),task=crypto.randomUUID(),run=crypto.randomUUID();
 await sql`INSERT INTO assistant.workspaces(id,name) VALUES(${workspace},'structure QA')`;
 await sql`INSERT INTO assistant.conversations(id,workspace_id,title) VALUES(${conversation},${workspace},'structure')`;
 await sql`INSERT INTO assistant.vms(id,workspace_id,name) VALUES(${vm},${workspace},'structure VM')`;
 await sql`INSERT INTO assistant.tasks(id,workspace_id,conversation_id,objective,state) VALUES(${task},${workspace},${conversation},'structure','running')`;
 await sql`INSERT INTO assistant.runs(id,workspace_id,task_id,vm_id) VALUES(${run},${workspace},${task},${vm})`;
 const principal:Principal={workspace_id:workspace,role:'vm',vm_id:vm},actor={principal,run},client={principal:{workspace_id:workspace,role:'client' as const,vm_id:null},conversation};
 async function message(content:string,role:'user'|'assistant'|'system'='user',response:string|null=null,applied:string[]=[]) {
  const id=crypto.randomUUID();
  await sql`INSERT INTO assistant.messages(id,workspace_id,conversation_id,task_id,role,content,response_to_message_id,applied_user_ids) VALUES(${id},${workspace},${conversation},${task},${role},${content},${response},${sql.array(applied)}::uuid[])`;
  if(role==='user')await sql`INSERT INTO assistant.memory_retention_decisions(workspace_id,task_id,source_message_id,action) VALUES(${workspace},${task},${id},'inherit')`;
  return id;
 }
 return {workspace,conversation,vm,task,run,principal,actor,client,message};
}
async function code(promise:Promise<unknown>,code:string) {try{await promise;throw new Error('Expected '+code)}catch(error){expect(error).toBeInstanceOf(DomainError);if(error instanceof DomainError){expect(error.code).toBe(code);expect(error.status).toBe(code==='forbidden'?403:409)}else throw error}}
async function edgeFixture() {
 const f=await fixture(),first=await f.message('The exact telescope answer.'),target=await ensureExchange(sql,f.actor,first),second=await f.message('Apply the telescope answer.'),child=await ensureExchange(sql,f.actor,second);
 const source=await rawSource(sql,{workspace:f.workspace,conversation:f.conversation},first);
 const request:z.input<typeof EdgeRequest>={operation_id:crypto.randomUUID(),child_exchange_id:child.id,expected_revision:0,state:'linked',target_exchange_id:target.id,relation:'follow_up',target_message_id:first,target_source_sha256:await hashToken(JSON.stringify(source)),target_start:4,target_end:9,quote:'exact',method:'llm',anchor_confidence:0.88};
 return {...f,first,second,target,child,request};
}

test('bounded structure corpus is run/workspace scoped, retained, versioned and excludes future messages',async()=>{
 const f=await fixture(),user=await f.message('한국어 원문'),parent=await ensureExchange(sql,f.actor,user),answer=await f.message('한국어 답변','assistant',user,[user]);
 await attributeMember(sql,f.actor,{message_id:answer,response_to_message_id:user,applied_user_ids:[user],kind:'answer',method:'response_to'});
 const child=await f.message('현재 질문');await ensureExchange(sql,f.actor,child);
 const future=await f.message('미래 질문');await ensureExchange(sql,f.actor,future);
 const corpus=await readStructureCorpus(sql,f.principal,f.run,child);
 expect(corpus.exchanges.map(e=>e.id)).toEqual([parent.id]);expect(corpus.sources.map(s=>s.message_id)).toContain(answer);expect(corpus.sources.map(s=>s.message_id)).not.toContain(future);expect(corpus.sources.find(s=>s.message_id===answer)?.content).toBe('한국어 답변');
 await sql`UPDATE assistant.memory_retention_decisions SET action='deny_turn' WHERE workspace_id=${f.workspace} AND source_message_id=${user}`;
 const denied=await readStructureCorpus(sql,f.principal,f.run,child);expect(denied.sources).toHaveLength(0);expect(denied.version).not.toBe(corpus.version);
 const other=await fixture();await code(readStructureCorpus(sql,other.principal,f.run,child),'stale_run');
});

test('exchange creation is idempotent and uses the user sequence; synthetic/system/foreign inputs are rejected',async()=>{
 const f=await fixture(),id=await f.message('real input');
 const [a,b]=await Promise.all([ensureExchange(sql,f.actor,id),ensureExchange(sql,f.actor,id)]);expect(a).toEqual(b);
 expect(a.sequence).toBe((await rawSource(sql,{workspace:f.workspace,conversation:f.conversation},id)).sequence);
 await code(ensureExchange(sql,f.actor,await f.message('system','system')),'invalid_source');
 const synthetic=await f.message('harness continuation');await sql`UPDATE assistant.messages SET synthetic=true WHERE workspace_id=${f.workspace} AND id=${synthetic}`;
 await code(ensureExchange(sql,f.actor,synthetic),'invalid_source');
 const other=await fixture();await code(ensureExchange(sql,f.actor,await other.message('foreign')),'invalid_source');
 await expect(sql`INSERT INTO assistant.semantic_exchanges(workspace_id,conversation_id,user_message_id,sequence) VALUES(${f.workspace},${f.conversation},${id},${a.sequence+1})`.execute()).rejects.toThrow();
});
test('interruption attribution uses response_to rather than latest user and keeps both applied inputs',async()=>{
 const f=await fixture(),one=await f.message('first'),two=await f.message('interrupt'),answer=await f.message('answer to first','assistant',one,[one,two]);
 const request={message_id:answer,response_to_message_id:one,kind:'answer' as const,method:'response_to' as const,applied_user_ids:[one,two]};
 const member=await attributeMember(sql,f.actor,request);expect(await attributeMember(sql,f.actor,request)).toEqual(member);
 expect(member.exchange_id).toBe((await ensureExchange(sql,f.actor,one)).id);expect(member.applied_user_ids).toEqual([one,two]);
 await code(attributeMember(sql,f.actor,{...request,response_to_message_id:two}),'invalid_attribution');
 const late=await f.message('too late');await code(attributeMember(sql,f.actor,{...request,response_to_message_id:late,applied_user_ids:[late]}),'invalid_attribution');
 const other=await fixture();await code(attributeMember(sql,other.actor,request),'invalid_source');
 await code(attributeMember(sql,f.actor,{...request,run:other.run}),'invalid_attribution');
 const legacy=await f.message('legacy','assistant');await code(attributeMember(sql,f.actor,{message_id:legacy,response_to_message_id:one,kind:'answer',method:'legacy'}),'invalid_attribution');
 await code(attributeMember(sql,f.actor,{message_id:legacy,response_to_message_id:one,kind:'answer',method:'heuristic'}),'invalid_attribution');
 expect((await attributeMember(sql,f.actor,{message_id:legacy,response_to_message_id:one,kind:'unknown',method:'legacy'})).kind).toBe('unknown');
 const progress=await f.message('working','assistant',one);await sql`UPDATE assistant.messages SET output_kind='progress' WHERE workspace_id=${f.workspace} AND id=${progress}`;
 await code(attributeMember(sql,f.actor,{message_id:progress,response_to_message_id:one,kind:'answer',method:'response_to'}),'invalid_attribution');
 expect((await attributeMember(sql,f.actor,{message_id:progress,response_to_message_id:one,kind:'progress',method:'response_to'})).kind).toBe('progress');
});
test('edge CAS, canonical receipt replay, changed payload and actor conflicts, immutable history',async()=>{
 const f=await edgeFixture(),edge=await writeEdge(sql,f.actor,f.request);expect(edge.revision).toBe(1);expect(edge.status).toBe('provisional');
 expect(await writeEdge(sql,f.actor,{...f.request})).toEqual(edge);
 await code(writeEdge(sql,f.actor,{...f.request,relation:'challenge'}),'idempotency_conflict');
 await code(writeEdge(sql,f.client,f.request),'idempotency_conflict');
 await code(writeEdge(sql,f.actor,{...f.request,operation_id:crypto.randomUUID()}),'stale_revision');
 expect(await sql`SELECT * FROM assistant.semantic_exchange_edge_revisions WHERE workspace_id=${f.workspace}`).toHaveLength(1);
 await expect(sql`UPDATE assistant.semantic_exchange_edge_revisions SET revision=2 WHERE workspace_id=${f.workspace}`.execute()).rejects.toThrow();
 await sql`UPDATE assistant.runs SET state='succeeded' WHERE workspace_id=${f.workspace} AND id=${f.run}`;
 expect(await writeEdge(sql,f.actor,f.request)).toEqual(edge);
});
test('concurrent operation replays and competing CAS writes serialize',async()=>{
 const f=await edgeFixture();const [a,b]=await Promise.all([writeEdge(sql,f.actor,f.request),writeEdge(sql,f.actor,f.request)]);expect(a).toEqual(b);
 const results=await Promise.allSettled([writeEdge(sql,f.actor,{...f.request,operation_id:crypto.randomUUID(),expected_revision:1}),writeEdge(sql,f.actor,{...f.request,operation_id:crypto.randomUUID(),expected_revision:1})]);
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
});
test('reject future targets, wrong exchange membership, mismatched quote/hash and cross-workspace references',async()=>{
 const f=await edgeFixture();
 await code(writeEdge(sql,f.actor,{...f.request,quote:'wrong'}),'invalid_evidence');
 await code(writeEdge(sql,f.actor,{...f.request,target_source_sha256:'0'.repeat(64)}),'stale_source');
 const future=await f.message('future'),futureExchange=await ensureExchange(sql,f.actor,future);
 await code(writeEdge(sql,f.actor,{...f.request,target_exchange_id:futureExchange.id,target_message_id:future}),'invalid_edge');
 await code(writeEdge(sql,f.actor,{...f.request,target_exchange_id:f.child.id}),'invalid_edge');
 const other=await edgeFixture();await code(writeEdge(sql,f.actor,{...f.request,target_exchange_id:other.target.id}),'invalid_exchange');
 await code(writeEdge(sql,other.actor,f.request),'invalid_exchange');
 const alien=await f.message('not attributed','assistant');
 const latest=await ensureExchange(sql,f.actor,await f.message('last'));
 await code(writeEdge(sql,f.actor,{...f.request,child_exchange_id:latest.id,target_message_id:alien}),'invalid_edge');
 await code(writeEdge(sql,f.actor,{...f.request,status:'confirmed'}),'invalid_edge');
});
test('user decisions require client identity and automatic writes cannot overwrite them; undo appends',async()=>{
 const f=await edgeFixture();
 await code(writeEdge(sql,f.actor,{...f.request,method:'user'}),'forbidden');
 const first=await writeEdge(sql,f.client,{...f.request,method:'user',status:'confirmed'});
 await code(writeEdge(sql,f.actor,{...f.request,operation_id:crypto.randomUUID(),expected_revision:1}),'user_edge_protected');
 const root=await writeEdge(sql,f.client,{operation_id:crypto.randomUUID(),child_exchange_id:f.child.id,expected_revision:1,state:'root',method:'user',status:'confirmed'});expect(root.revision).toBe(2);
 const undo={operation_id:crypto.randomUUID(),child_exchange_id:f.child.id,expected_revision:2,to_revision:1};
 await code(undoEdge(sql,f.actor,undo),'forbidden');
 const restored=await undoEdge(sql,f.client,undo);expect(restored.revision).toBe(3);expect(restored.target_exchange_id).toBe(first.target_exchange_id);expect(await undoEdge(sql,f.client,undo)).toEqual(restored);
 await code(undoEdge(sql,f.client,{...undo,operation_id:crypto.randomUUID()}),'stale_revision');
 expect(await sql`SELECT * FROM assistant.semantic_exchange_edge_revisions WHERE workspace_id=${f.workspace}`).toHaveLength(3);
});
test('references have independent heads and revisions; primary has one mutable head',async()=>{
 const f=await edgeFixture();await writeEdge(sql,f.actor,f.request);
 await writeEdge(sql,f.actor,{...f.request,operation_id:crypto.randomUUID(),role:'reference'});
 const read=await readStructure(sql,f.actor,{through_sequence:f.child.sequence});expect(read.edges).toHaveLength(2);
 await writeEdge(sql,f.actor,{operation_id:crypto.randomUUID(),child_exchange_id:f.child.id,expected_revision:1,state:'unresolved',method:'heuristic'});
 expect(await sql`SELECT * FROM assistant.semantic_exchange_edges WHERE workspace_id=${f.workspace} AND role='primary'`).toHaveLength(1);
 expect(await sql`SELECT * FROM assistant.semantic_exchange_edges WHERE workspace_id=${f.workspace} AND role='reference'`).toHaveLength(1);
});
test('read bounds, primary ancestor stopping, and cross-workspace isolation',async()=>{
 const f=await edgeFixture();await writeEdge(sql,f.actor,f.request);
 expect((await readStructure(sql,f.actor,{through_sequence:f.child.sequence,ancestors_of:f.child.id,limit:1})).ancestors).toEqual([]);
 const followed=await readStructure(sql,f.actor,{through_sequence:f.child.sequence,ancestors_of:f.child.id,limit:1,stop_at_provisional:false,max_hops:1});expect(followed.ancestors).toEqual([f.target.id]);expect(followed.primary_chain).toHaveLength(1);
 const earlier=await readStructure(sql,f.actor,{through_sequence:f.target.sequence,ancestors_of:f.child.id});expect(earlier.exchanges.map(e=>e.id)).toEqual([f.target.id]);expect(earlier.edges).toEqual([]);
 const other=await fixture();expect((await readStructure(sql,other.actor,{through_sequence:Number.MAX_SAFE_INTEGER,ancestors_of:f.child.id})).exchanges).toEqual([]);
});
test('source edits, suppression and retention changes invalidate heads without rewriting history',async()=>{
 const f=await edgeFixture();await writeEdge(sql,f.actor,f.request);
 await sql`UPDATE assistant.messages SET content='edited source' WHERE workspace_id=${f.workspace} AND id=${f.first}`;
 expect((await readStructure(sql,f.actor,{through_sequence:f.child.sequence,stop_at_provisional:false,ancestors_of:f.child.id})).edges).toEqual([]);
 expect(z.object({needs_revalidation:z.boolean()}).parse((await sql`SELECT needs_revalidation FROM assistant.semantic_exchange_edges WHERE workspace_id=${f.workspace}`)[0]).needs_revalidation).toBe(true);
 await code(writeEdge(sql,f.actor,{...f.request,operation_id:crypto.randomUUID(),expected_revision:1}),'stale_source');
 const g=await edgeFixture();await writeEdge(sql,g.actor,g.request);
 await sql`INSERT INTO assistant.memory_suppressions(workspace_id,source_message_id) VALUES(${g.workspace},${g.second})`;
 expect((await readStructure(sql,g.actor,{through_sequence:g.child.sequence})).edges).toEqual([]);
 const h=await edgeFixture();await writeEdge(sql,h.actor,h.request);
 await sql`UPDATE assistant.memory_retention_decisions SET action='deny_task' WHERE workspace_id=${h.workspace} AND source_message_id=${h.first}`;
 expect((await readStructure(sql,h.actor,{through_sequence:h.child.sequence})).edges).toEqual([]);
 expect(await sql`SELECT * FROM assistant.semantic_exchange_edge_revisions WHERE workspace_id=${f.workspace}`).toHaveLength(1);
});
test('control message persistence records attribution without semantic flags and rejects foreign inputs',async()=>{
 const f=await fixture(),one=await f.message('one'),two=await f.message('two'),id=crypto.randomUUID();
 const event=DaemonEvent.parse({kind:'message',event_id:id,message_id:id,run_id:f.run,content:'answer',response_to_message_id:one,applied_user_ids:[one,two],output_kind:'answer'});
 await sql.begin(tx=>applyEvent(tx,f.principal,event));
 const stored=z.object({response_to_message_id:z.uuid(),applied_user_ids:z.array(z.uuid()),output_kind:z.string()}).parse((await sql`SELECT response_to_message_id,applied_user_ids,output_kind FROM assistant.messages WHERE workspace_id=${f.workspace} AND id=${id}`)[0]);
 expect(stored).toEqual({response_to_message_id:one,applied_user_ids:[one,two],output_kind:'answer'});
 expect(await sql`SELECT * FROM assistant.semantic_exchanges WHERE workspace_id=${f.workspace}`).toHaveLength(0);
 const other=await fixture(),foreign=await other.message('foreign');
 await code(sql.begin(tx=>applyEvent(tx,f.principal,DaemonEvent.parse({...event,event_id:crypto.randomUUID(),message_id:crypto.randomUUID(),response_to_message_id:foreign,applied_user_ids:[foreign]}))),'invalid_source');
});
test('registered routes enforce authentication, ownership, body validation and 409 mapping',async()=>{
 const f=await edgeFixture(),app=createApp(sql),token=crypto.randomUUID()+crypto.randomUUID(),clientToken=crypto.randomUUID()+crypto.randomUUID();
 await sql`INSERT INTO assistant.credentials(token_hash,workspace_id,role,vm_id) VALUES(${await hashToken(token)},${f.workspace},'vm',${f.vm}),(${await hashToken(clientToken)},${f.workspace},'client',NULL)`;
 const request=(path:string,body:unknown,bearer:string|null=token)=>app.request(`/v1/daemon/context/${f.run}/structure/${path}`,{method:'POST',headers:{'Content-Type':'application/json',...(bearer?{Authorization:`Bearer ${bearer}`}:{})},body:JSON.stringify(body)});
 expect((await request('exchange',{user_message_id:f.first},null)).status).toBe(401);
 expect((await request('exchange',{user_message_id:f.first},clientToken)).status).toBe(403);
 expect((await request('exchange',{user_message_id:'invalid'})).status).toBe(400);
 expect((await request('exchange',{user_message_id:f.first})).status).toBe(200);
 expect((await request('edge',f.request)).status).toBe(200);
 const changed=await request('edge',{...f.request,relation:'correction'});expect(changed.status).toBe(409);expect(await changed.json()).toMatchObject({error:{code:'idempotency_conflict'}});
 expect((await request('read',{through_sequence:f.child.sequence})).status).toBe(200);
 const other=await fixture();expect((await request('exchange',{user_message_id:await other.message('foreign')})).status).toBe(409);
  const foreignRun=await app.request(`/v1/daemon/context/${other.run}/structure/read`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({through_sequence:Number.MAX_SAFE_INTEGER})});
  // Run ownership is fenced at the route boundary, without exposing foreign data.
  expect(foreignRun.status).toBe(404);
  expect(await foreignRun.json()).toMatchObject({error:{code:'not_found'}});
});

test('W1b instruction, branch and reference evidence persist with exact validation and idempotency',async()=>{
 const f=await fixture(),user=await f.message('원래 주제'),target=await ensureExchange(sql,f.actor,user),answer=await f.message('새로운 주제에 관한 설명','assistant',user,[user]);
 await attributeMember(sql,f.actor,{message_id:answer,response_to_message_id:user,applied_user_ids:[user],kind:'answer',method:'response_to'});
 const childUser=await f.message('새로운 주제로 진행해줘'),child=await ensureExchange(sql,f.actor,childUser),scope={workspace:f.workspace,conversation:f.conversation};
 const source=await rawSource(sql,scope,answer),current=await rawSource(sql,scope,childUser),branch={exchange_id:target.id,message_id:answer,source_sha256:await hashToken(JSON.stringify(source)),start:0,end:6,quote:'새로운 주제',confidence:.8};
 const request:z.input<typeof EdgeRequest>={operation_id:crypto.randomUUID(),child_exchange_id:child.id,expected_revision:0,state:'linked',target_exchange_id:target.id,target_message_id:answer,target_source_sha256:branch.source_sha256,target_start:0,target_end:6,quote:branch.quote,relation:'instruction',method:'llm',subject_action:'new_subject_branch',proposed_subject:'새로운 주제',subject_confidence:.9,branch_from:branch};
 await code(writeEdge(sql,f.actor,{...request,branch_from:{...branch,quote:'잘못된 인용'}}),'invalid_evidence');
 const edge=await writeEdge(sql,f.actor,request);expect(edge.relation).toBe('instruction');expect(edge.branch_from).toEqual(branch);expect(await writeEdge(sql,f.actor,request)).toEqual(edge);
 const reference={...request,operation_id:crypto.randomUUID(),role:'reference' as const,subject_action:null,branch_from:null,reference_evidence:{exchange_id:child.id,message_id:childUser,source_sha256:await hashToken(JSON.stringify(current)),start:0,end:6,quote:'새로운 주제'}};
 await code(writeEdge(sql,f.actor,{...reference,reference_evidence:{...reference.reference_evidence,quote:'틀림'}}),'invalid_evidence');
 expect((await writeEdge(sql,f.actor,reference)).reference_evidence?.quote).toBe('새로운 주제');expect(await writeEdge(sql,f.actor,reference)).toMatchObject({revision:1,role:'reference'});
 await sql`INSERT INTO assistant.memory_suppressions(workspace_id,source_message_id) VALUES(${f.workspace},${answer})`;
 await code(writeEdge(sql,f.actor,request),'retention_denied');
 await sql`DELETE FROM assistant.memory_suppressions WHERE workspace_id=${f.workspace} AND source_message_id=${answer}`;
 await sql`UPDATE assistant.messages SET content='변경된 설명' WHERE workspace_id=${f.workspace} AND id=${answer}`;
 expect((await readStructure(sql,f.actor,{through_sequence:child.sequence})).edges).toEqual([]);
 const root=await ensureExchange(sql,f.actor,await f.message('별도 지시'));
 expect(await writeEdge(sql,f.actor,{operation_id:crypto.randomUUID(),child_exchange_id:root.id,expected_revision:0,state:'root',relation:'instruction',method:'llm',subject_action:'new_root',proposed_subject:'일정 관리'})).toMatchObject({state:'root',relation:'instruction'});
 const answerless=await ensureExchange(sql,f.actor,await f.message('아직 답변 없는 지시'));
 expect(await writeEdge(sql,f.actor,{operation_id:crypto.randomUUID(),child_exchange_id:answerless.id,expected_revision:0,state:'unresolved',continuation_exchange_id:root.id,relation:'instruction',method:'llm',subject_action:'same_subject',proposed_subject:'일정 관리'})).toMatchObject({continuation_exchange_id:root.id,state:'unresolved'});
});

test('050 upgrades the original 049 edge CHECK with existing rows unchanged',async()=>{
 const schema='migration_w1b_'+crypto.randomUUID().replaceAll('-',''),workspace=crypto.randomUUID(),child=crypto.randomUUID();
 const original=await Bun.file(new URL('../infra/migrations/049_semantic_structure.sql',import.meta.url)).text(),migration=await Bun.file(new URL('../infra/migrations/050_structure_w1b.sql',import.meta.url)).text();
 const table=original.slice(original.indexOf('CREATE TABLE semantic_exchange_edges ('),original.indexOf('CREATE UNIQUE INDEX semantic_edge_primary'));
 await sql.begin(async tx=>{
  await tx.unsafe(`CREATE SCHEMA ${schema}; SET LOCAL search_path TO ${schema},public`);
  await tx.unsafe('CREATE TABLE semantic_exchanges(workspace_id uuid,id uuid,PRIMARY KEY(workspace_id,id)); CREATE TABLE messages(workspace_id uuid,id uuid,content text,synthetic boolean,PRIMARY KEY(workspace_id,id)); CREATE TABLE memory_suppressions(workspace_id uuid); CREATE TABLE memory_retention_decisions(workspace_id uuid); CREATE TABLE semantic_source_retention(workspace_id uuid)');
  await tx.unsafe(table);
  await tx`INSERT INTO semantic_exchanges VALUES(${workspace},${child})`;
  await tx`INSERT INTO semantic_exchange_edges(workspace_id,child_exchange_id,role,state,status,method,policy_version,revision) VALUES(${workspace},${child},'primary','root','provisional','llm','anchor-shadow-v1',1)`;
  await tx.unsafe(migration.replaceAll('assistant.',`${schema}.`));
  expect((await tx`SELECT policy_version,revision,subject_action FROM semantic_exchange_edges WHERE workspace_id=${workspace}`)[0]).toMatchObject({policy_version:'anchor-shadow-v1',revision:1,subject_action:null});
  await tx`UPDATE semantic_exchange_edges SET relation='instruction',subject_action='new_root',proposed_subject='일정' WHERE workspace_id=${workspace} AND child_exchange_id=${child}`;
  expect((await tx`SELECT relation FROM semantic_exchange_edges WHERE workspace_id=${workspace}`)[0]?.['relation']).toBe('instruction');
  await tx.unsafe(`DROP SCHEMA ${schema} CASCADE`);
 });
});

test('a user reply target becomes a confirmed explicit anchor that automatic edges cannot replace',async()=>{
 const f=await fixture(),question=await f.message('브랜드페이 앱 SDK 있어?'),parent=await ensureExchange(sql,f.actor,question),answer=await f.message('앱용 SDK도 있어요. 결제위젯 기준입니다.','assistant',question,[question]);
 await attributeMember(sql,f.actor,{message_id:answer,response_to_message_id:question,applied_user_ids:[question],kind:'answer',method:'response_to'});
 await f.message('다른 이야기');
 const reply=await f.message('이거 단독 SDK야?');await sql`UPDATE assistant.messages SET reply_to_message_id=${answer} WHERE workspace_id=${f.workspace} AND id=${reply}`;
 const child=await ensureExchange(sql,f.actor,reply);await ensureExchange(sql,f.actor,reply);
 const [edge]=await sql`SELECT * FROM assistant.semantic_exchange_edges WHERE workspace_id=${f.workspace} AND child_exchange_id=${child.id}`;
 expect(edge).toMatchObject({role:'primary',state:'linked',target_exchange_id:parent.id,target_message_id:answer,method:'explicit',status:'confirmed',relation:'follow_up',revision:1});
 const corpus=await readStructureCorpus(sql,f.principal,f.run,reply);
 expect(corpus.edges.find(e=>e.child_exchange_id===child.id&&e.role==='primary')?.target_exchange_id).toBe(parent.id);
 const plain=await f.message('답글 아님'),plainExchange=await ensureExchange(sql,f.actor,plain);
 expect((await sql`SELECT count(*)::int n FROM assistant.semantic_exchange_edges WHERE workspace_id=${f.workspace} AND child_exchange_id=${plainExchange.id}`)[0]?.['n']).toBe(0);
});
