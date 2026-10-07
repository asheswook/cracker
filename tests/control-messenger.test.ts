import { expect, test } from "bun:test";
import { z } from "zod";
import { Assignment, DaemonPoll, Message, Onboarding, Persona, ReadReceipt } from "../packages/protocol";
import { controlFixture } from "./control-fixture";
const f=controlFixture();
const Settings=z.object({instructions:z.string(),persona:Persona,onboarding:Onboarding});
async function saveSettings(body: Record<string, unknown>) {
 const {revision}=z.object({revision:z.uuid()}).parse(await(await f.request('/v1/settings')).json());
 return f.request('/v1/settings',f.client,{...body,expected_revision:revision},'PUT');
}
const Page=z.object({messages:z.array(Message),cursor:z.number(),receipts:z.array(ReadReceipt)});

test("a delivered message becomes read only after input is applied, including an older cursor page",async()=>{
 const task=await f.newTask();
 const first=Page.parse(await(await f.request(`/v1/conversations/${task.message.conversation_id}/messages`)).json());
 expect(first.messages[0]?.read_at).toBeNull();
 const poll=DaemonPoll.parse(await(await f.request('/v1/daemon/poll',f.machine)).json());
 if(!poll.assignment)throw new TypeError('Assignment required');
 const event={kind:'input_applied',event_id:crypto.randomUUID(),run_id:poll.assignment.run_id,message_id:task.message.id};
 expect((await f.request('/v1/daemon/events',f.machine,event)).status).toBe(200);
 const path=`/v1/conversations/${task.message.conversation_id}/messages?after=${first.cursor}&receipt_ids=${task.message.id}`;
 const applied=Page.parse(await(await f.request(path)).json());
 expect(applied.messages).toHaveLength(0);
 expect(applied.receipts).toHaveLength(1);
 expect(applied.receipts[0]?.message_id).toBe(task.message.id);
 expect(Date.parse(applied.receipts[0]?.read_at??'')).toBeGreaterThan(0);
 expect((await f.request('/v1/daemon/events',f.machine,event)).status).toBe(200);
 expect(Page.parse(await(await f.request(path)).json()).receipts).toEqual(applied.receipts);
 const other=await f.newConversation();
 expect(Page.parse(await(await f.request(`/v1/conversations/${other.id}/messages?receipt_ids=${task.message.id}`)).json()).receipts).toEqual([]);
 expect((await f.request(path,f.alienToken)).status).toBe(404);
 await f.finishActive();
});

test("onboarding skip and completion persist across requests without overwriting custom instructions",async()=>{
 const initial=Settings.parse(await(await f.request('/v1/settings')).json());
 expect(initial.onboarding).toEqual({status:'pending',updated_at:null});
 await saveSettings({instructions:'Keep my research sources'});
 const skipped=Settings.parse(await(await saveSettings({onboarding:{status:'skipped'}})).json());
 expect(skipped.onboarding.status).toBe('skipped');
 expect(skipped.instructions).toBe('Keep my research sources');
 const persona={name:'Researcher',role:'Evidence review',style:'Concise'};
 const completed=Settings.parse(await(await saveSettings({persona,onboarding:{status:'completed'}})).json());
 expect(completed.persona).toEqual(persona);
 expect(completed.onboarding.status).toBe('completed');
 expect(completed.instructions).toBe('Keep my research sources');
 expect(Settings.parse(await(await f.request('/v1/settings')).json())).toEqual(completed);
 expect(Settings.parse(await(await f.request('/v1/settings',f.alienToken)).json()).onboarding.status).toBe('pending');
 expect((await f.request('/v1/settings',f.client,{onboarding:{status:'completed',updated_at:'fake'}},'PUT')).status).toBe(400);
});

test("resume retains the same run only while the VM owns a running or paused task",async()=>{
 await f.newTask();
 const poll=DaemonPoll.parse(await(await f.request('/v1/daemon/poll',f.machine)).json());
 if(!poll.assignment)throw new TypeError('Assignment required');
 const run=poll.assignment.run_id;
 const route=`/v1/daemon/resume/${run}`;
 const resumed=z.object({assignment:Assignment}).parse(await(await f.request(route,f.machine,{})).json());
 expect(resumed.assignment.run_id).toBe(run);
 await f.sql`UPDATE assistant.vms SET control_state='user' WHERE id=${f.vm}`;
 expect((await f.request(route,f.machine,{})).status).toBe(409);
 await f.sql`UPDATE assistant.vms SET control_state='agent' WHERE id=${f.vm}`;
 await f.sql`UPDATE assistant.runs SET state='unknown' WHERE id=${run}`;
 expect((await f.request(route,f.machine,{})).status).toBe(409);
 expect((await f.request(route,f.client,{})).status).toBe(403);
 await f.finishActive();
});

test("a pending stop prevents checkpoint resume",async()=>{
 const {task}=await f.newTask();
 const poll=DaemonPoll.parse(await(await f.request('/v1/daemon/poll',f.machine)).json());
 if(!poll.assignment)throw new TypeError('Assignment required');
 expect((await f.request(`/v1/tasks/${task.id}/stop`,f.client,{})).status).toBe(200);
 expect((await f.request(`/v1/daemon/resume/${poll.assignment.run_id}`,f.machine,{})).status).toBe(409);
 await f.sql`UPDATE assistant.commands SET status='applied' WHERE vm_id=${f.vm} AND status='pending'`;
 await f.finishActive();
});

test("returning control preserves a paused checkpoint run for explicit resume",async()=>{
 const {task}=await f.newTask();
 const poll=DaemonPoll.parse(await(await f.request('/v1/daemon/poll',f.machine)).json());
 if(!poll.assignment)throw new TypeError('Assignment required');
 const runId=poll.assignment.run_id;
 await f.sql`UPDATE assistant.runs SET state='paused' WHERE id=${runId}`;
 await f.sql`UPDATE assistant.tasks SET state='paused' WHERE id=${task.id}`;
 await f.sql`UPDATE assistant.vms SET control_state='user' WHERE id=${f.vm}`;
 const response=await f.request(`/v1/vms/${f.vm}/control`,f.client,{kind:'return_control'});
 const command=z.object({command:z.object({id:z.uuid()})}).parse(await response.json()).command;
 expect((await f.request('/v1/daemon/events',f.machine,{kind:'command_ack',event_id:crypto.randomUUID(),command_id:command.id,status:'applied',resume_safe:true,detail:'Safe checkpoint available'})).status).toBe(200);
 const paused=z.object({state:z.string()}).parse((await f.sql`SELECT state FROM assistant.runs WHERE id=${runId}`)[0]);
 expect(paused.state).toBe('paused');
 const resumed=z.object({assignment:Assignment}).parse(await(await f.request(`/v1/daemon/resume/${runId}`,f.machine,{})).json());
 expect(resumed.assignment.run_id).toBe(runId);
 expect(resumed.assignment.task.state).toBe('running');
 await f.finishActive();
});
