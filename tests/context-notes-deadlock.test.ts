import { afterAll, expect, test } from 'bun:test';
import { z } from 'zod';
import { Hono } from 'hono';
import type { AppEnv } from '../services/control/auth';
import { semanticContextRoutes } from '../services/control/routes/semantic-context';
import { NotesResult } from '../packages/context/schema';
import { DaemonEvent } from '../packages/protocol';
import { applyEvent } from '../services/control/repository/daemon-events';
import { createDatabase, type Database, type Transaction } from '../services/control/db';
import type { Principal } from '../services/control/auth';
import { prepareSemanticContext, linkContext, writeContextNotes } from '../packages/context/store';
import { persistExtraction } from '../packages/memory/persist';
import { inputHash } from '../packages/memory/schema';
import { retentionContext } from '../packages/memory/retention-store';

const sql=createDatabase(process.env['TEST_DATABASE_URL']??'postgres://assistant:assistant@127.0.0.1:55439/semantic_context_1006');
afterAll(()=>sql.end());
function observedDatabase(hook:(text:string)=>Promise<void>,started:PromiseWithResolvers<number>):Database {
  return new Proxy(sql,{get(target,key,receiver){
    if(key!=='begin')return Reflect.get(target,key,receiver);
    return <T>(callback:(tx:Transaction)=>Promise<T>)=>target.begin(async tx=>{
      await tx`SET LOCAL deadlock_timeout='100ms'`;
      await tx`SET LOCAL statement_timeout='5s'`;
      started.resolve(z.object({pid:z.number()}).parse((await tx`SELECT pg_backend_pid() AS pid`)[0]).pid);
      return callback(new Proxy(tx,{apply(query,thisArg,args:unknown[]){
        const fragments=args[0];
        if(!Array.isArray(fragments)||typeof fragments[0]!=='string'||!fragments[0].startsWith('SELECT id FROM assistant.workspaces'))return Reflect.apply(query,thisArg,args);
        return Promise.resolve(Reflect.apply(query,thisArg,args)).then(async result=>{await hook(fragments.join('?'));return result;});
      }}));
    });
  }});
}
async function waitForBlock(waiting:number,holding:number) {
  for(let attempt=0;attempt<400;attempt++) {
    const row=z.object({blocked:z.boolean()}).parse((await sql`SELECT ${holding}::int=ANY(pg_blocking_pids(${waiting}::int)) AS blocked`)[0]);
    if(row.blocked)return;
    await Bun.sleep(5);
  }
  throw new Error('Expected PostgreSQL lock barrier was not reached');
}

for(const transport of ['store','http','event'] as const)test(`${transport}: notes and memory extraction finish when the workspace receipt FK overlaps the conversation lock`,async()=>{
  const workspace=crypto.randomUUID(),conversation=crypto.randomUUID(),vm=crypto.randomUUID(),task=crypto.randomUUID(),run=crypto.randomUUID(),message=crypto.randomUUID();
  await sql`INSERT INTO assistant.workspaces(id,name) VALUES(${workspace},'notes deadlock fixture')`;
  await sql`INSERT INTO assistant.conversations(id,workspace_id,title) VALUES(${conversation},${workspace},'fixture')`;
  await sql`INSERT INTO assistant.vms(id,workspace_id,name) VALUES(${vm},${workspace},'fixture')`;
  await sql`INSERT INTO assistant.tasks(id,workspace_id,conversation_id,objective,state) VALUES(${task},${workspace},${conversation},'fixture','running')`;
  await sql`INSERT INTO assistant.runs(id,workspace_id,task_id,vm_id) VALUES(${run},${workspace},${task},${vm})`;
  await sql`INSERT INTO assistant.messages(id,workspace_id,conversation_id,task_id,role,content) VALUES(${message},${workspace},${conversation},${task},'user','Shipping choice is sea freight')`;
  await sql`INSERT INTO assistant.memory_retention_decisions(workspace_id,task_id,source_message_id,action) VALUES(${workspace},${task},${message},'inherit')`;
  const principal:Principal={workspace_id:workspace,role:'vm',vm_id:vm};
  const prepared=await prepareSemanticContext(sql,principal,run,{message_id:message});
  const linked=await linkContext(sql,principal,run,{operation_id:crypto.randomUUID(),message_id:message,source_sha256:prepared.source.sha256,expected_link_revision:0,choice:{kind:'new',title:'Shipping',scope:'Shipping decision'},status:'confirmed',evidence:[{message_id:message,quote:prepared.source.content}]});
  const retention=await retentionContext(sql,{workspace,task}),hash=await inputHash(retention.sources);
  const held=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),memoryPid=Promise.withResolvers<number>(),notesPid=Promise.withResolvers<number>();
  const memoryDb=observedDatabase(async text=>{if(text.includes('assistant.workspaces')&&text.includes('FOR UPDATE')){held.resolve();await release.promise;}},memoryPid);
  const notesDb=observedDatabase(async()=>{},notesPid);
  const memory=persistExtraction(memoryDb,principal,{run_id:run,derivation_id:crypto.randomUUID(),input_hash:hash,source_ids:[message],extraction:{schema_version:1,claims:[]},retention:{input_hash:hash,decisions:retention.decisions}});
  await held.promise;
  const request={operation_id:crypto.randomUUID(),context_id:linked.context.context_id,expected_revision:linked.context.revision,source_message_id:message,source_sha256:prepared.source.sha256,notes:[{id:crypto.randomUUID(),kind:'decision' as const,text:'Ship by sea',evidence:[{message_id:message,quote:prepared.source.content}],supersedes:null,valid_from:null,valid_to:null}]};
  const app=new Hono<AppEnv>();
  app.use('*',async(c,next)=>{c.set('principal',principal);await next();});
  app.route('/',semanticContextRoutes(notesDb));
  const server=transport==='http'?Bun.serve({port:0,hostname:'127.0.0.1',fetch:app.fetch}):null;
  const event=DaemonEvent.parse({kind:'message',event_id:crypto.randomUUID(),run_id:run,message_id:crypto.randomUUID(),content:'Sea freight confirmed',semantic_context_id:linked.context.context_id,semantic_source_message_id:message});
  const notes=transport==='event'?notesDb.begin(tx=>applyEvent(tx,principal,event)):server?fetch(`http://127.0.0.1:${server.port}/context/${run}/semantic/notes`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)}).then(async response=>{
    console.log(JSON.stringify({transport,status:response.status}));
    expect(response.status).toBe(200);return NotesResult.parse(await response.json());
  }):writeContextNotes(notesDb,principal,run,request);
  const settled=Promise.allSettled([memory,notes]);
  try {
    await waitForBlock(await notesPid.promise,await memoryPid.promise);
    const locks=await sql`SELECT a.query,a.wait_event_type,a.wait_event FROM pg_stat_activity a WHERE pid=ANY(${sql.array([await notesPid.promise,await memoryPid.promise])}::int[]) ORDER BY pid`;
    console.log(JSON.stringify({scenario:'notes versus memory extraction',barrier:locks}));
    release.resolve();
    const results=await settled;
    console.log(JSON.stringify({outcomes:results.map(result=>result.status==='fulfilled'?'ok':z.object({code:z.string().optional(),detail:z.string().optional()}).parse(result.reason))}));
    expect(results.map(result=>result.status)).toEqual(['fulfilled','fulfilled']);
    if(transport==='event') {
      await sql.begin(tx=>applyEvent(tx,principal,event));
      const delivered=await sql`SELECT m.id,l.context_id,l.originating_message_id FROM assistant.messages m JOIN assistant.semantic_context_links l ON l.message_id=m.id WHERE m.workspace_id=${workspace} AND m.role='assistant'`;
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toEqual({id:event.kind==='message'?event.message_id:null,context_id:linked.context.context_id,originating_message_id:message});
    } else {
      const replay=await writeContextNotes(sql,principal,run,request);
      expect(replay.context.notes.some(note=>note.id===request.notes[0]?.id)).toBe(true);
      expect(replay.context.revision).toBe(linked.context.revision+1);
    }
  } finally {release.resolve();await settled;server?.stop(true);}
},15000);
