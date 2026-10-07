import { expect, test } from "bun:test";
import { z } from "zod";
import { controlFixture } from "./control-fixture";
import { nextDailyAt } from "../packages/memory/daily-work";
import { ResponsibilityRow } from "../packages/memory/responsibility-store";

const f=controlFixture();
const daily={kind:"daily",hour:12,minute:0,timezone:"Asia/Seoul"} as const;
async function fixture(active=false){
  const task=await f.newTask();
  if(!active)await f.finishActive();
  const response=await f.request('/v1/responsibilities',f.client,{
    client_responsibility_id:crypto.randomUUID(),conversation_id:task.task.conversation_id,vm_id:f.vm,
    source_message_id:task.message.id,source_quote:task.message.content,objective:'Inspect daily source and publish a verified report',trigger:daily,
  });
  expect(response.status).toBe(201);
  return {...task,row:z.object({responsibility:ResponsibilityRow}).parse(await response.json()).responsibility};
}
async function poll(){expect((await f.request('/v1/daemon/responsibilities',f.machine)).status).toBe(200);}

test('daily noon resolves in the declared timezone and advances after the exact boundary',async()=>{
  expect(await nextDailyAt(f.sql,daily,'2026-10-02T02:59:59Z')).toBe('2026-10-02T03:00:00.000Z');
  expect(await nextDailyAt(f.sql,daily,'2026-10-02T03:00:00Z')).toBe('2026-10-03T03:00:00.000Z');
});

test('daily wall clock remains local noon through a daylight saving change',async()=>{
  const trigger={...daily,timezone:'America/New_York'};
  expect(await nextDailyAt(f.sql,trigger,'2026-10-31T15:59:00Z')).toBe('2026-10-31T16:00:00.000Z');
  expect(await nextDailyAt(f.sql,trigger,'2026-10-31T16:01:00Z')).toBe('2026-11-01T17:00:00.000Z');
});

test('a daily occurrence dispatches once across concurrent polls without a model decision',async()=>{
  const {row}=await fixture();
  await f.sql`UPDATE assistant.responsibilities SET next_review_at='2000-01-01T03:00:00Z' WHERE id=${row.id}`;
  await Promise.all([poll(),poll(),poll()]);
  const actions=await f.sql`SELECT a.state,a.task_id,m.role FROM assistant.responsibility_actions a JOIN assistant.messages m ON m.task_id=a.task_id WHERE a.responsibility_id=${row.id}`;
  expect(actions).toHaveLength(1);
  expect(actions[0]?.['state']).toBe('dispatched');
  expect(actions[0]?.['role']).toBe('system');
  expect((await f.sql`SELECT id FROM assistant.responsibility_evaluations WHERE responsibility_id=${row.id}`)).toHaveLength(0);
  const next=z.object({future:z.boolean()}).parse((await f.sql`SELECT next_review_at>now() AS future FROM assistant.responsibilities WHERE id=${row.id}`)[0]);
  expect(next.future).toBe(true);
  await f.finishActive();
});

test('a later daily occurrence runs again even without a new user message',async()=>{
  const {row}=await fixture();
  await f.sql`UPDATE assistant.responsibilities SET next_review_at='2000-01-01T03:00:00Z' WHERE id=${row.id}`;
  await poll();await f.finishActive();
  await f.sql`UPDATE assistant.responsibilities SET next_review_at='2000-01-02T03:00:00Z' WHERE id=${row.id}`;
  await poll();
  const rows=await f.sql`SELECT DISTINCT task_id FROM assistant.responsibility_actions WHERE responsibility_id=${row.id} AND state='dispatched'`;
  expect(rows).toHaveLength(2);
  await f.finishActive();
});

test('daily work waits for active work and survives unrelated conversation updates',async()=>{
  const {row,task}=await fixture(true);
  await f.sql`UPDATE assistant.responsibilities SET next_review_at='2000-01-01T03:00:00Z' WHERE id=${row.id}`;
  await poll();
  expect((await f.sql`SELECT state FROM assistant.responsibility_actions WHERE responsibility_id=${row.id}`)[0]?.['state']).toBe('pending');
  await f.request(`/v1/conversations/${task.conversation_id}/messages`,f.client,{client_message_id:crypto.randomUUID(),content:'A separate research update'});
  await f.finishActive();await poll();
  expect((await f.sql`SELECT state FROM assistant.responsibility_actions WHERE responsibility_id=${row.id}`)[0]?.['state']).toBe('dispatched');
  await f.finishActive();
});

test('updating notification preferences does not move a daily execution earlier',async()=>{
  const {row}=await fixture();
  expect((await f.request(`/v1/responsibilities/${row.id}/settings`,f.client,{notification_mode:'quiet',quiet_hours:null})).status).toBe(200);
  const found=ResponsibilityRow.parse((await f.sql`SELECT * FROM assistant.responsibilities WHERE id=${row.id}`)[0]);
  expect(found.next_review_at).toBe(row.next_review_at);
});

test('schedule correction uses a real user source, preserves identity, and scopes access',async()=>{
  const {row,message}=await fixture();
  const trigger={...daily,hour:9,minute:30};
  const body={trigger,source_message_id:message.id,source_quote:message.content};
  expect((await f.request(`/v1/responsibilities/${row.id}/schedule`,f.alienToken,body,'PUT')).status).toBe(404);
  expect((await f.request(`/v1/responsibilities/${row.id}/schedule`,f.client,{...body,source_quote:'not the source'},'PUT')).status).toBe(400);
  const updated=z.object({responsibility:ResponsibilityRow}).parse(await(await f.request(`/v1/responsibilities/${row.id}/schedule`,f.client,body,'PUT')).json()).responsibility;
  expect(updated.id).toBe(row.id);expect(updated.trigger).toEqual(trigger);
  expect(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(updated.next_review_at))).toBe('09:30');
});

test('a stale periodic failure cannot move a corrected daily execution',async()=>{
  // Given a periodic review already in flight when the user corrects its schedule.
  const {row,message}=await fixture();
  await f.request(`/v1/responsibilities/${row.id}/schedule`,f.client,{trigger:{kind:'periodic',interval_minutes:1440},source_message_id:message.id,source_quote:message.content},'PUT');
  const evaluations=await(await f.request('/v1/daemon/responsibilities',f.machine)).json();
  expect(evaluations.responsibilities.some((item:{id:string})=>item.id===row.id)).toBe(true);
  const corrected=ResponsibilityRow.parse((await(await f.request(`/v1/responsibilities/${row.id}/schedule`,f.client,{trigger:daily,source_message_id:message.id,source_quote:message.content},'PUT')).json()).responsibility);
  // When the old provider request fails after the correction committed.
  const response=await f.request('/v1/daemon/responsibilities/failure',f.machine,{responsibility_id:row.id,error_code:'provider_error'});
  // Then it is acknowledged without introducing a retry outside the daily wall clock.
  expect(response.status).toBe(200);expect(await response.json()).toEqual({retry_scheduled:false});
  const found=ResponsibilityRow.parse((await f.sql`SELECT * FROM assistant.responsibilities WHERE id=${row.id}`)[0]);
  expect(found.next_review_at).toBe(corrected.next_review_at);
  expect((await f.sql`SELECT failure_count,last_error FROM assistant.responsibilities WHERE id=${row.id}`)[0]).toMatchObject({failure_count:0,last_error:null});
});

test('daemon evaluations cannot complete or reschedule daily execution even with current evidence',async()=>{
  // Given a daily responsibility and its actual current evidence hash.
  const {row}=await fixture();
  const {snapshot}=await import('../packages/memory/responsibility-store.ts');
  const current=await snapshot(f.sql,row);
  // When a daemon submits a model decision against that daily responsibility.
  const response=await f.request('/v1/daemon/responsibilities/evaluate',f.machine,{responsibility_id:row.id,context_hash:current.context_hash,evaluation:{outcome:'complete',reason:'fixture stale model decision',notification:null,action_objective:null,next_review_minutes:5}});
  // Then the deterministic schedule remains active and no evaluation is persisted.
  expect(response.status).toBe(409);
  const found=ResponsibilityRow.parse((await f.sql`SELECT * FROM assistant.responsibilities WHERE id=${row.id}`)[0]);
  expect(found.state).toBe('active');expect(found.next_review_at).toBe(row.next_review_at);
  expect(await f.sql`SELECT id FROM assistant.responsibility_evaluations WHERE responsibility_id=${row.id}`).toHaveLength(0);
});

test('daily timezone rejects numeric offsets while accepting UTC',async()=>{
  // Given identifiers supported by Intl but interpreted differently by PostgreSQL.
  const {Trigger}=await import('../packages/memory/responsibility-schema.ts');
  // When daily trigger boundaries parse the timezone.
  const east=Trigger.safeParse({...daily,timezone:'+01:00'}),west=Trigger.safeParse({...daily,timezone:'-05:00'});
  // Then ambiguous offsets cannot enter the scheduler; UTC remains supported.
  expect(east.success).toBe(false);expect(west.success).toBe(false);
  expect(Trigger.parse({...daily,timezone:'UTC'})).toEqual({...daily,timezone:'UTC'});
});

test('daily aliases normalize before scheduling and survive idempotent enrollment round trips',async()=>{
  // Given an alias that Intl maps to a DST-aware IANA zone while PostgreSQL reads as fixed offset.
  const {task,message}=await f.newTask();await f.finishActive();
  const input={client_responsibility_id:crypto.randomUUID(),conversation_id:task.conversation_id,vm_id:f.vm,source_message_id:message.id,source_quote:message.content,objective:'timezone alias fixture',trigger:{...daily,timezone:'CST'}};
  // When enrollment is retried first with its alias and then the canonical equivalent.
  const first=ResponsibilityRow.parse((await(await f.request('/v1/responsibilities',f.client,input)).json()).responsibility);
  const repeated=await f.request('/v1/responsibilities',f.client,input);
  const canonical=await f.request('/v1/responsibilities',f.client,{...input,trigger:{...daily,timezone:'America/Chicago'}});
  // Then retries reuse one record and summer noon follows daylight saving time.
  expect(first.trigger).toEqual({...daily,timezone:'America/Chicago'});
  expect(repeated.status).toBe(201);expect(canonical.status).toBe(201);
  expect(ResponsibilityRow.parse((await canonical.json()).responsibility).id).toBe(first.id);
  if(first.trigger.kind!=='daily')throw new Error('daily fixture expected');
  expect(await nextDailyAt(f.sql,first.trigger,'2026-07-01T00:00:00Z')).toBe('2026-07-01T17:00:00.000Z');
});
