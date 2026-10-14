import { beforeEach, expect, test } from 'bun:test';
import { z } from 'zod';
import { DaemonPoll } from '../packages/protocol';
import { controlFixture } from './control-fixture';
import { createBackgroundTask } from '../services/control/repository/common';
import { composingState, replyHandoffState, updateComposing } from '../services/control/repository/composing';
import { applyEvent } from '../services/control/repository/daemon-events';
import { quarantineStaleRuns } from '../services/control/repository/recovery';
import { screenUpgrade, currentScreenSession } from '../services/control/screen-upgrade';
import { createDatabase } from '../services/control/db';
import { drainOptions } from '../scripts/drain-runs';
import { DrainReport } from '../services/control/repository/draining';
import { lockWorkspace } from '../services/control/repository/lock-order';

const f=controlFixture(),principal={workspace_id:f.workspace,vm_id:f.vm,role:'vm' as const};
beforeEach(async()=>{await f.finishActive();await f.sql`UPDATE assistant.commands SET status='failed' WHERE vm_id=${f.vm} AND status='pending'`;await f.sql`UPDATE assistant.vms SET daemon_session_id=NULL,daemon_reconciled=false,control_state='agent' WHERE id=${f.vm}`;});
async function assigned(){const source=await f.newTask();const run=DaemonPoll.parse(await(await f.request('/v1/daemon/poll',f.machine)).json()).assignment;if(!run)throw new Error('No assignment');return {source,run};}

test('P1-3 stale recovery and a VM-first event transaction cannot deadlock',async()=>{
  const {run}=await assigned();await f.sql`UPDATE assistant.vms SET last_seen_at=now()-interval '10 minutes' WHERE id=${f.vm}`;
  const url=new URL(process.env['TEST_DATABASE_URL']??'postgres://assistant:assistant@127.0.0.1:55439/par_dev');
  const name=`review-sweep-${crypto.randomUUID()}`;url.searchParams.set('application_name',name);const sweepSql=createDatabase(url.href);
  let sweep:Promise<number>|undefined,finished=false;
  try{
    const event=f.sql.begin(async tx=>{
      await lockWorkspace(tx,f.workspace);
      await tx`SELECT id FROM assistant.vms WHERE id=${f.vm} FOR UPDATE`;
      const holder=z.object({pid:z.number()}).parse((await tx`SELECT pg_backend_pid() AS pid`)[0]).pid;
      sweep=quarantineStaleRuns(sweepSql,30);void sweep.then(()=>{finished=true;},()=>{finished=true;});
      let contended=false;
      // Recovery scans the whole database, including earlier test fixtures. Give
      // that work a bounded budget instead of requiring completion within 500ms.
      for(let attempt=0;attempt<500&&!finished;attempt++){
        const blocked=await f.sql`SELECT pid FROM pg_stat_activity WHERE application_name=${name} AND wait_event_type='Lock' AND ${holder}=ANY(pg_blocking_pids(pid))`;
        if(blocked.length){contended=true;break;}await Bun.sleep(10);
      }
      // The sweep must either skip this locked VM and finish, or reach the old
      // run→VM lock wait. It may not silently run only after the event completes.
      expect(finished||contended).toBe(true);
      await applyEvent(tx,principal,{kind:'heartbeat',event_id:crypto.randomUUID(),run_id:run.run_id});
    });
    const eventResult=await Promise.allSettled([event]);const sweepResult=await Promise.allSettled(sweep?[sweep]:[]);
    expect([...eventResult,...sweepResult].filter(result=>result.status==='rejected')).toEqual([]);
    expect((await f.sql`SELECT state FROM assistant.runs WHERE id=${run.run_id}`)[0]?.['state']).toBe('running');
  }finally{await sweepSql.end();}
},10000);

for(const lane of ['foreground','background'] as const)test(`P1-3 ${lane} terminal transitions do not take a VM capacity lock`,async()=>{
  const conversation=await f.newConversation();
  const source=lane==='foreground'?(await f.newTask()).task:(await f.sql.begin(tx=>createBackgroundTask(tx,{workspace:f.workspace,conversation:conversation.id,objective:'Capacity fixture',origin:'schedule',clientId:crypto.randomUUID()}))).task;
  const run=DaemonPoll.parse(await(await f.request('/v1/daemon/poll',f.machine)).json()).assignment;if(!run)throw new Error('No assignment');
  const locked=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
  const holder=f.sql.begin(async tx=>{await tx`SELECT id FROM assistant.vms WHERE id=${f.vm} FOR UPDATE`;locked.resolve();await release.promise;});
  await locked.promise;const update=f.sql`UPDATE assistant.runs SET state='unknown' WHERE id=${run.run_id}`;
  let nonblocking=false;
  try{nonblocking=await Promise.race([Promise.resolve(update).then(()=>true),Bun.sleep(100).then(()=>false)]);}
  finally{release.resolve();await holder;await update;}
  expect(nonblocking).toBe(true);expect(source.id).toBe(run.task.id);
});

test('P1-3 background entering active capacity waits for the VM lock',async()=>{
  const conversation=await f.newConversation(),bg=await f.sql.begin(tx=>createBackgroundTask(tx,{workspace:f.workspace,conversation:conversation.id,objective:'Reserve capacity',origin:'schedule',clientId:crypto.randomUUID()}));
  const run=z.object({id:z.uuid()}).parse((await f.sql`INSERT INTO assistant.runs(workspace_id,task_id,vm_id,state) VALUES(${f.workspace},${bg.task.id},${f.vm},'unknown') RETURNING id`)[0]);
  const locked=Promise.withResolvers<number>(),release=Promise.withResolvers<void>();
  const holder=f.sql.begin(async tx=>{await tx`SELECT id FROM assistant.vms WHERE id=${f.vm} FOR UPDATE`;locked.resolve(z.object({pid:z.number()}).parse((await tx`SELECT pg_backend_pid() AS pid`)[0]).pid);await release.promise;});
  const pid=await locked.promise;const entering=Promise.resolve(f.sql`UPDATE assistant.runs SET state='running' WHERE id=${run.id}`);let observed=false;
  try{
    for(let attempt=0;attempt<50;attempt++){
      if((await f.sql`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND ${pid}=ANY(pg_blocking_pids(pid))`).length){observed=true;break;}await Bun.sleep(10);
    }
    expect(observed).toBe(true);
  }finally{release.resolve();await holder;await entering;}
});

test('P2-1 a background stop does not suppress foreground composing or reply handoff',async()=>{
  const {source,run}=await assigned();const bg=await f.sql.begin(tx=>createBackgroundTask(tx,{workspace:f.workspace,conversation:source.task.conversation_id,objective:'Stopped background',origin:'schedule',clientId:crypto.randomUUID()}));
  await f.sql`INSERT INTO assistant.commands(workspace_id,vm_id,task_id,kind) VALUES(${f.workspace},${f.vm},${bg.task.id},'stop')`;
  await f.sql.begin(tx=>applyEvent(tx,principal,{kind:'input_applied',event_id:crypto.randomUUID(),run_id:run.run_id,message_id:source.message.id}));
  const inference=crypto.randomUUID();const begun=await f.sql.begin(tx=>updateComposing(tx,principal,{kind:'begin',run_id:run.run_id,inference_id:inference,input_message_ids:[source.message.id]}));
  if(!('generation' in begun))throw new Error('Missing generation');
  const progress={kind:'update' as const,run_id:run.run_id,inference_id:inference,generation:begun.generation,sequence:1,status:'composing' as const,response_id:'response',item_id:'reply',occurred_at:new Date().toISOString()};
  await f.sql.begin(tx=>updateComposing(tx,principal,progress));expect(await composingState(f.sql,f.workspace,source.task.conversation_id)).not.toBeNull();
  await f.sql.begin(tx=>updateComposing(tx,principal,{...progress,sequence:2,status:'settling'}));expect(await replyHandoffState(f.sql,f.workspace,source.task.conversation_id)).not.toBeNull();
});

test('P2-3 the Worker screen-upgrade path rejects stale daemon sessions before forwarding',async()=>{
  const current=crypto.randomUUID();await f.sql`UPDATE assistant.vms SET daemon_session_id=${current},daemon_reconciled=true WHERE id=${f.vm}`;
  let forwarded=0;const forward=async()=>{forwarded++;return new Response('Forwarded');};
  const request=(token:string,session?:string)=>new Request(`http://localhost/v1/vms/${f.vm}/screen`,{headers:{authorization:`Bearer ${token}`,Upgrade:'websocket',...(session?{'x-daemon-session':session}:{})}});
  await expect(screenUpgrade(f.sql,request(f.machine,crypto.randomUUID()),f.vm,forward)).rejects.toMatchObject({code:'stale_session'});expect(forwarded).toBe(0);
  expect((await screenUpgrade(f.sql,request(f.machine,current),f.vm,forward)).status).toBe(200);
  expect((await screenUpgrade(f.sql,request(f.client),f.vm,forward)).status).toBe(200);
});

test('P2-3 hibernated screen peers and legacy sockets become unauthorized when their session is fenced',async()=>{
  expect(await currentScreenSession(f.sql,f.workspace,f.vm,null)).toBe(true);
  const old=crypto.randomUUID(),current=crypto.randomUUID();await f.sql`UPDATE assistant.vms SET daemon_session_id=${old} WHERE id=${f.vm}`;
  expect(await currentScreenSession(f.sql,f.workspace,f.vm,old)).toBe(true);expect(await currentScreenSession(f.sql,f.workspace,f.vm,null)).toBe(false);
  await f.sql`UPDATE assistant.vms SET daemon_session_id=${current} WHERE id=${f.vm}`;
  expect(await currentScreenSession(f.sql,f.workspace,f.vm,old)).toBe(false);expect(await currentScreenSession(f.sql,f.workspace,f.vm,current)).toBe(true);
});

test('draining prevents new offers while allowing an existing offer ACK and active-run context',async()=>{
  const session=crypto.randomUUID(),headers={authorization:`Bearer ${f.machine}`,'content-type':'application/json','x-daemon-session':session};
  expect((await f.app.request('/v1/daemon/session',{method:'POST',headers,body:JSON.stringify({session_id:session,runs:[]})})).status).toBe(200);
  const source=await f.newTask(),run=DaemonPoll.parse(await(await f.app.request('/v1/daemon/poll?view=work',{headers})).json()).assignment;if(!run)throw new Error('Missing offer');
  await f.sql`UPDATE assistant.vms SET admission_paused=true WHERE id=${f.vm}`;
  try{
    expect((await f.app.request(`/v1/daemon/accept/${run.run_id}`,{method:'POST',headers,body:'{}'})).status).toBe(200);
    expect((await f.app.request(`/v1/daemon/context/${run.run_id}?view=work`,{headers})).status).toBe(200);
    await f.sql.begin(tx=>createBackgroundTask(tx,{workspace:f.workspace,conversation:source.task.conversation_id,objective:'Paused new reservation',origin:'schedule',clientId:crypto.randomUUID()}));
    expect(DaemonPoll.parse(await(await f.app.request('/v1/daemon/poll?view=work',{headers})).json()).assignment).toBeNull();
    expect((await f.app.request(`/v1/daemon/resume/${run.run_id}`,{method:'POST',headers,body:JSON.stringify({desktop_control_scoped:true})})).status).toBe(200);
  }
  finally{await f.sql`UPDATE assistant.vms SET admission_paused=false WHERE id=${f.vm}`;}
});

test('rollout helper reports active runs and pending commands, pauses admission, and never stops existing work',async()=>{
  const {source,run}=await assigned();
  const bg=await f.sql.begin(tx=>createBackgroundTask(tx,{workspace:f.workspace,conversation:source.task.conversation_id,objective:'Drain queued background',origin:'schedule',clientId:crypto.randomUUID()}));
  await f.sql`INSERT INTO assistant.commands(workspace_id,vm_id,task_id,kind) VALUES(${f.workspace},${f.vm},${bg.task.id},'stop')`;
  const invoke=async(flag?:string)=>{
    const child=Bun.spawn(['bun','scripts/drain-runs.ts','--vm',f.vm,...(flag?[flag]:[])],{cwd:'/tmp/agent-par',env:{...process.env,DATABASE_URL:process.env['TEST_DATABASE_URL']??'postgres://assistant:assistant@127.0.0.1:55439/par_dev'},stdout:'pipe',stderr:'pipe'});
    const [exit,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    if(exit!==0)throw new Error(`Drain helper failed: ${stderr}`);
    expect(exit).toBe(0);return z.object({action:z.string(),ready:z.boolean(),vms:DrainReport}).parse(JSON.parse(stdout));
  };
  try{
    const report=await invoke('--pause');expect(report.ready).toBe(false);expect(report.vms).toMatchObject([{vm_id:f.vm,admission_paused:true,active_runs:[{id:run.run_id}],pending_commands:[{kind:'stop',task_id:bg.task.id}]}]);
    expect((await f.request(`/v1/daemon/context/${run.run_id}?view=work`,f.machine)).status).toBe(200);
    await expect((async()=>{await f.sql`INSERT INTO assistant.runs(workspace_id,task_id,vm_id) VALUES(${f.workspace},${bg.task.id},${f.vm})`;})()).rejects.toMatchObject({code:'55000'});
    await f.sql`UPDATE assistant.commands SET status='failed' WHERE vm_id=${f.vm} AND status='pending'`;
    expect(DaemonPoll.parse(await(await f.request('/v1/daemon/poll',f.machine)).json()).assignment).toBeNull();
    await f.finishActive();expect((await invoke()).ready).toBe(true);
    const unpaused=await invoke('--unpause');expect(unpaused.vms[0]?.admission_paused).toBe(false);
  }finally{await f.sql`UPDATE assistant.vms SET admission_paused=false WHERE id=${f.vm}`;}
});

test('pre-059 draining bootstrap is compatible with an old serial poll INSERT',async()=>{
  await f.sql`DROP TRIGGER a_run_admission_pause ON assistant.runs`;await f.sql`ALTER TABLE assistant.vms DROP COLUMN admission_paused`;
  const {pauseAdmission,reportDraining}=await import('../services/control/repository/draining');
  try{
    await pauseAdmission(f.sql,true,f.vm);expect((await reportDraining(f.sql,f.vm))[0]?.admission_paused).toBe(true);
    const source=await f.newTask();await expect((async()=>{await f.sql`INSERT INTO assistant.runs(workspace_id,task_id,vm_id) VALUES(${f.workspace},${source.task.id},${f.vm})`;})()).rejects.toMatchObject({code:'55000'});
  }finally{await pauseAdmission(f.sql,false,f.vm);}
});

test('drain CLI defaults to reports and requires explicit mutation scope',()=>{
  expect(drainOptions([])).toEqual({vm:undefined,action:'report'});
  expect(()=>drainOptions(['--pause'])).toThrow('require');expect(()=>drainOptions(['--pause','--unpause','--all'])).toThrow('only one');
  expect(()=>drainOptions(['--vm','not-a-uuid'])).toThrow();expect(()=>drainOptions(['--all','--vm',f.vm])).toThrow('Choose --vm');
});
