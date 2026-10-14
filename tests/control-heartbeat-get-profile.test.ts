import { beforeEach, expect, test } from 'bun:test';
import { z } from 'zod';
import type { Query, Transaction } from '../services/control/db';
import { createDatabase } from '../services/control/db';
import { createApp } from '../services/control/app';
import { daemonProfile } from '../services/control/daemon-profile';
import { DaemonPoll } from '../packages/protocol';
import { registerSession } from '../services/control/repository/daemon-session';
import { seal } from '../packages/extensions/secrets';
import { controlFixture } from './control-fixture';

const f=controlFixture();let session:string;
const headers=()=>({authorization:`Bearer ${f.machine}`,'content-type':'application/json','x-daemon-session':session});
beforeEach(async()=>{
  await f.finishActive();await f.sql`UPDATE assistant.commands SET status='failed' WHERE vm_id=${f.vm} AND status='pending'`;
  await f.sql`UPDATE assistant.chatgpt_accounts SET request_status='completed',lease_until=NULL,callback_cipher=NULL WHERE vm_id=${f.vm}`;
  await f.sql`UPDATE assistant.vms SET control_state='agent',admission_paused=false WHERE id=${f.vm}`;
  session=crypto.randomUUID();await f.sql.begin(tx=>registerSession(tx,{workspace_id:f.workspace,vm_id:f.vm,role:'vm'},{session_id:session,runs:[]}));
});
async function assigned(){const source=await f.newTask();const run=DaemonPoll.parse(await(await f.app.request('/v1/daemon/poll?view=work',{headers:headers()})).json()).assignment;if(!run)throw new Error('No offer');expect((await f.app.request(`/v1/daemon/accept/${run.run_id}`,{method:'POST',headers:headers(),body:'{}'})).status).toBe(200);return {source,run};}

test('heartbeat and composing on the same run complete without a VM lock-upgrade deadlock',async()=>{
  const {run}=await assigned(),reached=Promise.withResolvers<number>(),release=Promise.withResolvers<void>(),vmModes:string[]=[];let held=false;
  const instrumented=new Proxy(f.sql,{get(target,key){
    if(key!=='begin')return Reflect.get(target,key,target);
    return (first:unknown,second?:unknown)=>{
      const callback=typeof first==='function'?first:second;if(typeof callback!=='function')throw new TypeError('Expected callback');
      const work=async(tx:Transaction)=>{
        const pid=z.object({pid:z.number()}).parse((await tx`SELECT pg_backend_pid() AS pid`)[0]).pid;
        const observed=new Proxy(tx,{apply(query,self,args){
          const text=Array.isArray(args[0])?args[0].join(' ').replace(/\s+/g,' ').trim():'';
          if(text.includes('assistant.vms')&&/FOR (KEY SHARE|SHARE|UPDATE|NO KEY UPDATE)$/.test(text))vmModes.push(text);
          const result:unknown=Reflect.apply(query,self,args);
          if(!held&&/^SELECT .*assistant\.runs.*FOR UPDATE$/.test(text)&&args.includes(run.run_id)){
            held=true;return Promise.resolve(result).then(async rows=>{reached.resolve(pid);await release.promise;return rows;});
          }
          return result;
        }});
        const result:unknown=Reflect.apply(callback,undefined,[observed]);return result;
      };
      return typeof first==='string'?target.begin(first,work):target.begin(work);
    };
  }});
  const app=createApp(instrumented),eventId=crypto.randomUUID();
  // A query cursor must not suppress parsing body.kind for the upfront mode.
  const heartbeat=app.request(`/v1/daemon/events?run_id=${run.run_id}`,{method:'POST',headers:headers(),body:JSON.stringify({kind:'heartbeat',event_id:eventId,run_id:run.run_id})});
  const holder=await reached.promise;
  const url=new URL(process.env['TEST_DATABASE_URL']??'postgres://assistant:assistant@127.0.0.1:55439/par_dev'),name=`heartbeat-composer-${crypto.randomUUID()}`;url.searchParams.set('application_name',name);
  const peer=createDatabase(url.href),composer=createApp(peer);
  const composing=composer.request('/v1/daemon/composing',{method:'POST',headers:headers(),body:JSON.stringify({kind:'begin',run_id:run.run_id,inference_id:crypto.randomUUID(),input_message_ids:[]})});
  try{
    let blocked=false;
    for(let attempt=0;attempt<100;attempt++){
      if((await f.sql`SELECT pid FROM pg_stat_activity WHERE application_name=${name} AND ${holder}=ANY(pg_blocking_pids(pid))`).length){blocked=true;break;}await Bun.sleep(10);
    }
    expect(blocked).toBe(true);release.resolve();
    const responses=await Promise.all([heartbeat,composing]);expect(responses.map(response=>response.status)).toEqual([200,200]);
    expect(vmModes[0]).toMatch(/FOR NO KEY UPDATE$/);expect(vmModes.some(query=>/FOR (KEY SHARE|SHARE)$/.test(query))).toBe(false);
    expect(await f.sql`SELECT id FROM assistant.events WHERE event_id=${eventId}`).toHaveLength(1);
  }finally{release.resolve();await Promise.all([heartbeat,composing]);await peer.end();}
},10000);

test('heartbeat profile requests its VM NO KEY UPDATE before the run lock; ordinary events stay KEY SHARE',()=>{
  expect(daemonProfile('POST','/v1/daemon/events',{kind:'heartbeat'}).vmLock).toBe('no-key-update');
  for(const kind of ['message','state','input_applied','skill_loaded'])expect(daemonProfile('POST','/v1/daemon/events',{kind}).vmLock).toBe('key-share');
  expect(daemonProfile('POST','/v1/daemon/events',{kind:'command_ack'}).vmLock).toBe('update');
});

test('model-account callback GET is a locking mutation and returns the encrypted bound callback',async()=>{
  const key=btoa('g'.repeat(32)),request=crypto.randomUUID(),callback={state:'fixture-bound-state-123456789',code:'synthetic-code',client_id:'fixture-client'};
  const cipher=await seal({callback:JSON.stringify(callback)},key);
  await f.sql`INSERT INTO assistant.chatgpt_accounts(vm_id,workspace_id,request_id,action,state,request_status,lease_until,login_location,redirect_uri,callback_cipher)
    VALUES(${f.vm},${f.workspace},${request},'connect','connecting','running',now()+interval '7 minutes','local','http://127.0.0.1:43291/auth/callback',${cipher})
    ON CONFLICT(vm_id) DO UPDATE SET request_id=excluded.request_id,action=excluded.action,state=excluded.state,request_status=excluded.request_status,lease_until=excluded.lease_until,login_location=excluded.login_location,redirect_uri=excluded.redirect_uri,callback_cipher=excluded.callback_cipher`;
  const profile=daemonProfile('GET','/v1/daemon/model-account/callback',undefined);
  const response=await createApp(f.sql,{extensionKey:key}).request(`/v1/daemon/model-account/callback?request_id=${request}`,{headers:headers()});
  expect(response.status).toBe(200);expect(await response.json()).toEqual({callback});expect(profile).toMatchObject({kind:'mutation',vmLock:'update'});
  await f.sql`UPDATE assistant.chatgpt_accounts SET request_status='completed',lease_until=NULL,callback_cipher=NULL WHERE vm_id=${f.vm}`;
});

// Explicitly audited mounted GET inventory. Domain errors are listed where a
// resource/lease is deliberately absent; no unexpected 500/25006 is acceptable.
test('every mounted daemon GET route has an exercised or explicitly listed profile',async()=>{
  const {run}=await assigned(),id=crypto.randomUUID(),app=createApp(f.sql,{extensionKey:btoa('g'.repeat(32))});
  const catalog=[
    {route:'/v1/daemon/poll',path:'/v1/daemon/poll?view=commands',kind:'poll',status:200},
    {route:'/v1/daemon/context/:id',path:`/v1/daemon/context/${run.run_id}?view=work_mailbox`,kind:'read',status:200},
    {route:'/v1/daemon/model-settings/runs/:id',path:`/v1/daemon/model-settings/runs/${run.run_id}`,kind:'read',status:200},
    {route:'/v1/daemon/model-settings/current',path:'/v1/daemon/model-settings/current',kind:'read',status:200},
    {route:'/v1/daemon/model-account/callback',path:`/v1/daemon/model-account/callback?request_id=${id}`,kind:'mutation',status:409},
    {route:'/v1/daemon/extensions',path:'/v1/daemon/extensions',kind:'read',status:200},
    {route:'/v1/daemon/extensions/bound/:run',path:`/v1/daemon/extensions/bound/${run.run_id}`,kind:'read',status:404},
    {route:'/v1/daemon/extensions/skills/:id',path:`/v1/daemon/extensions/skills/${id}`,kind:'read',status:404},
    {route:'/v1/daemon/artifact-index/:id/content',path:`/v1/daemon/artifact-index/${id}/content`,kind:'read',status:400},
    {route:'/v1/daemon/artifacts/:id/content',path:`/v1/daemon/artifacts/${id}/content?run_id=${run.run_id}`,kind:'read',status:404},
    {route:'/v1/daemon/responsibilities',path:'/v1/daemon/responsibilities',kind:'mutation',status:200},
  ] as const;
  expect(app.routes.filter(route=>route.method==='GET'&&route.path.startsWith('/v1/daemon/')).map(route=>route.path).sort()).toEqual(catalog.map(entry=>entry.route).sort());
  for(const entry of catalog){
    const url=new URL(entry.path,'http://localhost'),profile=daemonProfile('GET',url.pathname,undefined,url.searchParams.get('view')??undefined);
    expect(profile.kind).toBe(entry.kind);const response=await app.request(entry.path,{headers:headers()});expect(response.status).toBe(entry.status);
  }
  expect((await app.request('/v1/daemon/unmounted-get',{headers:headers()})).status).toBe(404);
});
