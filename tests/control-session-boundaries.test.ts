import { beforeEach, expect, test } from 'bun:test';
import { z } from 'zod';
import type { Database, Query, Transaction } from '../services/control/db';
import { createDatabase } from '../services/control/db';
import { createApp } from '../services/control/app';
import { DaemonPoll } from '../packages/protocol';
import { registerSession } from '../services/control/repository/daemon-session';
import { enrollSchedule, ScheduleRequest } from '../services/control/repository/schedule-enrollment';
import { quarantineStaleRuns } from '../services/control/repository/recovery';
import { controlFixture } from './control-fixture';
import { PrepareResult } from '../packages/context/schema';
import { inputHash } from '../packages/memory/source';
import { uploadArtifact } from '../packages/artifacts/upload';
import { daemonDatabase, daemonRequest } from '../services/control/daemon-db';

const f=controlFixture();
const principal={workspace_id:f.workspace,vm_id:f.vm,role:'vm' as const};
beforeEach(async()=>{await f.finishActive();await f.sql`UPDATE assistant.commands SET status='failed' WHERE vm_id=${f.vm} AND status='pending'`;await f.sql`UPDATE assistant.vms SET daemon_session_id=NULL,daemon_reconciled=false,admission_paused=false,control_state='agent' WHERE id=${f.vm}`;});
async function assigned(){const source=await f.newTask(),run=DaemonPoll.parse(await(await f.request('/v1/daemon/poll',f.machine)).json()).assignment;if(!run)throw new Error('No run');return {source,run};}

for(const competitor of ['registration','stale-recovery'] as const)test(`P1-A ${competitor} and workspace-first schedule enrollment cannot deadlock`,async()=>{
  const {source,run}=await assigned();await f.sql`UPDATE assistant.vms SET last_seen_at=now()-interval '10 minutes' WHERE id=${f.vm}`;
  const gate=Promise.withResolvers<void>(),entered=Promise.withResolvers<number>();
  const enrolSql=new Proxy(f.sql,{get(target,key){
    if(key!=='begin')return Reflect.get(target,key,target);
    return (callback:(tx:Transaction)=>Promise<unknown>)=>target.begin(async tx=>{
      await tx`SELECT id FROM assistant.workspaces WHERE id=${f.workspace} FOR UPDATE`;
      entered.resolve(z.object({pid:z.number()}).parse((await tx`SELECT pg_backend_pid() AS pid`)[0]).pid);
      await gate.promise;return callback(tx);
    });
  }});
  const input=ScheduleRequest.parse({run_id:run.run_id,client_schedule_id:crypto.randomUUID(),objective:'Enrolled before rotation',due_at:'2070-01-01T00:00:00Z',timezone:'UTC',source_message_id:source.message.id,source_quote:'objective'});
  const enrollment=enrollSchedule(enrolSql,principal,input);const holder=await entered.promise;
  const url=new URL(process.env['TEST_DATABASE_URL']??'postgres://assistant:assistant@127.0.0.1:55439/par_dev');
  const name=`session-boundary-${crypto.randomUUID()}`;url.searchParams.set('application_name',name);const peer=createDatabase(url.href);
  let finished=false;
  const concurrent=competitor==='registration'?peer.begin(tx=>registerSession(tx,principal,{session_id:crypto.randomUUID(),runs:[]})):quarantineStaleRuns(peer,30);
  void concurrent.then(()=>{finished=true;},()=>{finished=true;});
  try{
    let blocked=false;
    for(let attempt=0;attempt<100&&!finished;attempt++){
      if((await f.sql`SELECT pid FROM pg_stat_activity WHERE application_name=${name} AND ${holder}=ANY(pg_blocking_pids(pid))`).length){blocked=true;break;}await Bun.sleep(10);
    }
    expect(finished||blocked).toBe(true);gate.resolve();
    const results=await Promise.allSettled([enrollment,concurrent]);expect(results.filter(result=>result.status==='rejected')).toEqual([]);
    expect(await f.sql`SELECT id FROM assistant.schedules WHERE client_schedule_id=${input.client_schedule_id}`).toHaveLength(1);
  }finally{gate.resolve();await Promise.allSettled([enrollment,concurrent]);await peer.end();}
},10000);

test('P1-C direct artifact finalization revalidates after storage completes across a session rotation',async()=>{
  const old=crypto.randomUUID();await f.sql.begin(tx=>registerSession(tx,principal,{session_id:old,runs:[]}));
  const source=await f.newTask(),headers={authorization:`Bearer ${f.machine}`,'x-daemon-session':old};
  const run=DaemonPoll.parse(await(await f.app.request('/v1/daemon/poll?view=work',{headers})).json()).assignment;if(!run)throw new Error('No offer');
  await f.app.request(`/v1/daemon/accept/${run.run_id}`,{method:'POST',headers,body:'{}'});
  const artifact=crypto.randomUUID();let deleted=false;
  const uploading=uploadArtifact(f.sql,{put:async(_key,body)=>{await new Response(body).arrayBuffer();await f.sql.begin(tx=>registerSession(tx,principal,{session_id:crypto.randomUUID(),runs:[{run_id:run.run_id,phase:'executing',recoverable:true}]}));},get:async()=>null,delete:async()=>{deleted=true;}},{scope:{principal:{...principal,daemon_session_id:old},conversation:source.task.conversation_id,runId:run.run_id},request:new Request('http://localhost/upload',{method:'POST',headers:{'X-Artifact-Id':artifact,'X-Artifact-Name':'proof.txt','Content-Type':'text/plain'},body:'proof'})});
  await expect(uploading).rejects.toMatchObject({code:'stale_session'});
  expect((await f.sql`SELECT state FROM assistant.artifacts WHERE id=${artifact}`)[0]?.['state']).toBe('uploading');expect(deleted).toBe(false);
});

test('P1-C guarded protected readers preserve initial snapshot settings and lazy SQL fragments',async()=>{
  const {run}=await assigned(),sql=daemonDatabase(f.sql);
  const rows=await daemonRequest.run({principal,kind:'mutation',run:run.run_id},()=>sql.begin(async tx=>{
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;
    const unused=tx`FOR UPDATE`;void unused;
    const suffix=tx`ORDER BY id`;
    return tx`SELECT id FROM assistant.runs WHERE id=${run.run_id} ${suffix}`;
  }));
  expect(z.array(z.object({id:z.uuid()})).parse(rows)).toEqual([{id:run.run_id}]);
});

test('P1-C nested direct transaction callbacks fence before issuing their first mutation',async()=>{
  const old=crypto.randomUUID();await f.sql.begin(tx=>registerSession(tx,principal,{session_id:old,runs:[]}));
  const source=await f.newTask(),headers={authorization:`Bearer ${f.machine}`,'x-daemon-session':old};
  const run=DaemonPoll.parse(await(await f.app.request('/v1/daemon/poll',{headers})).json()).assignment;if(!run)throw new Error('Missing offer');
  await f.sql.begin(tx=>registerSession(tx,principal,{session_id:crypto.randomUUID(),runs:[{run_id:run.run_id,phase:'accepted',recoverable:true}]}));
  let mutated=false;const sql=daemonDatabase(f.sql);
  const write=daemonRequest.run({principal:{...principal,daemon_session_id:old},kind:'mutation',run:run.run_id},()=>sql.begin(()=>sql.begin(async tx=>{
    await tx`UPDATE assistant.tasks SET reason='Must not mutate' WHERE id=${source.task.id}`;mutated=true;
  })));
  await expect(write).rejects.toMatchObject({code:'stale_session'});expect(mutated).toBe(false);
});

// Delay the mutation after the real middleware session read. The same adapter
// observes the read whether middleware performs it directly or inside BEGIN.
function delayedMutation(sql:Database){
  let checked=false,paused=false;const reached=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
  const observe=<T extends Query>(query:T):T=>new Proxy(query,{apply(target,self,args){
    const text=Array.isArray(args[0])?args[0].join(' ').replace(/\s+/g,' ').trim():'';
    const result:unknown=Reflect.apply(target,self,args);
    if(text.startsWith('SELECT daemon_session_id,daemon_reconciled')&&!text.includes('FOR UPDATE')&&!text.includes('FOR SHARE'))return Promise.resolve(result).then(rows=>{checked=true;return rows;});
    return result;
  }});
  const database=new Proxy(observe(sql),{get(target,key){
    if(key!=='begin')return Reflect.get(target,key,target);
    return (first:unknown,second?:unknown)=>{
      const callback=typeof first==='function'?first:second;if(typeof callback!=='function')throw new TypeError('Expected transaction callback');
      const work=async(tx:Transaction)=>{
        if(checked&&!paused){paused=true;reached.resolve();await release.promise;}
        const result:unknown=Reflect.apply(callback,undefined,[observe(tx)]);return result;
      };
      return typeof first==='string'?sql.begin(first,work):sql.begin(work);
    };
  }});
  return {database,reached:reached.promise,release:()=>release.resolve(),checked:()=>checked};
}

for(const mutation of ['artifact','responsibility','context'] as const)test(`P1-C delayed old-session ${mutation} mutation is fenced in its own transaction`,async()=>{
  const old=crypto.randomUUID();await f.sql.begin(tx=>registerSession(tx,principal,{session_id:old,runs:[]}));
  const source=await f.newTask(),headers={authorization:`Bearer ${f.machine}`,'x-daemon-session':old,'content-type':'application/json'};
  const run=DaemonPoll.parse(await(await f.app.request('/v1/daemon/poll?view=work',{headers})).json()).assignment;if(!run)throw new Error('No offer');
  expect((await f.app.request(`/v1/daemon/accept/${run.run_id}`,{method:'POST',headers,body:'{}'})).status).toBe(200);
  expect((await f.app.request('/v1/daemon/events',{method:'POST',headers,body:JSON.stringify({kind:'input_applied',event_id:crypto.randomUUID(),run_id:run.run_id,message_id:source.message.id})})).status).toBe(200);
  const delayed=delayedMutation(f.sql);let writes=0;
  const prepared=mutation==='context'?PrepareResult.parse(await(await createApp(f.sql,{semanticContexts:{}}).request(`/v1/daemon/context/${run.run_id}/semantic/prepare`,{method:'POST',headers,body:JSON.stringify({message_id:source.message.id})})).json()):undefined;
  const assessment=prepared?{input_hash:await inputHash(prepared.retention_context.sources),decisions:prepared.retention_context.sources.map(item=>({source_message_id:item.id,action:'inherit',quote:null}))}:undefined;
  const app=createApp(delayed.database,{semanticContexts:{},artifactStore:{put:async(_key,body)=>{writes++;await new Response(body).arrayBuffer();},get:async()=>null,delete:async()=>{return;}}});
  const request=mutation==='artifact'
    ? app.request(`/v1/daemon/conversations/${source.task.conversation_id}/artifacts?run_id=${run.run_id}`,{method:'POST',headers:{...headers,'content-type':'text/plain','X-Artifact-Id':crypto.randomUUID(),'X-Artifact-Name':'proof.txt'},body:'proof'})
    : mutation==='responsibility'
      ? app.request('/v1/daemon/responsibilities',{method:'POST',headers,body:JSON.stringify({run_id:run.run_id,conversation_id:source.task.conversation_id,client_responsibility_id:crypto.randomUUID(),source_message_id:source.message.id,source_quote:'objective',objective:'Delayed responsibility',trigger:{kind:'deadline',due_at:'2070-01-01T00:00:00Z',timezone:'UTC'},notification_mode:'quiet',quiet_hours:null,skill_id:null,skill_revision:null})})
      : app.request(`/v1/daemon/context/${run.run_id}/semantic/retention`,{method:'POST',headers,body:JSON.stringify({message_id:source.message.id,assessment})});
  try{
    await Promise.race([delayed.reached,Promise.resolve(request).then(async response=>{throw new Error(`Mutation never reached its transaction: ${response.status} ${await response.clone().text()}`);})]);expect(delayed.checked()).toBe(true);
    await f.sql.begin(tx=>registerSession(tx,principal,{session_id:crypto.randomUUID(),runs:[{run_id:run.run_id,phase:'executing',recoverable:true}]}));
    delayed.release();const response=await request;expect(response.status).toBe(409);
    expect(z.object({error:z.object({code:z.string()})}).parse(await response.json()).error.code).toBe('stale_session');expect(writes).toBe(0);
  }finally{delayed.release();await request;}
},10000);
