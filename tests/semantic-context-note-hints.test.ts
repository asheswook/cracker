import { afterAll, expect, test } from "bun:test";
import { Journal } from "../services/daemon/journal.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import ky from "ky";
import { z } from "zod";
import { DomainError } from "../packages/protocol/index.ts";
import { SemanticContext, SemanticSnapshotRequest } from "../packages/context/schema.ts";
import { linkContext, prepareSemanticContext, snapshotSemanticContext } from "../packages/context/store.ts";
import { SemanticContexts } from "../services/daemon/semantic-context.ts";
import { SemanticCheckpoint } from "../services/daemon/semantic-context-state.ts";
import { SemanticMetadataQueue } from "../services/daemon/semantic-context-queue.ts";
import { createDatabase } from "../services/control/db.ts";
import type { AppEnv, Principal } from "../services/control/auth.ts";
import { semanticContextRoutes } from "../services/control/routes/semantic-context.ts";
import type { Provider } from "../packages/provider/index.ts";

const environment = z.object({ TEST_DATABASE_URL: z.string().optional() }).parse(process.env);
const sql = createDatabase(environment.TEST_DATABASE_URL ?? "postgres://assistant:assistant@127.0.0.1:55439/semantic_context_1006");
afterAll(() => sql.end());
async function fixture() {
  const workspace = crypto.randomUUID(), conversation = crypto.randomUUID(), vm = crypto.randomUUID(), task = crypto.randomUUID(), run = crypto.randomUUID();
  const principal: Principal = { workspace_id: workspace, vm_id: vm, role: "vm" };
  await sql`INSERT INTO assistant.workspaces(id,name) VALUES(${workspace},'note-hints QA')`;
  await sql`INSERT INTO assistant.vms(id,workspace_id,name) VALUES(${vm},${workspace},'fixture')`;
  await sql`INSERT INTO assistant.conversations(id,workspace_id,title) VALUES(${conversation},${workspace},'fixture')`;
  await sql`INSERT INTO assistant.tasks(id,workspace_id,conversation_id,objective,state) VALUES(${task},${workspace},${conversation},'fixture','running')`;
  await sql`INSERT INTO assistant.runs(id,workspace_id,task_id,vm_id,state) VALUES(${run},${workspace},${task},${vm},'running')`;
  const choices = new Map<string, { context_id: string; note_ids: string[] }>();
  const message = async (content: string) => {
    const id = crypto.randomUUID(); await sql`INSERT INTO assistant.messages(id,workspace_id,conversation_id,task_id,role,content) VALUES(${id},${workspace},${conversation},${task},'user',${content})`;
    await sql`INSERT INTO assistant.memory_retention_decisions(workspace_id,task_id,source_message_id,action) VALUES(${workspace},${task},${id},'inherit')`; return id;
  };
  const topic = async (name: string) => {
    const source = await message(`Original ${name} decision`), prepared = await prepareSemanticContext(sql, principal, run, { message_id: source });
    const linked = await linkContext(sql, principal, run, { operation_id: crypto.randomUUID(), message_id: source, source_sha256: prepared.source.sha256, expected_link_revision: 0, choice: { kind: "new", title: name, scope: name }, status: "confirmed", evidence: [{ message_id: source, quote: prepared.source.content }] });
    const rows = z.array(z.object({ id: z.uuid(), context_revision: z.number() })).parse(await sql`INSERT INTO assistant.semantic_context_notes(id,workspace_id,conversation_id,context_id,context_revision,kind,text,evidence,basis,source_message_id,source_sha256,source_sequence)
      SELECT gen_random_uuid(),${workspace},${conversation},${linked.context.context_id},n,'decision',${name}||' decision '||n,${JSON.stringify([{ message_id: source, quote: prepared.source.content }])}::text::jsonb,'user_statement',${source},${prepared.source.sha256},${prepared.source.sequence} FROM generate_series(1,40) n RETURNING id,context_revision`);
    await sql`UPDATE assistant.semantic_contexts SET revision=40 WHERE id=${linked.context.context_id}`;
    return { id: linked.context.context_id, source, notes: rows.toSorted((a,b) => a.context_revision-b.context_revision) };
  };
  const snapshots: z.infer<typeof SemanticSnapshotRequest>[] = [], modelInputs: z.infer<typeof SemanticContext>[] = [];
  const controls = { allFresh: false, priorOnly: false, dropLink: false };
  const holds = { started: Promise.withResolvers<void>(), release: Promise.withResolvers<void>(), next: false };
  const app = new Hono<AppEnv>();
  app.onError((error,c) => { if (!(error instanceof DomainError)) throw error; return c.json({error:{code:error.code}},error.status); });
  app.use('*', async (c,next) => { c.set('principal', principal); await next(); });
  app.route('/v1/daemon', semanticContextRoutes(sql, { retrieve: async prepared => { const choice=choices.get(prepared.source.message_id); return choice ? [choice] : []; }, classify: async prepared => ({ context_id: choices.get(prepared.source.message_id)?.context_id ?? null, outcome: 'existing', scores: [], model: 'fixture' }) }));
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
    const snapshot = new URL(request.url).pathname.endsWith('/snapshot');
    if (snapshot) snapshots.push(SemanticSnapshotRequest.parse(await request.clone().json()));
    const response = await app.fetch(request);
    if (controls.dropLink && new URL(request.url).pathname.endsWith('/link') && response.ok) { controls.dropLink=false; return Response.json({error:{code:'lost_response'}},{status:503}); }
    if (snapshot && holds.next) { holds.next=false; holds.started.resolve(); await holds.release.promise; }
    return response;
  } });
  const http = ky.create({ prefixUrl: server.url.href, retry: 0 });
  const provider: Provider = { respond: async (input, tools) => {
    const item=input.at(-1),tool=tools[0]; if (!item || !('content' in item) || typeof item.content!=='string' || tool?.type!=='function' || tool.name!=='record_semantic_notes') throw new TypeError('Unexpected fixture metadata call');
    const context=SemanticContext.parse(JSON.parse(item.content)); modelInputs.push(context);
    const old=context.notes.find(note=>note.id===context.retrieval.note_ids[0]),current=context.recent_messages.at(-1);
    const notes=controls.priorOnly&&old?[{kind:'fact',text:'Repeated historical fact',evidence:old.evidence,supersedes:null,valid_from:null,valid_to:null}]:controls.allFresh?context.recent_messages.map(source=>({kind:source.role==='assistant'?'outcome':'fact',text:source.content,evidence:[{message_id:source.message_id,quote:source.content}],supersedes:null,valid_from:null,valid_to:null})):old&&current?[{kind:'decision',text:current.content,evidence:[{message_id:current.message_id,quote:current.content}],supersedes:old.id,valid_from:null,valid_to:null}]:[];
    return {id:crypto.randomUUID(),created_at:0,output_text:'',error:null,incomplete_details:null,instructions:null,metadata:null,model:'fixture',object:'response',output:[{type:'function_call',call_id:crypto.randomUUID(),name:tool.name,arguments:JSON.stringify({notes})}],parallel_tool_calls:false,temperature:null,tool_choice:'auto',tools:[],top_p:null,status:'completed'};
  } };
  const make = (state?: SemanticCheckpoint) => new SemanticContexts({ http, runId: run, taskId: task, provider }, state);
  const select = async (coordinator: SemanticContexts, target: Awaited<ReturnType<typeof topic>>, notes: string[], content = 'Replace the earlier decision with the new decision') => {
    const id=await message(content); choices.set(id,{context_id:target.id,note_ids:notes}); await coordinator.index(id,AbortSignal.timeout(5000)); return id;
  };
  return {workspace,conversation,task,run,principal,message,topic,select,make,http,provider,snapshots,modelInputs,holds,controls,close:async()=>{holds.release.resolve();await server.stop(true);}};
}
test('old selected decision survives A to B, late A delivery, SQLite detach and checkpoint restore',async()=>{
  const f=await fixture(),directory=await mkdtemp(join(tmpdir(),'note-hints-')),path=join(directory,'jobs.sqlite');
  let journal=new Journal(path);let jobs=journal.semantic;let queue:SemanticMetadataQueue|undefined;
  try {
    const a=await f.topic('A'),b=await f.topic('B'),old=a.notes[0];if(!old)throw new TypeError('Missing old note');
    const ordinary=await snapshotSemanticContext(sql,f.principal,f.run,a.id);expect(ordinary.context.notes).toHaveLength(16);expect(ordinary.context.notes.some(note=>note.id===old.id)).toBe(false);
    const coordinator=f.make(),current=await f.select(coordinator,a,[old.id]);await f.select(coordinator,b,[]);
    coordinator.delivered(a.id);const checkpoint=SemanticCheckpoint.parse(JSON.parse(JSON.stringify(coordinator.checkpoint())));
    jobs.enqueue({runId:f.run,taskId:f.task,state:checkpoint});coordinator.detachNotes();journal.close();journal=new Journal(path);jobs=journal.semantic;
    queue=new SemanticMetadataQueue({jobs,http:f.http,provider:f.provider});await queue.process(Number.MAX_SAFE_INTEGER);
    expect(jobs.next(Number.MAX_SAFE_INTEGER)).toBeNull();expect(f.snapshots[0]?.note_ids).toEqual([old.id]);
    const extracted=f.modelInputs[0];expect(extracted?.notes.find(note=>note.id===old.id)?.evidence).toEqual([{message_id:a.source,quote:'Original A decision'}]);
    const replacement=z.object({source_message_id:z.uuid(),evidence:z.array(z.object({message_id:z.uuid(),quote:z.string()}))}).parse((await sql`SELECT source_message_id,evidence FROM assistant.semantic_context_notes WHERE supersedes=${old.id}`)[0]);
    expect(replacement.source_message_id).toBe(current);expect(replacement.evidence).toEqual([{message_id:current,quote:'Replace the earlier decision with the new decision'}]);
  }finally{await queue?.stop();journal.close();await f.close();await rm(directory,{recursive:true,force:true});}
});
test('same-context deliveries retain distinct hints while an older durable job is in flight',async()=>{
  const f=await fixture(),directory=await mkdtemp(join(tmpdir(),'note-deliveries-')),journal=new Journal(join(directory,'jobs.sqlite'));
  const queue=new SemanticMetadataQueue({jobs:journal.semantic,http:f.http,provider:f.provider});let processing:Promise<void>|undefined;
  try {
    const a=await f.topic('Two deliveries'),first=a.notes[0],second=a.notes[1];if(!first||!second)throw new TypeError('Missing old notes');
    const coordinator=f.make();await f.select(coordinator,a,[first.id],'First correction');coordinator.delivered(a.id);
    const initial=SemanticCheckpoint.parse(JSON.parse(JSON.stringify(coordinator.checkpoint())));
    journal.semantic.enqueue({runId:f.run,taskId:f.task,state:initial});coordinator.detachNotes();f.holds.next=true;processing=queue.process();await f.holds.started.promise;
    await f.select(coordinator,a,[second.id],'Second correction');coordinator.delivered(a.id);
    journal.semantic.enqueue({runId:f.run,taskId:f.task,state:SemanticCheckpoint.parse(JSON.parse(JSON.stringify(coordinator.checkpoint())))});coordinator.detachNotes();
    expect(initial.retrieved_notes?.[0]?.note_ids).toEqual([first.id]);f.holds.release.resolve();await processing;
    for(let i=0;i<3&&journal.semantic.next(Number.MAX_SAFE_INTEGER);i++)await queue.process(Number.MAX_SAFE_INTEGER);
    expect(journal.semantic.next(Number.MAX_SAFE_INTEGER)).toBeNull();expect(f.snapshots[0]?.note_ids).toEqual([first.id]);expect(f.snapshots.at(-1)?.note_ids).toEqual([second.id,first.id]);
    const count=z.object({count:z.coerce.number()}).parse((await sql`SELECT count(*) FROM assistant.semantic_context_notes WHERE workspace_id=${f.workspace} AND supersedes=ANY(${sql.array([first.id,second.id])}::uuid[])`)[0]);expect(count.count).toBe(2);
  }finally{f.holds.release.resolve();await processing;await queue.stop();journal.close();await f.close();await rm(directory,{recursive:true,force:true});}
});
test('snapshot revalidates denied, superseded and foreign hints rather than replaying cached evidence',async()=>{
  const f=await fixture();
  try {
    const a=await f.topic('Revoked'),foreign=await f.topic('Foreign'),target=a.notes[0],superseded=foreign.notes[0];if(!target||!superseded)throw new TypeError('Missing fixture notes');
    const coordinator=f.make();await f.select(coordinator,a,[target.id]);coordinator.delivered(a.id);
    await sql`UPDATE assistant.memory_retention_decisions SET action='deny_turn',quote='Original Revoked decision' WHERE workspace_id=${f.workspace} AND source_message_id=${a.source}`;
    const state=SemanticCheckpoint.parse(JSON.parse(JSON.stringify(coordinator.checkpoint())));
    state.retrieved_notes=[{context_id:a.id,note_ids:[target.id,superseded.id,crypto.randomUUID()]}];
    const restored=f.make(state);await restored.drain(AbortSignal.timeout(5000),()=>{});
    expect(f.snapshots[0]?.note_ids).toHaveLength(3);expect(f.modelInputs[0]?.notes).toEqual([]);expect(f.modelInputs[0]?.recent_messages.some(item=>item.message_id===a.source)).toBe(false);
    const b=await f.topic('Superseded'),old=b.notes[0],replacement=b.notes[1];if(!old||!replacement)throw new TypeError('Missing superseded notes');
    const next=f.make();await f.select(next,b,[old.id]);next.delivered(b.id);
    await sql`UPDATE assistant.semantic_context_notes SET superseded_by=${replacement.id} WHERE id=${old.id}`;
    await next.drain(AbortSignal.timeout(5000),()=>{});
    expect(f.modelInputs.at(-1)?.notes.some(note=>note.id===old.id)).toBe(false);expect(f.modelInputs.at(-1)?.retrieval.note_ids).toEqual([]);
  }finally{await f.close();}
});
test('hint union is bounded, legacy checkpoints remain exact, and detach preserves undelivered selections',async()=>{
  const f=await fixture();
  try {
    expect(SemanticCheckpoint.parse({active:null,pending:[]})).toEqual({active:null,pending:[]});
    const a=await f.topic('Bounded A'),b=await f.topic('Bounded B'),ids=a.notes.slice(0,16).map(note=>note.id),extra=a.notes[16],bNote=b.notes[0];if(!extra||!bNote)throw new TypeError('Missing bound fixture');
    const cache=Array.from({length:99},()=>({context_id:crypto.randomUUID(),note_ids:[crypto.randomUUID()]})),protectedId=cache[0]?.context_id;if(!protectedId)throw new TypeError('Missing protected ID');
    const coordinator=f.make({active:null,pending:[protectedId],retrieved_notes:cache});await f.select(coordinator,a,ids);coordinator.delivered(a.id);
    await f.select(coordinator,a,[extra.id]);coordinator.delivered(a.id);
    expect(coordinator.checkpoint().pending.filter(id=>id===a.id)).toHaveLength(1);
    expect(coordinator.checkpoint().retrieved_notes?.find(item=>item.context_id===a.id)?.note_ids).toEqual([extra.id,...ids.slice(0,15)]);
    await f.select(coordinator,b,[bNote.id]);expect(coordinator.checkpoint().retrieved_notes).toHaveLength(100);expect(coordinator.checkpoint().retrieved_notes?.some(item=>item.context_id===protectedId)).toBe(true);
    coordinator.detachNotes();expect(coordinator.checkpoint().retrieved_notes?.some(item=>item.context_id===a.id)).toBe(false);expect(coordinator.checkpoint().retrieved_notes?.some(item=>item.context_id===b.id)).toBe(true);
    const late=f.make();await f.select(late,a,[extra.id]);await f.select(late,b,[bNote.id]);late.delivered(b.id);late.detachNotes();expect(late.checkpoint().retrieved_notes?.some(item=>item.context_id===a.id)).toBe(true);
    expect(SemanticCheckpoint.safeParse({active:null,pending:[],retrieved_notes:Array.from({length:101},()=>({context_id:crypto.randomUUID(),note_ids:[]}))}).success).toBe(false);
    expect(SemanticCheckpoint.safeParse({active:null,pending:[],retrieved_notes:[{context_id:a.id,note_ids:a.notes.slice(0,17).map(note=>note.id)}]}).success).toBe(false);
  }finally{await f.close();}
});
test('old facts are reference notes only; current correction is the sole fresh source after checkpoint restore',async()=>{
 const f=await fixture();try{
  const topic=await f.topic('Prior forty facts'),old=topic.notes[0];if(!old)throw new TypeError('Missing target');
  const coordinator=f.make(),correction=await f.select(coordinator,topic,[old.id],'Correction replaces the original decision');coordinator.delivered(topic.id);
  const restored=f.make(SemanticCheckpoint.parse(JSON.parse(JSON.stringify(coordinator.checkpoint()))));await restored.drain(AbortSignal.timeout(5000),()=>{});
  expect(f.modelInputs[0]?.recent_messages.map(source=>source.message_id)).toEqual([correction]);
  expect(f.modelInputs[0]?.notes.some(note=>note.id===old.id)).toBe(true);
 }finally{await f.close();}
});
test('malformed prior-only model facts are rejected before commit and the fresh correction remains retryable',async()=>{
 const f=await fixture();try{
  const topic=await f.topic('Historical fact'),old=topic.notes[0];if(!old)throw new TypeError('Missing target');
  const coordinator=f.make(),id=await f.select(coordinator,topic,[old.id],'A fresh correction');coordinator.delivered(topic.id);f.controls.priorOnly=true;
  await expect(coordinator.drain(AbortSignal.timeout(5000),()=>{})).rejects.toMatchObject({code:'invalid_metadata'});
  expect(coordinator.checkpoint().fresh_sources?.find(item=>item.context_id===topic.id)?.message_ids).toEqual([id]);
  expect(z.object({count:z.coerce.number()}).parse((await sql`SELECT count(*) FROM assistant.semantic_context_notes WHERE workspace_id=${f.workspace}`)[0]).count).toBe(40);
  f.controls.priorOnly=false;await coordinator.drain(AbortSignal.timeout(5000),()=>{});
  expect(z.object({count:z.coerce.number()}).parse((await sql`SELECT count(*) FROM assistant.semantic_context_notes WHERE workspace_id=${f.workspace}`)[0]).count).toBe(41);
 }finally{await f.close();}
});
test('more than eight fresh sources survive batch commit interruption without truncation or repeated old facts',async()=>{
 const f=await fixture();try{
  const topic=await f.topic('Batched facts'),coordinator=f.make(),ids:string[]=[];f.controls.allFresh=true;
  for(let index=0;index<12;index++)ids.push(await f.select(coordinator,topic,[],`New independent fact ${index}`));
  coordinator.delivered(topic.id);let saved=SemanticCheckpoint.parse(JSON.parse(JSON.stringify(coordinator.checkpoint())));
  await expect(coordinator.drain(AbortSignal.timeout(5000),()=>{
   saved=SemanticCheckpoint.parse(JSON.parse(JSON.stringify(coordinator.checkpoint())));
   if(!saved.note_batch&&!saved.mutation&&saved.fresh_sources?.[0]?.message_ids.length===4)throw new TypeError('fixture process interrupted after first committed batch');
  })).rejects.toThrow('fixture process interrupted');
  expect(saved.fresh_sources?.[0]?.message_ids).toEqual(ids.slice(8));
  const restored=f.make(saved);await restored.drain(AbortSignal.timeout(5000),()=>{});
  expect(f.snapshots.map(item=>item.source_ids.length)).toEqual([8,4]);
  expect(f.modelInputs.flatMap(context=>context.recent_messages.map(source=>source.message_id))).toEqual(ids);
  expect(z.object({count:z.coerce.number()}).parse((await sql`SELECT count(*) FROM assistant.semantic_context_notes WHERE workspace_id=${f.workspace}`)[0]).count).toBe(52);
  expect(restored.checkpoint().fresh_sources).toEqual([]);
 }finally{await f.close();}
});
test('reselecting a processed linked source in a later controller does not make it fresh again',async()=>{
 const f=await fixture();try{
  const topic=await f.topic('Replay source'),old=topic.notes[0];if(!old)throw new TypeError('Missing target');
  const first=f.make(),id=await f.select(first,topic,[old.id],'One correction');first.delivered(topic.id);await first.drain(AbortSignal.timeout(5000),()=>{});
  const next=f.make();await next.index(id,AbortSignal.timeout(5000));next.delivered(topic.id);await next.drain(AbortSignal.timeout(5000),()=>{});
  expect(f.modelInputs).toHaveLength(1);expect(z.object({count:z.coerce.number()}).parse((await sql`SELECT count(*) FROM assistant.semantic_context_notes WHERE workspace_id=${f.workspace}`)[0]).count).toBe(41);
 }finally{await f.close();}
});
test('checkpoint saved before a lost link response preserves the still-unextracted source after restart',async()=>{
 const f=await fixture();try{
  const topic=await f.topic('Lost source linkage'),old=topic.notes[0];if(!old)throw new TypeError('Missing target');let saved:SemanticCheckpoint={active:null,pending:[]};
  const controller=new SemanticContexts({http:f.http,runId:f.run,taskId:f.task,provider:f.provider,persist:()=>{saved=SemanticCheckpoint.parse(JSON.parse(JSON.stringify(controller.checkpoint())));}});
  f.controls.dropLink=true;await expect(f.select(controller,topic,[old.id],'Correction after lost link ACK')).rejects.toThrow();
  expect(saved.retrieved_notes?.find(item=>item.context_id===topic.id)?.note_ids).toEqual([old.id]);
  expect(saved.unindexed).toHaveLength(1);const id=saved.unindexed?.[0];if(!id)throw new TypeError('Lost source was not checkpointed');
  const restored=f.make(saved);await restored.drain(AbortSignal.timeout(5000),()=>{});
  expect(f.modelInputs.flatMap(context=>context.recent_messages.map(source=>source.message_id))).toEqual([id]);
  expect(z.object({count:z.coerce.number()}).parse((await sql`SELECT count(*) FROM assistant.semantic_context_links WHERE workspace_id=${f.workspace} AND message_id=${id}`)[0]).count).toBe(1);
  expect(z.object({count:z.coerce.number()}).parse((await sql`SELECT count(*) FROM assistant.semantic_context_notes WHERE workspace_id=${f.workspace} AND supersedes=${old.id}`)[0]).count).toBe(1);
 }finally{await f.close();}
});
test('legacy job without an evidence boundary parks durably while normal fresh work drains',async()=>{
 const f=await fixture(),directory=await mkdtemp(join(tmpdir(),'legacy-note-boundary-')),path=join(directory,'journal.sqlite');let journal=new Journal(path),queue=new SemanticMetadataQueue({jobs:journal.semantic,http:f.http,provider:f.provider});
 try{
  const topic=await f.topic('Legacy ambiguity'),old=topic.notes[0];if(!old)throw new TypeError('Missing target');
  const legacy={runId:f.run,taskId:f.task,state:{active:{context_id:topic.id,message_id:topic.source},pending:[topic.id]}};journal.semantic.enqueue(legacy);
  await queue.process();expect(f.modelInputs).toHaveLength(0);expect(journal.semantic.next(Number.MAX_SAFE_INTEGER)).toBeNull();
  await queue.stop();journal.close();journal=new Journal(path);queue=new SemanticMetadataQueue({jobs:journal.semantic,http:f.http,provider:f.provider});
  journal.semantic.enqueue(legacy);expect(journal.semantic.next(Number.MAX_SAFE_INTEGER)).toBeNull();
  const normal=f.make();await f.select(normal,topic,[old.id],'New explicit correction after parked legacy job');normal.delivered(topic.id);
  journal.semantic.enqueue({runId:f.run,taskId:f.task,state:normal.checkpoint()});await queue.process();await queue.process(Number.MAX_SAFE_INTEGER);
  expect(f.modelInputs).toHaveLength(1);expect(journal.semantic.next(Number.MAX_SAFE_INTEGER)).toBeNull();
  const {Database}=await import('bun:sqlite');const database=new Database(path);try{expect(database.query('SELECT count(*) AS count FROM semantic_metadata_jobs WHERE retry_at=-1').get()).toEqual({count:1});}finally{database.close();}
 }finally{await queue.stop();journal.close();await f.close();await rm(directory,{recursive:true,force:true});}
});
test('a saved batch resumes before contexts reordered by an in-flight new delivery',async()=>{
 const f=await fixture();let running:Promise<void>|undefined;try{
  f.controls.allFresh=true;const a=await f.topic('Concurrent A'),b=await f.topic('Concurrent B'),controller=f.make(),a1=await f.select(controller,a,[],'New A first'),b1=await f.select(controller,b,[],'New B first'),a2=await f.select(f.make(),a,[],'New A recovered during prior batch');
  let saved=SemanticCheckpoint.parse(JSON.parse(JSON.stringify(controller.checkpoint())));f.holds.next=true;
  running=controller.drain(AbortSignal.timeout(5000),()=>{saved=SemanticCheckpoint.parse(JSON.parse(JSON.stringify(controller.checkpoint())));if(saved.mutation)throw new TypeError('fixture stopped after mutation persisted');});
  const result=running.then(()=>null,error=>{if(error instanceof Error)return error;throw error;});await f.holds.started.promise;
  controller.deferSource(a2);await controller.index(a2,AbortSignal.timeout(5000));f.holds.release.resolve();expect((await result)?.message).toBe('fixture stopped after mutation persisted');running=undefined;
  expect(saved.fresh_sources?.map(item=>item.context_id)).toEqual([b.id,a.id]);expect(saved.mutation?.context_id).toBe(a.id);
  const restored=f.make(saved);await restored.drain(AbortSignal.timeout(5000),()=>{});
  const observed=f.modelInputs.flatMap(context=>context.recent_messages.map(source=>source.message_id));expect(observed).toHaveLength(3);expect(observed.toSorted()).toEqual([a1,a2,b1].toSorted());
  expect(z.object({count:z.coerce.number()}).parse((await sql`SELECT count(*) FROM assistant.semantic_context_notes WHERE workspace_id=${f.workspace}`)[0]).count).toBe(83);
 }finally{f.holds.release.resolve();await running?.catch(error=>{if(!(error instanceof TypeError))throw error;});await f.close();}
});
test('secondary references remain read-only and checkpoint restore revalidates actual PostgreSQL retention',async()=>{
 const f=await fixture();try{
  const a=await f.topic('Primary reference'),b=await f.topic('Auxiliary reference'),old=a.notes[0];if(!old)throw new TypeError('Missing note');
  const controller=f.make(),id=await f.select(controller,a,[old.id],'Compare these independent topics');
  const parse=(item:Awaited<ReturnType<SemanticContexts['select']>>)=>{if(!('content'in item)||typeof item.content!=='string')throw new TypeError('Missing reference');return z.object({context:SemanticContext.nullable(),alternatives:z.array(SemanticContext)}).parse(JSON.parse(item.content));};
  const reference=parse(await controller.select(id,AbortSignal.timeout(5000)));
  expect(reference.context?.context_id).toBe(a.id);expect(reference.alternatives.some(item=>item.context_id===b.id&&item.recent_messages.some(source=>source.message_id===b.source))).toBe(true);
  expect(controller.checkpoint().fresh_sources).toEqual([{context_id:a.id,message_ids:[id]}]);
  expect(z.array(z.object({context_id:z.uuid()})).parse(await sql`SELECT context_id FROM assistant.semantic_context_links WHERE workspace_id=${f.workspace} AND message_id=${id}`)).toEqual([{context_id:a.id}]);
  const saved=SemanticCheckpoint.parse(JSON.parse(JSON.stringify(controller.checkpoint())));
  await sql`UPDATE assistant.memory_retention_decisions SET action='deny_turn',quote='Original Auxiliary reference decision' WHERE workspace_id=${f.workspace} AND source_message_id=${b.source}`;
  const restored=f.make(saved),item=await restored.refreshReference(AbortSignal.timeout(5000));if(!item)throw new TypeError('Missing restored reference');
  const next=parse(item),auxiliary=next.alternatives.find(context=>context.context_id===b.id);
  expect(next.context?.context_id).toBe(a.id);expect(auxiliary?.notes??[]).toEqual([]);expect(auxiliary?.recent_messages??[]).toEqual([]);
  expect(f.modelInputs).toEqual([]);
  expect(z.object({count:z.coerce.number()}).parse((await sql`SELECT count(*) FROM assistant.semantic_context_notes WHERE workspace_id=${f.workspace}`)[0]).count).toBe(80);
 }finally{await f.close();}
});
