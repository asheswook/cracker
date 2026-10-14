import { beforeEach, expect, test } from 'bun:test';
import { z } from 'zod';
import { Assignment, DaemonPoll, Message, Task } from '../packages/protocol';
import { controlFixture } from './control-fixture';
import { createBackgroundTask } from '../services/control/repository/common';
import { dispatchDueSchedules } from '../services/control/repository/schedules';
import { enqueueMessageNotification } from '../packages/notifications/store';
import { hashToken } from '../services/control/auth';
import { MessagePage } from '../apps/web/src/types';

const f=controlFixture();
beforeEach(()=>f.finishActive());
const page=async(id:string)=>MessagePage.parse(await (await f.request(`/v1/conversations/${id}/messages`)).json());
const poll=async()=>{
  const result=DaemonPoll.parse(await (await f.request('/v1/daemon/poll',f.machine)).json());
  if(!result.assignment)throw new Error('Missing assignment');
  return result.assignment;
};
const background=async(conversation:string)=>f.sql.begin(tx=>createBackgroundTask(tx,{workspace:f.workspace,conversation,objective:'Background objective',origin:'schedule',clientId:crypto.randomUUID()}));
const send=async(run:string,content:string,phase?:'commentary'|'final_answer',attachment_ids?:string[])=>{
  const message_id=crypto.randomUUID();
  const event={kind:'message',event_id:crypto.randomUUID(),message_id,run_id:run,content,...(phase?{phase}:{}),...(attachment_ids?{attachment_ids,output_kind:'artifact'}:{})};
  expect((await f.request('/v1/daemon/events',f.machine,event)).status).toBe(200);
  expect((await f.request('/v1/daemon/events',f.machine,event)).status).toBe(200);
  return message_id;
};

test('due schedules isolate their hidden wake from an active foreground task and dispatch once',async()=>{
  const source=await f.newTask(),foreground=await poll();
  const created=await f.request('/v1/schedules',f.client,{client_schedule_id:crypto.randomUUID(),conversation_id:source.task.conversation_id,objective:'Scheduled wake',due_at:'2000-01-01T00:00:00Z',timezone:'UTC'});
  expect(created.status).toBe(200);
  const schedule=z.object({schedule:z.object({id:z.uuid()})}).parse(await created.json()).schedule.id;
  await Promise.all([dispatchDueSchedules(f.sql),dispatchDueSchedules(f.sql)]);
  const wakes=z.array(Message).parse(await f.sql`SELECT * FROM assistant.messages WHERE conversation_id=${source.task.conversation_id} AND client_message_id=${schedule}`);
  expect(wakes).toHaveLength(1);
  expect(wakes[0]).toMatchObject({hidden:true,role:'system',origin:'schedule'});
  expect(wakes[0]?.task_id).not.toBe(source.task.id);
  const mailbox=z.object({messages:Message.array()}).parse(await (await f.request(`/v1/daemon/context/${foreground.run_id}?view=work_mailbox`,f.machine)).json());
  expect(mailbox.messages.map(m=>m.id)).toEqual([source.message.id]);
  const reply=z.object({task:Task}).parse(await (await f.request(`/v1/conversations/${source.task.conversation_id}/messages`,f.client,{content:'Live steering',client_message_id:crypto.randomUUID()})).json());
  expect(reply.task.id).toBe(source.task.id);
  const feed=await page(source.task.conversation_id);
  expect(feed.messages.map(m=>m.content)).toEqual(['objective','Live steering']);
  expect(feed.background).toMatchObject({count:1,items:[{task_id:wakes[0]?.task_id,state:'queued',started_at:null}]});
});

test('poll prioritizes foreground, keeps VM serial, and every background context path is task scoped',async()=>{
  const conversation=await f.newConversation(),scheduled=await background(conversation.id);
  const source=z.object({task:Task,message:Message}).parse(await (await f.request(`/v1/conversations/${conversation.id}/messages`,f.client,{content:'Private live input',client_message_id:crypto.randomUUID()})).json());
  expect((await poll()).task.id).toBe(source.task.id);
  await f.finishActive();
  await f.sql`UPDATE assistant.tasks SET state='queued' WHERE id=${scheduled.task.id}`;
  const assignment=await poll();
  expect(assignment.lane).toBe('background');
  expect(assignment.messages.map(m=>m.id)).toEqual([scheduled.message.id]);
  expect((await f.sql`SELECT lane FROM assistant.runs WHERE id=${assignment.run_id}`)[0]?.['lane']).toBe('background');
  const live=z.object({task:Task,message:Message}).parse(await (await f.request(`/v1/conversations/${conversation.id}/messages`,f.client,{content:'New live input',client_message_id:crypto.randomUUID()})).json());
  expect(live.task.id).not.toBe(scheduled.task.id);
  for(const view of ['full','mailbox','work','work_mailbox']){
    const context=z.object({messages:Message.array()}).parse(await (await f.request(`/v1/daemon/context/${assignment.run_id}?view=${view}`,f.machine)).json());
    expect(context.messages.map(m=>m.id)).toEqual([scheduled.message.id]);
  }
  const resumed=DaemonPoll.parse(await (await f.request(`/v1/daemon/poll?run_id=${assignment.run_id}`,f.machine)).json());
  expect(resumed.assignment).toBeNull();
  expect(resumed.messages.map(m=>m.id)).toEqual([scheduled.message.id]);
  expect((await f.request('/v1/daemon/events',f.machine,{kind:'input_applied',event_id:crypto.randomUUID(),run_id:assignment.run_id,message_id:live.message.id})).status).toBe(404);
  expect((await f.request('/v1/daemon/events',f.machine,{kind:'input_applied',event_id:crypto.randomUUID(),run_id:assignment.run_id,message_id:scheduled.message.id})).status).toBe(200);
  expect((await page(conversation.id)).working).toBeNull();
  expect((await page(conversation.id)).background?.items[0]?.started_at).not.toBeNull();
  expect((await f.request('/v1/daemon/composing',f.machine,{kind:'begin',run_id:assignment.run_id,inference_id:crypto.randomUUID(),input_message_ids:[scheduled.message.id]})).status).toBe(409);
  expect((await page(conversation.id)).composing).toBeNull();
  const other=await background(conversation.id);
  await expect((async()=>{await f.sql`INSERT INTO assistant.runs(workspace_id,task_id,vm_id) VALUES(${f.workspace},${other.task.id},${f.vm})`;})()).rejects.toMatchObject({code:'23505'});
});

test('background commentary and silence stay hidden; final reports publish files, explicit notifications still push',async()=>{
  const conversation=await f.newConversation();
  const task=await background(conversation.id),assignment=await poll();
  await f.sql`INSERT INTO assistant.push_subscriptions(workspace_id,credential_hash,installation_id,subscription_cipher,enabled) VALUES(${f.workspace},${await hashToken(f.client)},${crypto.randomUUID()},'fixture',true)`;
  const commentary=await send(assignment.run_id,'Working privately','commentary');
  await send(assignment.run_id,'No phase is not a report');
  await send(assignment.run_id,' NO_REPORT \n','final_answer');
  await send(assignment.run_id,'  ','final_answer');
  const artifact=crypto.randomUUID();
  await f.sql`INSERT INTO assistant.artifacts(id,workspace_id,conversation_id,name,media_type,bytes,sha256,object_key,state,lease_id) VALUES(${artifact},${f.workspace},${conversation.id},'report.txt','text/plain',1,${'a'.repeat(64)},${artifact},'ready',${crypto.randomUUID()})`;
  const artifactMessage=await send(assignment.run_id,'',undefined,[artifact]);
  expect((await page(conversation.id)).messages).toEqual([]);
  await f.sql`UPDATE assistant.messages SET notify=true WHERE id=${commentary}`;
  await enqueueMessageNotification(f.sql,f.workspace,{id:commentary,runId:assignment.run_id});
  expect(await f.sql`SELECT id FROM assistant.notification_intents WHERE conversation_id=${conversation.id}`).toHaveLength(0);
  const final=await send(assignment.run_id,'Finished report','final_answer');
  const feed=await page(conversation.id);
  expect(feed.messages).toHaveLength(1);
  expect(feed.messages[0]).toMatchObject({id:final,origin:'schedule',attachments:[{id:artifact}]});
  expect((await f.sql`SELECT hidden FROM assistant.messages WHERE id=${artifactMessage}`)[0]?.['hidden']).toBe(true);
  const context=Assignment.parse(await (await f.request(`/v1/daemon/context/${assignment.run_id}?view=work`,f.machine)).json());
  expect(context.messages).toHaveLength(7);
  expect((await f.request('/v1/daemon/notify-user',f.machine,{run_id:assignment.run_id,conversation_id:conversation.id,client_message_id:crypto.randomUUID(),message:'Requested alert'})).status).toBe(200);
  expect(await f.sql`SELECT id FROM assistant.notification_intents WHERE conversation_id=${conversation.id}`).toHaveLength(1);
  expect(task.task.id).toBe(assignment.task.id);
});

test('background failure has one visible origin-aware status without an unsolicited push',async()=>{
  const conversation=await f.newConversation();await background(conversation.id);
  const assignment=await poll();
  const event={kind:'state',event_id:crypto.randomUUID(),run_id:assignment.run_id,state:'failed',reason:'Background failed'};
  expect((await f.request('/v1/daemon/events',f.machine,event)).status).toBe(200);
  expect((await f.request('/v1/daemon/events',f.machine,event)).status).toBe(200);
  expect((await page(conversation.id)).messages).toMatchObject([{role:'system',origin:'schedule',content:'Background failed'}]);
  expect((await page(conversation.id)).background?.count).toBe(0);
  expect(await f.sql`SELECT id FROM assistant.notification_intents WHERE conversation_id=${conversation.id}`).toHaveLength(0);
});
