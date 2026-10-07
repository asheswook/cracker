import {expect,test} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Database} from 'bun:sqlite';
import ky from 'ky';
import {z} from 'zod';
import {Journal} from '../services/daemon/journal.ts';
import {SemanticMetadataQueue} from '../services/daemon/semantic-context-queue.ts';
import type {SemanticCheckpoint} from '../services/daemon/semantic-context-state.ts';
import {SemanticContext,SemanticSource} from '../packages/context/schema.ts';

test('legacy saved mutation A replays once while unbounded pending B remains parked without inference',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'legacy-pending-')),path=join(directory,'journal.sqlite'),a=crypto.randomUUID(),b=crypto.randomUUID(),run=crypto.randomUUID(),task=crypto.randomUUID(),message=crypto.randomUUID();
 const source=SemanticSource.parse({message_id:message,task_id:task,sequence:1,role:'user',content:'Earlier source with unknown extraction boundary',sha256:'a'.repeat(64),retention_allowed:true,linked_context_id:b,attachments:[],truncated:false});
 const context=(id:string)=>SemanticContext.parse({context_id:id,title:'fixture',scope:'fixture',revision:1,source_sequence:1,notes:[],recent_messages:id===b?[source]:[],files:[]});
 const state:SemanticCheckpoint={active:{context_id:b,message_id:message},pending:[a,b],mutation:{operation_id:crypto.randomUUID(),context_id:a,expected_revision:0,source_message_id:crypto.randomUUID(),source_sha256:'b'.repeat(64),mode:'backfill',notes:[{id:crypto.randomUUID(),kind:'fact',text:'Already committed A',evidence:[{message_id:crypto.randomUUID(),quote:'Already committed A'}],supersedes:null,valid_from:null,valid_to:null}]}};
 const calls:{path:string;body:unknown}[]=[];let modelCalls=0;
 const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:async request=>{const pathname=new URL(request.url).pathname,body:unknown=await request.json();calls.push({path:pathname,body});if(pathname.endsWith('/notes'))return Response.json({context:context(a)});return Response.json({context:context(b)});}});
 let journal=new Journal(path),queue=new SemanticMetadataQueue({jobs:journal.semantic,http:ky.create({prefixUrl:server.url.href,retry:0}),provider:{respond:async()=>{modelCalls++;throw new TypeError('No fresh source means no inference');}}});
 try{
  const job={runId:run,taskId:task,state};journal.semantic.enqueue(job);await queue.process();await queue.process(Number.MAX_SAFE_INTEGER);
  expect(calls.filter(call=>call.path.endsWith('/notes')).map(call=>call.body)).toEqual([state.mutation]);expect(modelCalls).toBe(0);
  const inspect=new Database(path);try{const row=z.object({payload:z.string(),retry_at:z.number()}).parse(inspect.query('SELECT payload,retry_at FROM semantic_metadata_jobs').get());expect(row.retry_at).toBe(-1);const pending=z.object({state:z.object({pending:z.array(z.uuid()),mutation:z.unknown().optional(),fresh_sources:z.unknown().optional()})}).parse(JSON.parse(row.payload));expect(pending.state.pending).toEqual([b]);expect(pending.state.mutation).toBeUndefined();expect(pending.state.fresh_sources).toBeUndefined();}finally{inspect.close();}
  await queue.stop();journal.close();journal=new Journal(path);queue=new SemanticMetadataQueue({jobs:journal.semantic,http:ky.create({prefixUrl:server.url.href,retry:0}),provider:{respond:async()=>{modelCalls++;throw new TypeError('No legacy replay inference');}}});
  journal.semantic.enqueue(job);await queue.process(Number.MAX_SAFE_INTEGER);expect(calls).toHaveLength(2);expect(modelCalls).toBe(0);expect(journal.semantic.next(Number.MAX_SAFE_INTEGER)).toBeNull();
 }finally{await queue.stop();journal.close();await server.stop(true);await rm(directory,{recursive:true,force:true});}
});
