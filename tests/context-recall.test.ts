import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createDatabase } from '../services/control/db';
import { prepareSemanticContext, linkContext, writeContextNotes } from '../packages/context/store';
import { createSemanticRetriever } from '../packages/context/recall';
import { contextChunks, contextNamespace, synchronizeContextIndex, flushContextIndex } from '../packages/context/recall-index';
import { contextCosine, type ContextEmbed, type ContextVectorIndex, type SearchVector } from '../packages/context/recall-types';
import type { Principal } from '../services/control/auth';
const url=process.env['TEST_DATABASE_URL']??'postgres://assistant:assistant@127.0.0.1:55439/semantic_context_1006';
const sql=createDatabase(url);
beforeAll(async()=>{const process=Bun.spawn(['bun','scripts/migrate.ts'],{env:{...Bun.env,DATABASE_URL:url},stdout:'pipe',stderr:'pipe'});expect(await process.exited).toBe(0);});
afterAll(()=>sql.end());
function searchFixture() {
  const vectors=new Map<string,SearchVector>(),inputs:string[][]=[];
  const embed:ContextEmbed=async texts=>{inputs.push([...texts]);return {data:texts.map(text=>Array.from({length:1024},(_,i)=>i===0?(text.includes('quartz')?1:0):i===1?(text.includes('quartz')?0:1):0))};};
  const index:ContextVectorIndex={
    async upsert(batch){for(const vector of batch)vectors.set(vector.id,vector);return {};},
    async deleteByIds(ids){for(const id of ids)vectors.delete(id);return {};},
    async query(vector,options){return {matches:[...vectors.values()].filter(item=>item.namespace===options.namespace&&item.metadata.sequence<=options.filter.sequence.$lte).map(item=>({id:item.id,score:contextCosine(vector,item.values)})).toSorted((a,b)=>b.score-a.score).slice(0,options.topK)};},
  };
  return {embed,index,vectors,inputs};
}
async function fixture(existingWorkspace?:string) {
  const workspace=existingWorkspace??crypto.randomUUID(),conversation=crypto.randomUUID(),vm=crypto.randomUUID(),task=crypto.randomUUID(),run=crypto.randomUUID();
  if(!existingWorkspace)await sql`INSERT INTO assistant.workspaces(id,name) VALUES(${workspace},'context recall QA')`;
  await sql`INSERT INTO assistant.conversations(id,workspace_id,title) VALUES(${conversation},${workspace},'recall')`;
  await sql`INSERT INTO assistant.vms(id,workspace_id,name) VALUES(${vm},${workspace},'fixture')`;
  await sql`INSERT INTO assistant.tasks(id,workspace_id,conversation_id,objective,state) VALUES(${task},${workspace},${conversation},'fixture','running')`;
  await sql`INSERT INTO assistant.runs(id,workspace_id,task_id,vm_id) VALUES(${run},${workspace},${task},${vm})`;
  const principal:Principal={workspace_id:workspace,role:'vm',vm_id:vm};
  const message=async(content:string)=>{
    const id=crypto.randomUUID();await sql`INSERT INTO assistant.messages(id,workspace_id,conversation_id,task_id,role,content) VALUES(${id},${workspace},${conversation},${task},'user',${content})`;
    await sql`INSERT INTO assistant.memory_retention_decisions(workspace_id,task_id,source_message_id,action) VALUES(${workspace},${task},${id},'inherit')`;
    return await prepareSemanticContext(sql,principal,run,{message_id:id});
  };
  const topic=async(content:string)=>{
    const prepared=await message(content);
    const linked=await linkContext(sql,principal,run,{operation_id:crypto.randomUUID(),message_id:prepared.source.message_id,source_sha256:prepared.source.sha256,expected_link_revision:0,choice:{kind:'new',title:'Source topic',scope:'Original source discussion'},status:'confirmed',evidence:[{message_id:prepared.source.message_id,quote:content.slice(0,1000)}]});
    return {prepared,linked};
  };
  return {workspace,conversation,principal,run,message,topic};
}

test('chunks cover the complete original with bounded windows and overlap',()=>{
  const original='abc'.repeat(13000),chunks=contextChunks(original);
  expect(chunks[0]?.start).toBe(0);expect(chunks.at(-1)?.end).toBe(original.length);
  expect(chunks.every(chunk=>chunk.text===original.slice(chunk.start,chunk.end)&&chunk.text.length<=1800)).toBe(true);
  expect(chunks.every((chunk,i)=>i===0||chunk.start<=(chunks[i-1]?.end??0))).toBe(true);
});

test('workspace recall reaches a legacy conversation while rejecting other workspaces',async()=>{
  const current=await fixture(),legacy=await fixture(current.workspace),foreign=await fixture(),search=searchFixture();
  const secret=await foreign.topic('quartz private other assistant');
  await synchronizeContextIndex(sql,search.embed,search.index,{workspace:foreign.workspace,conversation:foreign.conversation});
  const original=await legacy.topic('quartz calendar account changed from personal to company account');
  const query=await current.message('quartz calendar company account');
  const matches=await createSemanticRetriever(sql,search.embed,search.index)(query,{workspace:current.workspace,conversation:current.conversation});
  expect(matches.some(match=>match.context_id===original.linked.context.context_id)).toBe(true);
  expect(matches.some(match=>match.context_id===secret.linked.context.context_id)).toBe(false);
  expect((await sql`SELECT conversation_id FROM assistant.messages WHERE id=${original.prepared.source.message_id}`)[0]?.['conversation_id']).toBe(legacy.conversation);
  const foreignIds=(await sql`SELECT id FROM assistant.semantic_search_documents WHERE workspace_id=${foreign.workspace}`).map(row=>String(row['id']));
  const hostile:ContextVectorIndex={...search.index,async query(){return {matches:foreignIds.map(id=>({id,score:1}))};}};
  const filtered=await createSemanticRetriever(sql,search.embed,hostile)(query,{workspace:current.workspace,conversation:current.conversation});
  expect(filtered.every(match=>match.context_id!==secret.linked.context.context_id)).toBe(true);
},20000);

test('namespace upgrade republishes a warm index and preserves failed delivery for retry',async()=>{
  const f=await fixture(),search=searchFixture();await f.topic('quartz legacy namespace');
  const scope={workspace:f.workspace,conversation:f.conversation};
  await synchronizeContextIndex(sql,search.embed,search.index,scope);
  for(const [id,vector] of search.vectors)search.vectors.set(id,{...vector,namespace:'legacy-conversation-namespace'});
  await sql`UPDATE assistant.semantic_search_state SET namespace_version=1 WHERE workspace_id=${f.workspace}`;
  const calls=search.inputs.length;
  const failing:ContextVectorIndex={...search.index,async upsert(){throw new TypeError('namespace republish outage');}};
  await expect(synchronizeContextIndex(sql,search.embed,failing,scope)).rejects.toThrow('namespace republish outage');
  expect(await sql`SELECT id FROM assistant.semantic_search_outbox WHERE workspace_id=${f.workspace}`).toHaveLength(1);
  await synchronizeContextIndex(sql,search.embed,search.index,scope);
  expect(search.inputs.length).toBe(calls);
  expect([...search.vectors.values()].map(vector=>vector.namespace)).toEqual([await contextNamespace(scope)]);
  expect(await contextNamespace({...scope,conversation:crypto.randomUUID()})).toBe(await contextNamespace(scope));
  expect(await sql`SELECT id FROM assistant.semantic_search_outbox WHERE workspace_id=${f.workspace}`).toHaveLength(0);
},20000);

test('query finds a later source window and link response preserves it; warm lookup embeds only query',async()=>{
  const f=await fixture(),search=searchFixture();
  const original='background information '.repeat(900)+'quartz reactor must stay below 42 degrees';
  const a=await f.topic(original),query=await f.message('quartz reactor temperature');
  const retrieve=createSemanticRetriever(sql,search.embed,search.index),scope={workspace:f.workspace,conversation:f.conversation};
  const matches=await retrieve(query,scope),first=matches[0];
  expect(first?.context_id).toBe(a.linked.context.context_id);
  if(!first)throw new Error('Missing match');
  const window=first.source_windows?.[0];expect(window?.start).toBeGreaterThan(1800);
  const result=await linkContext(sql,f.principal,f.run,{operation_id:crypto.randomUUID(),message_id:query.source.message_id,source_sha256:query.source.sha256,expected_link_revision:0,choice:{kind:'existing',context_id:first.context_id,expected_context_revision:a.linked.context.revision},status:'confirmed',evidence:[{message_id:query.source.message_id,quote:query.source.content}],source_windows:first.source_windows?[...first.source_windows]:[]});
  expect(result.context.recent_messages.some(source=>source.content.includes('below 42')&&source.content_offset>1800)).toBe(true);
  const next=await f.message('quartz conditions');await retrieve(next,scope);const count=search.inputs.length;await retrieve(next,scope);
  expect(search.inputs.length-count).toBe(1);expect(search.inputs.at(-1)).toHaveLength(1);
},20000);

test('all active notes are indexed and a matching note older than latest16 is retrieved',async()=>{
  const f=await fixture(),search=searchFixture(),a=await f.topic('quartz decision and unrelated observations');let revision=a.linked.context.revision;
  const target=crypto.randomUUID();
  for(let n=0;n<20;n++) {
    const result=await writeContextNotes(sql,f.principal,f.run,{operation_id:crypto.randomUUID(),context_id:a.linked.context.context_id,expected_revision:revision,source_message_id:a.prepared.source.message_id,source_sha256:a.prepared.source.sha256,notes:[{id:n===0?target:crypto.randomUUID(),kind:'decision',text:n===0?'quartz limit 42':'other observation '+n,evidence:[{message_id:a.prepared.source.message_id,quote:n===0?'quartz decision':'unrelated observations'}]}]});revision=result.context.revision;
  }
  const query=await f.message('quartz limit'),matches=await createSemanticRetriever(sql,search.embed,search.index)(query,{workspace:f.workspace,conversation:f.conversation});
  expect(matches[0]?.note_ids).toContain(target);
  expect(search.inputs.flat().some(text=>text==='quartz limit 42')).toBe(true);
},20000);

test('suppressed sources are neither embedded nor returned from an existing index',async()=>{
  const f=await fixture(),search=searchFixture(),a=await f.topic('quartz confidential source');
  const scope={workspace:f.workspace,conversation:f.conversation};
  await synchronizeContextIndex(sql,search.embed,search.index,scope);
  await sql`INSERT INTO assistant.memory_suppressions(workspace_id,source_message_id) VALUES(${f.workspace},${a.prepared.source.message_id})`;
  const query=await f.message('quartz confidential'),count=search.inputs.length;
  const matches=await createSemanticRetriever(sql,search.embed,search.index)(query,scope);
  expect(matches).toHaveLength(0);
  expect(search.inputs.slice(count).flat()).not.toContain('quartz confidential source');
  expect(search.vectors.size).toBe(0);
},20000);

test('external deletion failure leaves a durable retry after source suppression',async()=>{
  const f=await fixture(),search=searchFixture(),a=await f.topic('quartz removed');
  const scope={workspace:f.workspace,conversation:f.conversation};
  await synchronizeContextIndex(sql,search.embed,search.index,scope);
  await sql`INSERT INTO assistant.memory_suppressions(workspace_id,source_message_id) VALUES(${f.workspace},${a.prepared.source.message_id})`;
  const failing:ContextVectorIndex={...search.index,async deleteByIds(){throw new TypeError('simulated vector outage');}};
  await expect(synchronizeContextIndex(sql,search.embed,failing,scope)).rejects.toThrow('simulated vector outage');
  expect(await sql`SELECT id FROM assistant.semantic_search_outbox WHERE workspace_id=${f.workspace}`).toHaveLength(1);
  await synchronizeContextIndex(sql,search.embed,search.index,scope);
  expect(search.vectors.size).toBe(0);
  expect(await sql`SELECT id FROM assistant.semantic_search_outbox WHERE workspace_id=${f.workspace}`).toHaveLength(0);
},20000);

test('a source changed during embedding is never published to the remote index',async()=>{
  const f=await fixture(),search=searchFixture(),a=await f.topic('quartz old source');
  const embed:ContextEmbed=async(texts,signal)=>{
    const result=await search.embed(texts,signal);
    await sql`UPDATE assistant.messages SET content='edited original' WHERE id=${a.prepared.source.message_id}`;
    return result;
  };
  const result=await synchronizeContextIndex(sql,embed,search.index,{workspace:f.workspace,conversation:f.conversation});
  expect(result.pending).toBe(true);expect(search.vectors.size).toBe(0);
  expect(await sql`SELECT id FROM assistant.semantic_search_documents WHERE workspace_id=${f.workspace}`).toHaveLength(0);
},20000);

test('a slower historical sync cannot replace a newer index snapshot',async()=>{
  const f=await fixture(),search=searchFixture(),a=await f.topic('quartz initial');
  const next=await f.message('additional retained detail');
  await linkContext(sql,f.principal,f.run,{operation_id:crypto.randomUUID(),message_id:next.source.message_id,source_sha256:next.source.sha256,expected_link_revision:0,choice:{kind:'existing',context_id:a.linked.context.context_id,expected_context_revision:a.linked.context.revision},status:'confirmed',evidence:[{message_id:next.source.message_id,quote:next.source.content}]});
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
  const slow:ContextEmbed=async(texts,signal)=>{entered.resolve();await release.promise;return search.embed(texts,signal);};
  const scope={workspace:f.workspace,conversation:f.conversation};
  const old=synchronizeContextIndex(sql,slow,search.index,scope,a.prepared.source.sequence);
  await entered.promise;await synchronizeContextIndex(sql,search.embed,search.index,scope);
  release.resolve();await old;
  expect(await sql`SELECT id FROM assistant.semantic_search_documents WHERE workspace_id=${f.workspace}`).toHaveLength(2);
  expect(search.vectors.size).toBe(2);
},20000);

test('remote upsert failure replays persisted vectors without embedding again',async()=>{
  const f=await fixture(),search=searchFixture();await f.topic('quartz retry');
  const scope={workspace:f.workspace,conversation:f.conversation};
  const failing:ContextVectorIndex={...search.index,async upsert(){throw new TypeError('upsert unavailable');}};
  await expect(synchronizeContextIndex(sql,search.embed,failing,scope)).rejects.toThrow('upsert unavailable');
  const calls=search.inputs.length;
  await synchronizeContextIndex(sql,search.embed,search.index,scope);
  expect(search.inputs.length).toBe(calls);expect(search.vectors.size).toBe(1);
  expect(await sql`SELECT id FROM assistant.semantic_search_outbox WHERE workspace_id=${f.workspace}`).toHaveLength(0);
},20000);

test('full sync restores cached documents removed by a same-revision historical sync',async()=>{
  const f=await fixture(),search=searchFixture(),a=await f.topic('quartz initial decision');
  const second=await f.message('later source remains searchable');
  const linked=await linkContext(sql,f.principal,f.run,{operation_id:crypto.randomUUID(),message_id:second.source.message_id,source_sha256:second.source.sha256,expected_link_revision:0,choice:{kind:'existing',context_id:a.linked.context.context_id,expected_context_revision:a.linked.context.revision},status:'confirmed',evidence:[{message_id:second.source.message_id,quote:second.source.content}]});
  const scope={workspace:f.workspace,conversation:f.conversation};
  await synchronizeContextIndex(sql,search.embed,search.index,scope);
  await writeContextNotes(sql,f.principal,f.run,{operation_id:crypto.randomUUID(),context_id:a.linked.context.context_id,expected_revision:linked.context.revision,source_message_id:a.prepared.source.message_id,source_sha256:a.prepared.source.sha256,notes:[{id:crypto.randomUUID(),kind:'decision',text:'quartz initial decision',evidence:[{message_id:a.prepared.source.message_id,quote:'quartz initial decision'}]}]});
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
  const slow:ContextEmbed=async(texts,signal)=>{entered.resolve();await release.promise;return search.embed(texts,signal);};
  const current=synchronizeContextIndex(sql,slow,search.index,scope);
  await entered.promise;
  try{await synchronizeContextIndex(sql,search.embed,search.index,scope,a.prepared.source.sequence);}
  finally{release.resolve();}
  await current;
  const documents=await sql`SELECT id,reference_id FROM assistant.semantic_search_documents WHERE workspace_id=${f.workspace}`;
  expect(documents).toHaveLength(3);
  expect(documents.some(document=>document['reference_id']===second.source.message_id)).toBe(true);
  expect(search.vectors.size).toBe(3);
  expect([...search.vectors.keys()].sort()).toEqual(documents.map(document=>String(document['id'])).sort());
  expect(await sql`SELECT id FROM assistant.semantic_search_outbox WHERE workspace_id=${f.workspace}`).toHaveLength(0);
},20000);

test('suppression between canonical commit and outbox delivery prevents stale remote upsert',async()=>{
  const f=await fixture(),search=searchFixture(),a=await f.topic('quartz revoke pending');
  const scope={workspace:f.workspace,conversation:f.conversation};
  const failing:ContextVectorIndex={...search.index,async upsert(){throw new TypeError('defer delivery');}};
  await expect(synchronizeContextIndex(sql,search.embed,failing,scope)).rejects.toThrow('defer delivery');
  await sql`INSERT INTO assistant.memory_suppressions(workspace_id,source_message_id) VALUES(${f.workspace},${a.prepared.source.message_id})`;
  expect(await flushContextIndex(sql,search.index,scope,a.linked.context.context_id)).toBe(false);
  expect(search.vectors.size).toBe(0);
  expect(await sql`SELECT id FROM assistant.semantic_search_outbox WHERE workspace_id=${f.workspace}`).toHaveLength(1);
  await synchronizeContextIndex(sql,search.embed,search.index,scope);
  expect(search.vectors.size).toBe(0);
  expect(await sql`SELECT id FROM assistant.semantic_search_outbox WHERE workspace_id=${f.workspace}`).toHaveLength(0);
},20000);
