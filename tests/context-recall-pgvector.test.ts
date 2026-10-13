import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createDatabase } from '../services/control/db';
import { contextCosine } from '../packages/context/recall-types';

const url=process.env['TEST_DATABASE_URL']??'postgres://assistant:assistant@127.0.0.1:55439/assistant_test';
const sql=createDatabase(url);
beforeAll(async()=>{
  const migration=Bun.spawn(['bun','scripts/migrate.ts'],{env:{...Bun.env,DATABASE_URL:url},stdout:'pipe',stderr:'pipe'});
  expect(await migration.exited).toBe(0);
});
afterAll(()=>sql.end());

test('045 converts existing jsonb rows in place and preserves scope indexes and search state',async()=>{
  const schema=`migration_${crypto.randomUUID().replaceAll('-','')}`;
  const rollback=new Error('rollback fixture');
  await expect(sql.begin(async tx=>{
    await tx`CREATE SCHEMA ${tx(schema)}`;
    await tx`SET LOCAL search_path TO ${tx(schema)},assistant,public`;
    await tx`CREATE TABLE semantic_contexts(workspace_id uuid,conversation_id uuid,id uuid,PRIMARY KEY(workspace_id,conversation_id,id))`;
    await tx.unsafe(await Bun.file(new URL('../infra/migrations/037_semantic_search_documents.sql',import.meta.url)).text());
    await tx.unsafe(await Bun.file(new URL('../infra/migrations/043_semantic_workspace_search.sql',import.meta.url)).text());
    await tx`ALTER TABLE semantic_search_state ADD COLUMN search_revision bigint NOT NULL DEFAULT 0`;
    await tx`CREATE TABLE semantic_search_outbox(id text PRIMARY KEY)`;
    const workspace=crypto.randomUUID(),conversation=crypto.randomUUID(),context=crypto.randomUUID(),reference=crypto.randomUUID();
    const vector=Array.from({length:1024},(_,i)=>i===0?1:i===1?0.5:0);
    await tx`INSERT INTO semantic_contexts VALUES(${workspace},${conversation},${context})`;
    await tx`INSERT INTO semantic_search_documents(id,workspace_id,conversation_id,context_id,kind,reference_id,source_sequence,input_hash,start_offset,end_offset,vector)
      VALUES(${'a'.repeat(64)},${workspace},${conversation},${context},'source',${reference},42,'hash',0,12,${JSON.stringify(vector)}::text::jsonb)`;
    await tx`INSERT INTO semantic_search_state(workspace_id,conversation_id,context_id,revision,search_revision,through_sequence,namespace_version) VALUES(${workspace},${conversation},${context},3,7,42,2)`;
    await tx`INSERT INTO semantic_search_outbox VALUES(${'a'.repeat(64)})`;
    const before=await tx`SELECT id,workspace_id,conversation_id,context_id,reference_id,input_hash,source_sequence,start_offset,end_offset,updated_at FROM semantic_search_documents WHERE workspace_id=${workspace}`;
    await tx.unsafe(await Bun.file(new URL('../infra/migrations/048_semantic_search_pgvector.sql',import.meta.url)).text());
    expect([...(await tx`SELECT id,workspace_id,conversation_id,context_id,reference_id,input_hash,source_sequence,start_offset,end_offset,updated_at FROM semantic_search_documents WHERE workspace_id=${workspace}`)]).toEqual([...before]);
    expect((await tx`SELECT vector::text::jsonb AS vector,vector_dims(vector) AS dimensions FROM semantic_search_documents WHERE workspace_id=${workspace}`)[0]).toEqual({vector,dimensions:1024});
    expect((await tx`SELECT revision,search_revision,through_sequence FROM semantic_search_state WHERE workspace_id=${workspace}`)[0]).toEqual({revision:3,search_revision:'7',through_sequence:'42'});
    const indexes=await tx`SELECT indexname,indexdef FROM pg_indexes WHERE schemaname=${schema} AND tablename='semantic_search_documents'`;
    expect(indexes.map(row=>row['indexname'])).toEqual(expect.arrayContaining(['semantic_search_scope','semantic_search_context','semantic_search_tail','semantic_search_workspace_sequence','semantic_search_workspace_tail','semantic_search_vector_cosine']));
    expect(indexes.find(row=>row['indexname']==='semantic_search_vector_cosine')?.['indexdef']).toContain('USING hnsw (vector vector_cosine_ops)');
    expect(await tx`SELECT column_name FROM information_schema.columns WHERE table_schema=${schema} AND table_name='semantic_search_state' AND column_name='namespace_version'`).toHaveLength(0);
    expect(await tx`SELECT tablename FROM pg_tables WHERE schemaname=${schema} AND tablename='semantic_search_outbox'`).toHaveLength(0);
    await expect(tx.savepoint(async nested=>{await nested`UPDATE semantic_search_documents SET vector='[1,2]'::vector WHERE workspace_id=${workspace}`;})).rejects.toThrow('expected 1024 dimensions');
    throw rollback;
  })).rejects.toBe(rollback);
});

test('filtered HNSW iterates past foreign and future neighbors and agrees with cosine ranking',async()=>{
  const rollback=new Error('rollback fixture');
  await expect(sql.begin(async tx=>{
    await tx`CREATE TEMP TABLE recall_vectors(id integer,workspace_id uuid,source_sequence bigint,vector vector(1024)) ON COMMIT DROP`;
    const workspace=crypto.randomUUID(),foreign=crypto.randomUUID();
    const query=Array.from({length:1024},(_,i)=>i===0?1:0);
    const eligible=[];
    for(let i=0;i<256;i++) {
      const values=Array.from({length:1024},(_,axis)=>axis===0?1:axis===1?(i+1)/256:0);
      const owner=i<128?foreign:workspace,sequence=i<192?100:1;
      await tx`INSERT INTO recall_vectors VALUES(${i},${owner},${sequence},${JSON.stringify(values)}::vector)`;
      if(owner===workspace&&sequence<=1)eligible.push({id:i,score:contextCosine(query,values)});
    }
    await tx`CREATE INDEX ON recall_vectors USING hnsw(vector vector_cosine_ops)`;
    await tx`SET LOCAL enable_seqscan = off`;
    await tx`SET LOCAL hnsw.iterative_scan = relaxed_order`;
    await tx`SET LOCAL hnsw.ef_search = 100`;
    const plan=await tx`EXPLAIN SELECT id FROM recall_vectors WHERE workspace_id=${workspace} AND source_sequence<=1 ORDER BY vector <=> ${JSON.stringify(query)}::vector LIMIT 64`;
    expect(plan.map(row=>row['QUERY PLAN']).join('\n')).toContain('Index Scan');
    const rows=await tx<{id:number;vector:number[]}[]>`SELECT id,vector::text::jsonb AS vector FROM recall_vectors WHERE workspace_id=${workspace} AND source_sequence<=1 ORDER BY vector <=> ${JSON.stringify(query)}::vector LIMIT 64`;
    expect(rows).toHaveLength(64);
    expect(rows.toSorted((a,b)=>contextCosine(query,b.vector)-contextCosine(query,a.vector)).map(row=>row.id)).toEqual(eligible.toSorted((a,b)=>b.score-a.score).map(row=>row.id));
    throw rollback;
  })).rejects.toBe(rollback);
},20000);
