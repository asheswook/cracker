import { afterAll, beforeAll, expect, test } from 'bun:test';
import { z } from 'zod';
import { createDatabase } from '../services/control/db';
import type { Principal } from '../services/control/auth';
import { linkContext, prepareSemanticContext } from '../packages/context/store';
import { createSemanticRetriever } from '../packages/context/recall';
import { synchronizeContextIndex } from '../packages/context/recall-index';
import type { ContextEmbed } from '../packages/context/recall-types';

const {TEST_DATABASE_URL:url='postgres://assistant:assistant@127.0.0.1:55439/semantic_recall_concurrency_1007'}=process.env;
const sql=createDatabase(url);
beforeAll(async()=>{
  const migration=Bun.spawn(['bun','scripts/migrate.ts'],{env:{...Bun.env,DATABASE_URL:url},stdout:'pipe',stderr:'pipe'});
  expect(await migration.exited).toBe(0);
});
afterAll(()=>sql.end());

async function fixture(count:number) {
  const workspace=crypto.randomUUID(),conversation=crypto.randomUUID(),vm=crypto.randomUUID(),task=crypto.randomUUID(),run=crypto.randomUUID();
  await sql`INSERT INTO assistant.workspaces(id,name) VALUES(${workspace},'recall concurrency QA')`;
  await sql`INSERT INTO assistant.conversations(id,workspace_id,title) VALUES(${conversation},${workspace},'recall')`;
  await sql`INSERT INTO assistant.vms(id,workspace_id,name) VALUES(${vm},${workspace},'fixture')`;
  await sql`INSERT INTO assistant.tasks(id,workspace_id,conversation_id,objective,state) VALUES(${task},${workspace},${conversation},'fixture','running')`;
  await sql`INSERT INTO assistant.runs(id,workspace_id,task_id,vm_id) VALUES(${run},${workspace},${task},${vm})`;
  const principal:Principal={workspace_id:workspace,role:'vm',vm_id:vm};
  const message=async(content:string)=>{
    const id=crypto.randomUUID();
    await sql`INSERT INTO assistant.messages(id,workspace_id,conversation_id,task_id,role,content) VALUES(${id},${workspace},${conversation},${task},'user',${content})`;
    await sql`INSERT INTO assistant.memory_retention_decisions(workspace_id,task_id,source_message_id,action) VALUES(${workspace},${task},${id},'inherit')`;
    return prepareSemanticContext(sql,principal,run,{message_id:id});
  };
  const topics=[];
  for(let i=0;i<count;i++) {
    const source=await message(`group ${i}`);
    const linked=await linkContext(sql,principal,run,{operation_id:crypto.randomUUID(),message_id:source.source.message_id,source_sha256:source.source.sha256,expected_link_revision:0,choice:{kind:'new',title:'Group',scope:'Recall fixture'},status:'confirmed',evidence:[{message_id:source.source.message_id,quote:source.source.content}]});
    topics.push({context_id:linked.context.context_id,message_id:source.source.message_id,content:source.source.content});
  }
  const embed:ContextEmbed=async texts=>({data:texts.map(text=>{
    const rank=text.startsWith('group ')?Number(text.slice(6))+1:0;
    return Array.from({length:1024},(_,i)=>i===0?1:i===1?rank/100:0);
  })});
  const scope={workspace,conversation},input=await message('query');
  await synchronizeContextIndex(sql,embed,scope,Number.MAX_SAFE_INTEGER,count);
  return {topics,scope,embed,input};
}

function observedDatabase(before:(context:string)=>Promise<void>) {
  const started:string[]=[];
  let active=0,maximum=0;
  const database=new Proxy(sql,{
    apply(target,thisArg,args:unknown[]) {
      const fragments=args[0];
      if(!Array.isArray(fragments)||typeof fragments[0]!=='string'||!fragments[0].startsWith('SELECT id AS context_id,title'))return Reflect.apply(target,thisArg,args);
      const context=z.string().parse(args[2]);
      started.push(context);active++;maximum=Math.max(maximum,active);
      return before(context).then(()=>Reflect.apply(target,thisArg,args)).finally(()=>{active--;});
    },
  });
  return {database,started,maximum:()=>maximum};
}

function expected(topics:Awaited<ReturnType<typeof fixture>>['topics']) {
  return topics.map(topic=>({context_id:topic.context_id,note_ids:[],source_windows:[{message_id:topic.message_id,start:0,end:topic.content.length}]}));
}

test('overlaps four delayed group reads while preserving the first twelve ranked results',async()=>{
  // Given real PostgreSQL contexts and a controllable first-query barrier.
  const f=await fixture(28),ready=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
  const observed=observedDatabase(async()=>{if(observed.started.length===4)ready.resolve();await release.promise;});
  // When retrieval runs, all four reads must enter before any is released.
  const retrieving=createSemanticRetriever(observed.database,f.embed)(f.input,f.scope);
  const timeout=setTimeout(()=>{ready.reject(new Error('four group reads did not overlap'));release.resolve();},2000);
  try {await ready.promise;} finally {clearTimeout(timeout);release.resolve();await retrieving;}
  const result=await retrieving;
  // Then output and cutoff retain serial semantics, with bounded overlap.
  expect(result).toEqual(expected(f.topics.slice(0,12)));
  expect(observed.maximum()).toBe(4);
  expect(observed.started).toEqual(f.topics.slice(0,24).map(topic=>topic.context_id));
},20000);

test('skips stale groups and ignores a speculative error beyond the first twenty-four valid groups',async()=>{
  // Given one stale hash and two failures after the valid-group cutoff.
  const f=await fixture(30),first=f.topics[0];if(!first)throw new Error('missing fixture');
  await sql`UPDATE assistant.semantic_search_documents SET input_hash='stale' WHERE context_id=${first.context_id}`;
  const ignored=new Set(f.topics.slice(25,28).map(topic=>topic.context_id));
  const observed=observedDatabase(async context=>{if(ignored.has(context))throw new Error('unreached group');});
  // When stale entries do not consume the valid-group budget.
  const result=await createSemanticRetriever(observed.database,f.embed)(f.input,f.scope);
  // Then lookup reaches group25, but consumes no errors beyond it.
  expect(result).toEqual(expected(f.topics.slice(1,13)));
  expect(observed.started).toEqual(f.topics.slice(0,28).map(topic=>topic.context_id));
},20000);

test('propagates the earliest reached error even when a later group rejects first',async()=>{
  // Given two ordered failures with the later failure delivered first.
  const f=await fixture(4),first=f.topics[0],second=f.topics[1];if(!first||!second)throw new Error('missing fixture');
  const later=Promise.withResolvers<void>();
  const observed=observedDatabase(async context=>{
    if(context===first.context_id){await later.promise;throw new Error('first group');}
    if(context===second.context_id){later.resolve();throw new Error('second group');}
  });
  // When both failures settle.
  const retrieving=createSemanticRetriever(observed.database,f.embed)(f.input,f.scope);
  // Then iteration order, not completion order, chooses the error.
  await expect(retrieving).rejects.toThrow('first group');
},20000);

test('rejects freshly suppressed sources after index selection',async()=>{
  // Given an indexed source suppressed after selection, before snapshot hydration.
  const f=await fixture(5),first=f.topics[0];if(!first)throw new Error('missing fixture');
  const observed=observedDatabase(async context=>{
    if(context===first.context_id)await sql`INSERT INTO assistant.memory_suppressions(workspace_id,source_message_id) VALUES(${f.scope.workspace},${first.message_id})`;
  });
  // When hydration reads retention again.
  const result=await createSemanticRetriever(observed.database,f.embed)(f.input,f.scope);
  // Then the stale indexed source is absent from returned references.
  expect(result).toEqual(expected(f.topics.slice(1)));
},20000);

test('sorts validated scores only after selecting the first twenty-four valid groups',async()=>{
  // Given stale high-ranked hits front-loading 24 groups whose valid scores are lower.
  const f=await fixture(27);
  for(const [rank,topic] of f.topics.slice(0,24).entries()) {
    const staleId=(rank+1).toString(16).padStart(4,'0')+f.scope.workspace.replaceAll('-','')+'0'.repeat(28);
    const staleVector=Array.from({length:1024},(_,i)=>i===0?1:0);
    const validVector=Array.from({length:1024},(_,i)=>i===0?1:i===1?1-rank/100:0);
    await sql`INSERT INTO assistant.semantic_search_documents(id,workspace_id,conversation_id,context_id,kind,reference_id,source_sequence,input_hash,start_offset,end_offset,vector)
      SELECT ${staleId},workspace_id,conversation_id,context_id,kind,reference_id,source_sequence,'stale',start_offset,end_offset,${JSON.stringify(staleVector)}::vector
      FROM assistant.semantic_search_documents WHERE context_id=${topic.context_id} LIMIT 1`;
    await sql`UPDATE assistant.semantic_search_documents SET vector=${JSON.stringify(validVector)}::vector WHERE context_id=${topic.context_id} AND id<>${staleId}`;
  }
  // When hydration validates hashes before scoring and applies the original group cutoff.
  const result=await createSemanticRetriever(sql,f.embed)(f.input,f.scope);
  // Then lower-ranked groups with better valid scores cannot displace the reached groups.
  expect(result).toEqual(expected(f.topics.slice(12,24).toReversed()));
},20000);
