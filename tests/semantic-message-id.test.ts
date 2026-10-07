import { z } from 'zod';
import { afterAll, expect, test } from 'bun:test';
import { createDatabase } from '../services/control/db.ts';
import { applyEvent } from '../services/control/repository/daemon-events.ts';
import { DaemonEvent } from '../packages/protocol/index.ts';
import type { Principal } from '../services/control/auth.ts';
const sql=createDatabase(process.env['TEST_DATABASE_URL']??'postgres://assistant:assistant@127.0.0.1:55439/semantic_workspace_1007');
afterAll(()=>sql.end());
async function owner(){
 const workspace=crypto.randomUUID(),vm=crypto.randomUUID(),conversation=crypto.randomUUID(),task=crypto.randomUUID(),run=crypto.randomUUID();
 await sql`INSERT INTO assistant.workspaces(id,name) VALUES(${workspace},'explicit message ID QA')`;
 await sql`INSERT INTO assistant.vms(id,workspace_id,name) VALUES(${vm},${workspace},'fixture')`;
 await sql`INSERT INTO assistant.conversations(id,workspace_id,title) VALUES(${conversation},${workspace},'fixture')`;
 await sql`INSERT INTO assistant.tasks(id,workspace_id,conversation_id,objective,state) VALUES(${task},${workspace},${conversation},'fixture','running')`;
 await sql`INSERT INTO assistant.runs(id,workspace_id,task_id,vm_id,state) VALUES(${run},${workspace},${task},${vm},'running')`;
 const principal:Principal={workspace_id:workspace,vm_id:vm,role:'vm'};return {workspace,vm,conversation,task,run,principal};
}
test('explicit assistant message ID survives a lost event ACK and full-payload idempotency',async()=>{
 const f=await owner(),message_id=crypto.randomUUID(),event=DaemonEvent.parse({kind:'message',event_id:crypto.randomUUID(),message_id,run_id:f.run,content:'Stable assistant message'});
 await sql.begin(tx=>applyEvent(tx,f.principal,event));await sql.begin(tx=>applyEvent(tx,f.principal,event));
 expect(z.array(z.object({id:z.uuid(),conversation_id:z.uuid()})).parse(await sql`SELECT id,conversation_id FROM assistant.messages WHERE workspace_id=${f.workspace}`)).toEqual([{id:message_id,conversation_id:f.conversation}]);
 await expect(sql.begin(tx=>applyEvent(tx,f.principal,DaemonEvent.parse({...event,message_id:crypto.randomUUID()})))).rejects.toMatchObject({code:'idempotency_conflict'});
 expect(await sql`SELECT event_id FROM assistant.events WHERE workspace_id=${f.workspace} AND event_id=${event.event_id}`).toHaveLength(1);
});
test('legacy events keep server-generated IDs and foreign message collisions roll back all changes',async()=>{
 const a=await owner(),b=await owner(),legacy=DaemonEvent.parse({kind:'message',event_id:crypto.randomUUID(),run_id:a.run,content:'Legacy message'});
 await sql.begin(tx=>applyEvent(tx,a.principal,legacy));const original=(await sql`SELECT id,content FROM assistant.messages WHERE workspace_id=${a.workspace}`)[0];if(!original)throw new TypeError('No legacy message');
 const collision=DaemonEvent.parse({kind:'message',event_id:crypto.randomUUID(),message_id:original['id'],run_id:b.run,content:'Must not replace original'});
 await expect(sql.begin(tx=>applyEvent(tx,b.principal,collision))).rejects.toMatchObject({code:'23505'});
 expect([...(await sql`SELECT id,content FROM assistant.messages WHERE workspace_id=${a.workspace}`)]).toEqual([original]);
 expect(await sql`SELECT id FROM assistant.messages WHERE workspace_id=${b.workspace}`).toHaveLength(0);expect(await sql`SELECT event_id FROM assistant.events WHERE event_id=${collision.event_id}`).toHaveLength(0);
});
test('an old SQLite outbox payload is sent unchanged by the upgraded runtime after reopen',async()=>{
 const {mkdtemp,rm}=await import('node:fs/promises'),{join}=await import('node:path'),{tmpdir}=await import('node:os'),{Journal}=await import('../services/daemon/journal.ts'),{Runtime}=await import('../services/daemon/runtime.ts'),{ToolExecutor}=await import('../services/daemon/tools.ts'),{createApp}=await import('../services/control/app.ts'),{hashToken}=await import('../services/control/auth.ts');
 const f=await owner(),directory=await mkdtemp(join(tmpdir(),'old-message-outbox-')),path=join(directory,'journal.sqlite'),token=crypto.randomUUID()+crypto.randomUUID();
 await sql`INSERT INTO assistant.credentials(token_hash,workspace_id,role,vm_id) VALUES(${await hashToken(token)},${f.workspace},'vm',${f.vm})`;
 const legacy=DaemonEvent.parse({kind:'message',event_id:crypto.randomUUID(),run_id:f.run,content:'Old deterministic commentary',phase:'commentary'});
 await sql.begin(tx=>applyEvent(tx,f.principal,legacy));
 const original=new Journal(path);original.enqueue(legacy);original.close();const journal=new Journal(path);journal.enqueue(DaemonEvent.parse({...legacy,message_id:legacy.event_id}));
 const requests:unknown[]=[],app=createApp(sql),server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:async request=>{requests.push(await request.clone().json());return app.fetch(request);}});
 const runtime=new Runtime({controlUrl:server.url.href,token,journal,provider:{respond:async()=>{throw new TypeError('No inference expected');}},tools:new ToolExecutor()});
 try{await runtime.flush();expect(requests).toEqual([legacy]);expect(journal.pending()).toEqual([]);expect(await sql`SELECT id FROM assistant.messages WHERE workspace_id=${f.workspace}`).toHaveLength(1);}
 finally{await runtime.stop();journal.close();await server.stop(true);await rm(directory,{recursive:true,force:true});}
});
