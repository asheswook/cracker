import { beforeEach, expect, test } from 'bun:test';
import { z } from 'zod';
import { Assignment, DaemonPoll } from '../packages/protocol';
import { SessionReconciliation } from '../packages/protocol/parallel-runs';
import { createBackgroundTask } from '../services/control/repository/common';
import { controlFixture } from './control-fixture';

const f=controlFixture();
let session:string;
async function request(path:string,body?:unknown,id=session){
  return f.app.request(`/v1/daemon${path}`,{method:body?'POST':'GET',headers:{authorization:`Bearer ${f.machine}`,'content-type':'application/json','x-daemon-session':id},...(body?{body:JSON.stringify(body)}:{})});
}
async function register(runs:readonly {run_id:string;phase:'accepted'|'executing'|'suspended'|'terminal-pending';recoverable:boolean}[]=[],id=crypto.randomUUID()){
  const response=await request('/session',{session_id:id,runs},id);expect(response.status).toBe(200);session=id;
  return SessionReconciliation.parse(await response.json());
}
async function offer(){const response=await request('/poll?view=work');expect(response.status).toBe(200);return DaemonPoll.parse(await response.json()).assignment;}
async function accept(assignment:Assignment){expect((await request(`/accept/${assignment.run_id}`,{})).status).toBe(200);}
async function background(conversation?:string){const id=conversation??(await f.newConversation()).id;return f.sql.begin(tx=>createBackgroundTask(tx,{workspace:f.workspace,conversation:id,objective:'Background',origin:'schedule',clientId:crypto.randomUUID()}));}
beforeEach(async()=>{await f.finishActive();await f.sql`UPDATE assistant.commands SET status='failed' WHERE vm_id=${f.vm} AND status='pending'`;await register();});

test('fenced admission offers foreground first, overlaps one background, and caps each lane',async()=>{
  const bg=await background(),fg=await f.newTask();await background();await f.newTask();
  const first=await offer();expect(first?.task.id).toBe(fg.task.id);if(!first)throw new Error('No foreground');await accept(first);
  const second=await offer();expect(second?.task.id).toBe(bg.task.id);if(!second)throw new Error('No background');await accept(second);
  expect(await offer()).toBeNull();
  expect(await f.sql`SELECT id FROM assistant.runs WHERE vm_id=${f.vm} AND state='running'`).toHaveLength(2);
  expect((await f.sql`SELECT count(*)::int AS count FROM assistant.runs WHERE vm_id=${f.vm} AND state='running' AND lane='background'`)[0]?.['count']).toBe(1);
});

test('lost assignment response is re-offered with the same run and ACK is idempotent',async()=>{
  await f.newTask();const first=await offer(),again=await offer();expect(again?.run_id).toBe(first?.run_id);expect(first?.offered).toBe(true);
  if(!first)throw new Error('No offer');
  expect(await f.sql`SELECT id FROM assistant.runs WHERE task_id=${first.task.id}`).toHaveLength(1);
  expect((await request('/events',{kind:'message',event_id:crypto.randomUUID(),run_id:first.run_id,content:'Not accepted'})).status).toBe(409);
  await accept(first);await accept(first);
  const accepted=z.object({accepted_at:z.string()}).parse((await f.sql`SELECT accepted_at FROM assistant.runs WHERE id=${first.run_id}`)[0]);
  await accept(first);expect((await f.sql`SELECT accepted_at FROM assistant.runs WHERE id=${first.run_id}`)[0]?.['accepted_at']).toBe(accepted.accepted_at);
  expect(await offer()).toBeNull();
});

test('missing IDs in ordinary polls never quarantine accepted work',async()=>{
  await f.newTask();const run=await offer();if(!run)throw new Error('No offer');await accept(run);
  expect(await offer()).toBeNull();expect((await f.sql`SELECT state FROM assistant.runs WHERE id=${run.run_id}`)[0]?.['state']).toBe('running');
});

test('restart adopts one recoverable run and quarantines only the unsafe run; old session is fenced',async()=>{
  await f.newTask();await background();const fg=await offer();if(!fg)throw new Error('No foreground');await accept(fg);
  const bg=await offer();if(!bg)throw new Error('No background');await accept(bg);const old=session;
  const reconciliation=await register([{run_id:fg.run_id,phase:'suspended',recoverable:true},{run_id:bg.run_id,phase:'executing',recoverable:false}]);
  expect(reconciliation.adopted).toContain(fg.run_id);expect(reconciliation.quarantined).toEqual([bg.run_id]);
  expect((await request('/poll',undefined,old)).status).toBe(409);
  expect((await request('/events',{kind:'state',event_id:crypto.randomUUID(),run_id:fg.run_id,state:'failed',reason:'Stale'},old)).status).toBe(409);
  expect((await request('/session',{session_id:old,runs:[]},old)).status).toBe(409);
  expect((await request(`/resume/${fg.run_id}`,{desktop_control_scoped:true})).status).toBe(200);
});

test('unaccepted offers survive a new session and reserve capacity',async()=>{
  await f.newTask();const first=await offer();await register();expect((await offer())?.run_id).toBe(first?.run_id);
  expect(await f.sql`SELECT id FROM assistant.runs WHERE vm_id=${f.vm} AND state='running'`).toHaveLength(1);
});

test('task stop does not block unrelated background admission; resume uses the same lane cap',async()=>{
  const source=await f.newTask();const fg=await offer();if(!fg)throw new Error('No foreground');await accept(fg);
  const bg=await background();
  expect((await f.request(`/v1/tasks/${source.task.id}/stop`,f.client,{})).status).toBe(200);
  const next=await offer();expect(next?.task.id).toBe(bg.task.id);if(!next)throw new Error('No background');await accept(next);
  const another=await background();const run=z.object({id:z.uuid()}).parse((await f.sql`INSERT INTO assistant.runs(workspace_id,task_id,vm_id,state,daemon_session_id,accepted_at) VALUES(${f.workspace},${another.task.id},${f.vm},'unknown',${session},now()) RETURNING id`)[0]);
  expect((await request(`/resume/${run.id}`,{desktop_control_scoped:true,checkpoint_cursor:0})).status).toBe(409);
});

test('resume overlaps foreground and background in the same conversation',async()=>{
  const source=await f.newTask();const fg=await offer();if(!fg)throw new Error('No foreground');await accept(fg);await background(source.task.conversation_id);
  const bg=await offer();if(!bg)throw new Error('No background');await accept(bg);
  expect((await request(`/resume/${bg.run_id}`,{desktop_control_scoped:true})).status).toBe(200);
});

test('background cap remains one while foreground capacity is free, and foreground still enters',async()=>{
  await background();await background();const bg=await offer();if(!bg)throw new Error('No background');await accept(bg);
  expect(await offer()).toBeNull();const fg=await f.newTask();expect((await offer())?.task.id).toBe(fg.task.id);
});

test('every context view rejects a terminal run retained by an older session',async()=>{
  await f.newTask();const run=await offer();if(!run)throw new Error('No offer');await accept(run);
  await f.sql`UPDATE assistant.runs SET state='succeeded' WHERE id=${run.run_id}`;await f.sql`UPDATE assistant.tasks SET state='succeeded' WHERE id=${run.task.id}`;
  await register();
  for(const view of ['full','mailbox','work','work_mailbox','task_sources'])expect((await request(`/context/${run.run_id}?view=${view}`)).status).toBe(404);
});

test('registration waits for an old transaction and fences a delayed old event after the VM lock',async()=>{
  await f.newTask();const run=await offer();if(!run)throw new Error('No offer');await accept(run);const old=session;
  const locked=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
  const registration=f.sql.begin(async tx=>{
    await tx`SELECT id FROM assistant.vms WHERE id=${f.vm} FOR UPDATE`;locked.resolve();await release.promise;
    const {registerSession}=await import('../services/control/repository/daemon-session');
    return registerSession(tx,{workspace_id:f.workspace,vm_id:f.vm,role:'vm'},{session_id:crypto.randomUUID(),runs:[{run_id:run.run_id,phase:'suspended',recoverable:true}]});
  });
  await locked.promise;
  const stale=request('/events',{kind:'message',event_id:crypto.randomUUID(),run_id:run.run_id,content:'Stale race'},old);
  release.resolve();await registration;expect((await stale).status).toBe(409);
  expect(await f.sql`SELECT id FROM assistant.messages WHERE task_id=${run.task.id} AND content='Stale race'`).toHaveLength(0);
});

test('a stopped unaccepted offer is not re-offered and does not block another lane',async()=>{
  const source=await f.newTask();const first=await offer();if(!first)throw new Error('No offer');
  await f.request(`/v1/tasks/${source.task.id}/stop`,f.client,{});const bg=await background();
  expect((await offer())?.task.id).toBe(bg.task.id);
});
