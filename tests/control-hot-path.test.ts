import { beforeEach, expect, test } from 'bun:test';
import { z } from 'zod';
import type { Database, Query, Transaction } from '../services/control/db';
import { createApp } from '../services/control/app';
import { DaemonPoll } from '../packages/protocol';
import { registerSession } from '../services/control/repository/daemon-session';
import { createBackgroundTask } from '../services/control/repository/common';
import { controlFixture } from './control-fixture';
import { daemonProfile } from '../services/control/daemon-profile';

const f=controlFixture();let session:string;
const headers=()=>({authorization:`Bearer ${f.machine}`,'x-daemon-session':session,'content-type':'application/json'});
beforeEach(async()=>{
  await f.finishActive();await f.sql`UPDATE assistant.commands SET status='failed' WHERE vm_id=${f.vm} AND status='pending'`;
  await f.sql`UPDATE assistant.vms SET control_state='agent',admission_paused=false WHERE id=${f.vm}`;
  session=crypto.randomUUID();await f.sql.begin(tx=>registerSession(tx,{workspace_id:f.workspace,vm_id:f.vm,role:'vm'},{session_id:session,runs:[]}));
});
async function pair(){
  const source=await f.newTask();await f.sql.begin(tx=>createBackgroundTask(tx,{workspace:f.workspace,conversation:source.task.conversation_id,objective:'Background',origin:'schedule',clientId:crypto.randomUUID()}));
  const offer=async()=>{const run=DaemonPoll.parse(await(await f.app.request('/v1/daemon/poll?view=work',{headers:headers()})).json()).assignment;if(!run)throw new Error('Missing offer');expect((await f.app.request(`/v1/daemon/accept/${run.run_id}`,{method:'POST',headers:headers(),body:'{}'})).status).toBe(200);return run;};
  return {source,fg:await offer(),bg:await offer()};
}
function traced(sql:Database,hold?:(query:string)=>boolean){
  const statements:string[]=[],entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let begins=0,held=false;
  const observe=<T extends Query>(target:T,seen:string[]=[]):T=>new Proxy(target,{apply(query,self,args){
    if(Array.isArray(args[0])&&'raw' in args[0]){const text=args[0].join(' ').replace(/\s+/g,' ').trim();statements.push(text);seen.push(text);}
    return Reflect.apply(query,self,args);
  }});
  const database=new Proxy(observe(sql),{get(target,key){
    if(key!=='begin')return Reflect.get(target,key,target);
    return (first:unknown,second?:unknown)=>{
      begins++;const callback=typeof first==='function'?first:second;if(typeof callback!=='function')throw new TypeError('Expected callback');
      const work=async(tx:Transaction)=>{
        const seen:string[]=[],value:unknown=await Reflect.apply(callback,undefined,[observe(tx,seen)]);
        if(!held&&hold&&seen.some(hold)){held=true;entered.resolve();await release.promise;}
        return value;
      };
      return typeof first==='string'?sql.begin(first,work):sql.begin(work);
    };
  }});
  return {database,statements,entered:entered.promise,release:()=>release.resolve(),begins:()=>begins};
}
async function prompt<T>(operation:Promise<T>|T){return Promise.race([Promise.resolve(operation).then(value=>({value})),Bun.sleep(450).then(()=>null)]);}

test('held daemon mailbox read does not block user append or client takeover in the same workspace',async()=>{
  const {source,fg}=await pair(),trace=traced(f.sql,query=>query.includes('assistant.messages')),app=createApp(trace.database);
  const reading=app.request(`/v1/daemon/context/${fg.run_id}?view=work_mailbox`,{headers:headers()});await trace.entered;
  const started=performance.now(),clientHeaders={authorization:`Bearer ${f.client}`,'content-type':'application/json'};
  const append=app.request(`/v1/conversations/${source.task.conversation_id}/messages`,{method:'POST',headers:clientHeaders,body:JSON.stringify({client_message_id:crypto.randomUUID(),content:'Live input'})}),takeover=app.request(`/v1/vms/${f.vm}/control`,{method:'POST',headers:clientHeaders,body:'{"kind":"takeover"}'});
  try{const result=await prompt(Promise.all([append,takeover]));expect(result).not.toBeNull();expect(performance.now()-started).toBeLessThan(500);if(result)expect(result.value.map(response=>response.status)).toEqual([200,200]);}
  finally{trace.release();await reading;await Promise.all([append,takeover]);}
});

test('foreground/background events and composing proceed while the other run mailbox is held',async()=>{
  const {source,fg,bg}=await pair(),trace=traced(f.sql,query=>query.includes('assistant.messages')),app=createApp(trace.database);
  const reading=app.request(`/v1/daemon/context/${bg.run_id}?view=work_mailbox`,{headers:headers()});await trace.entered;
  const started=performance.now(),send=(body:object)=>app.request('/v1/daemon/events',{method:'POST',headers:headers(),body:JSON.stringify(body)});
  const events=Promise.all([
    send({kind:'message',event_id:crypto.randomUUID(),run_id:fg.run_id,content:'FG progress',phase:'commentary'}),
    send({kind:'message',event_id:crypto.randomUUID(),run_id:bg.run_id,content:'BG progress',phase:'commentary'}),
    app.request('/v1/daemon/composing',{method:'POST',headers:headers(),body:JSON.stringify({kind:'begin',run_id:fg.run_id,inference_id:crypto.randomUUID(),input_message_ids:[source.message.id]})}),
  ]);
  try{const result=await prompt(events);expect(result).not.toBeNull();expect(performance.now()-started).toBeLessThan(500);if(result)expect(result.value.map(response=>response.status)).toEqual([200,200,200]);}
  finally{trace.release();await reading;await events;}
});

test('poll updates heartbeat and delivers commands while another run event transaction is held',async()=>{
  const {source,bg}=await pair();const stop=await f.request(`/v1/tasks/${source.task.id}/stop`,f.client,{});expect(stop.status).toBe(200);
  const command=z.object({command:z.object({id:z.uuid()})}).parse(await stop.json()).command.id;
  await f.sql`UPDATE assistant.vms SET last_seen_at=now()-interval '10 minutes' WHERE id=${f.vm}`;
  const trace=traced(f.sql,query=>query.startsWith('INSERT INTO assistant.events')),app=createApp(trace.database);
  const event=app.request('/v1/daemon/events',{method:'POST',headers:headers(),body:JSON.stringify({kind:'message',event_id:crypto.randomUUID(),run_id:bg.run_id,content:'Held event',phase:'commentary'})});await trace.entered;
  const started=performance.now(),polling=app.request('/v1/daemon/poll?view=commands',{headers:headers()});
  try{
    const result=await prompt(polling);expect(result).not.toBeNull();expect(performance.now()-started).toBeLessThan(500);if(result){const poll=DaemonPoll.parse(await result.value.json());expect(poll.commands.map(item=>item.id)).toContain(command);}
    expect((await f.sql`SELECT last_seen_at>now()-interval '5 seconds' AS fresh FROM assistant.vms WHERE id=${f.vm}`)[0]?.['fresh']).toBe(true);
  }finally{trace.release();await event;await polling;}
});

test('guarded mailbox payload uses one SQL statement without workspace UPDATE or VM/run writer locks',async()=>{
  const {fg}=await pair(),trace=traced(f.sql),app=createApp(trace.database);
  const response=await app.request(`/v1/daemon/context/${fg.run_id}?view=work_mailbox`,{headers:headers()});expect(response.status).toBe(200);
  const payload=trace.statements.filter(query=>!query.includes('assistant.credentials'));
  console.info(JSON.stringify({scenario:'mailbox_statement_count',statements:trace.statements.length,after_auth:payload.length,transactions:trace.begins(),queries:payload}));
  expect(payload).toHaveLength(1);expect(trace.statements).toHaveLength(2);expect(trace.begins()).toBe(2);
  expect(trace.statements.some(query=>/workspaces.*FOR UPDATE/.test(query))).toBe(false);
  expect(trace.statements.some(query=>/vms.*FOR (UPDATE|SHARE)|runs.*FOR UPDATE/.test(query))).toBe(false);
});

test('web client REST auth stays non-transactional',async()=>{
  const trace=traced(f.sql),app=createApp(trace.database);
  expect((await app.request('/v1/session',{headers:{authorization:`Bearer ${f.client}`}})).status).toBe(200);
  expect(trace.begins()).toBe(0);expect(trace.statements).toHaveLength(1);
});

test('composing requests its VM writer mode up front, never SHARE then UPDATE',async()=>{
  const {source,fg}=await pair(),trace=traced(f.sql),app=createApp(trace.database);
  expect((await app.request('/v1/daemon/composing',{method:'POST',headers:headers(),body:JSON.stringify({kind:'begin',run_id:fg.run_id,inference_id:crypto.randomUUID(),input_message_ids:[source.message.id]})})).status).toBe(200);
  const locks=trace.statements.filter(query=>query.includes('assistant.vms')&&/FOR (SHARE|KEY SHARE|UPDATE|NO KEY UPDATE)/.test(query));
  console.info(JSON.stringify({scenario:'composing_vm_modes',locks}));
  expect(locks.some(query=>/FOR SHARE$/.test(query))).toBe(false);
  expect(locks[0]).toMatch(/FOR (NO KEY )?UPDATE$/);
});

test('profiles cover the actual writer routes before their callbacks acquire locks',()=>{
  const id=crypto.randomUUID();
  for(const path of [`/v1/daemon/resume/${id}`,`/v1/daemon/accept/${id}`,'/v1/daemon/computer-control','/v1/daemon/schedules','/v1/daemon/extensions/skills'])
    expect(daemonProfile('POST',path,{}).vmLock).toBe('update');
  expect(daemonProfile('POST','/v1/daemon/composing',{}).vmLock).toBe('no-key-update');
  expect(daemonProfile('POST','/v1/daemon/events',{kind:'command_ack'}).vmLock).toBe('update');
  expect(daemonProfile('POST','/v1/daemon/events',{kind:'message'})).toMatchObject({workspaceLock:'share',vmLock:'key-share'});
});
