import { expect,test } from "bun:test";
import { z } from "zod";
import { DaemonPoll,Message } from "../packages/protocol/index.ts";
import { FutureWorkListResult,FutureWorkMutationResult,UpdateRequest } from "../packages/proactive/schema.ts";
import { dispatchDueSchedules } from "../services/control/repository/schedules.ts";
import { dueResponsibilities,ResponsibilityRow,snapshot } from "../packages/memory/responsibility-store.ts";
import { controlFixture } from "./control-fixture.ts";

const f=controlFixture();
const base="/v1/daemon/proactive-work";
async function active(){
  await f.finishActive();
  const conversation=await f.newConversation();
  const source=Message.parse(z.object({message:Message}).parse(await(await f.request(`/v1/conversations/${conversation.id}/messages`,f.client,{client_message_id:crypto.randomUUID(),content:"Manage my existing routine and reminder"})).json()).message);
  const run=DaemonPoll.parse(await(await f.request("/v1/daemon/poll",f.machine)).json()).assignment;
  if(!run)throw new Error("Missing active run");
  return {run_id:run.run_id,source_message_id:source.id,source_quote:source.content,conversation_id:conversation.id};
}
async function list(run_id:string){
  const response=await f.request(`${base}/list`,f.machine,{run_id,query:null,include_inactive:true,cursor:null});
  expect(response.status).toBe(200);
  const result=FutureWorkListResult.parse(await response.json());
  while(result.next_cursor){
    const next=FutureWorkListResult.parse(await(await f.request(`${base}/list`,f.machine,{run_id,query:null,include_inactive:true,cursor:result.next_cursor})).json());
    result.items.push(...next.items);result.next_cursor=next.next_cursor;
  }
  return result;
}
test("future work pages are bounded, searchable, and do not repeat IDs",async()=>{
  const current=await active();
  await f.sql`INSERT INTO assistant.responsibilities(workspace_id,conversation_id,vm_id,client_responsibility_id,source_message_id,source_quote,objective,trigger,notification_mode) SELECT ${f.workspace},${current.conversation_id},${f.vm},gen_random_uuid(),${current.source_message_id},${current.source_quote},'pagination fixture '||n,'{"kind":"periodic","interval_minutes":60}'::jsonb,'enabled' FROM generate_series(1,12) n`;
  const body={run_id:current.run_id,query:"pagination fixture",include_inactive:false,cursor:null};
  const first=FutureWorkListResult.parse(await(await f.request(`${base}/list`,f.machine,body)).json());
  expect(first.items).toHaveLength(10);
  expect(first.next_cursor).not.toBeNull();
  const second=FutureWorkListResult.parse(await(await f.request(`${base}/list`,f.machine,{...body,cursor:first.next_cursor})).json());
  expect(second.items).toHaveLength(2);
  expect(second.next_cursor).toBeNull();
  expect(new Set([...first.items,...second.items].map(row=>row.id)).size).toBe(12);
});
test("existing legacy-conversation routine updates in place, preserves due time, and receipts survive later edits",async()=>{
  const origin=await active();
  const response=await f.request("/v1/daemon/responsibilities",f.machine,{...origin,vm_id:f.vm,client_responsibility_id:crypto.randomUUID(),objective:"Review applications",trigger:{kind:"daily",hour:9,minute:0,timezone:"Asia/Seoul"}});
  expect(response.status).toBe(201);
  const current=await active();
  const original=(await list(current.run_id)).items.find(row=>row.configuration.objective==="Review applications");
  if(original?.kind!=="responsibility")throw new Error("Missing routine");
  const first={...current,client_action_id:crypto.randomUUID(),work:{kind:"responsibility",id:original.id,expected_version:original.version,configuration:{...original.configuration,objective:"Review applications and notify required submissions"}}};
  UpdateRequest.parse(first);
  const updated=await f.request(`${base}/update`,f.machine,first);
  expect(updated.status).toBe(200);
  const saved=FutureWorkMutationResult.parse(await updated.json()).work;
  expect(saved.id).toBe(original.id);
  expect(saved.next_due_at).toBe(original.next_due_at);
  expect((await list(current.run_id)).items.filter(row=>row.id===original.id)).toHaveLength(1);
  expect((await f.request(`${base}/update`,f.machine,{...first,client_action_id:crypto.randomUUID()})).status).toBe(409);
  if(saved.kind!=="responsibility")throw new Error("Wrong kind");
  const second={...first,client_action_id:crypto.randomUUID(),work:{...first.work,expected_version:saved.version,configuration:{...saved.configuration,objective:"Latest edit"}}};
  expect((await f.request(`${base}/update`,f.machine,second)).status).toBe(200);
  const retry=await f.request(`${base}/update`,f.machine,first);
  expect(retry.status).toBe(200);
  expect(FutureWorkMutationResult.parse(await retry.json()).work.configuration.objective).toBe(first.work.configuration.objective);
  expect((await list(current.run_id)).items.find(row=>row.id===original.id)?.configuration.objective).toBe("Latest edit");
  expect((await f.request(`${base}/update`,f.machine,{...first,source_quote:"different"})).status).toBe(409);
  const latest=(await list(current.run_id)).items.find(row=>row.id===original.id);
  if(latest?.kind!=="responsibility")throw new Error("Missing latest routine");
  const retime=await f.request(`${base}/update`,f.machine,{...current,client_action_id:crypto.randomUUID(),work:{kind:"responsibility",id:latest.id,expected_version:latest.version,configuration:{...latest.configuration,trigger:{kind:"deadline",due_at:"2099-05-01T00:00:00Z",timezone:"UTC"},notification_mode:"quiet",quiet_hours:{start_hour:22,end_hour:8,timezone:"Asia/Seoul"}}}});
  expect(retime.status).toBe(200);
  expect(FutureWorkMutationResult.parse(await retime.json()).work.next_due_at).toBe("2099-05-01T00:00:00.000Z");
});
test("cancel routine clears pending actions and notifications and prevents future dispatch",async()=>{
  const current=await active();
  await f.request("/v1/daemon/responsibilities",f.machine,{...current,vm_id:f.vm,client_responsibility_id:crypto.randomUUID(),objective:"Cancellation test",trigger:{kind:"daily",hour:9,minute:0,timezone:"UTC"}});
  const routine=(await list(current.run_id)).items.find(row=>row.configuration.objective==="Cancellation test");
  if(!routine)throw new Error("Missing routine");
  await f.sql`INSERT INTO assistant.responsibility_actions(workspace_id,responsibility_id,context_hash,objective) VALUES(${f.workspace},${routine.id},'queued','Never dispatch')`;
  await f.sql`INSERT INTO assistant.responsibility_notifications(workspace_id,responsibility_id,context_hash,content) VALUES(${f.workspace},${routine.id},'queued','Never notify')`;
  const inFlight=crypto.randomUUID();
  const inFlightConversation=await f.newConversation();
  await f.sql`INSERT INTO assistant.tasks(id,workspace_id,conversation_id,objective,state) VALUES(${inFlight},${f.workspace},${inFlightConversation.id},'Already dispatched','queued')`;
  await f.sql`INSERT INTO assistant.responsibility_actions(workspace_id,responsibility_id,context_hash,objective,state,task_id) VALUES(${f.workspace},${routine.id},'inflight','Already dispatched','dispatched',${inFlight})`;
  const response=await f.request(`${base}/cancel`,f.machine,{...current,client_action_id:crypto.randomUUID(),target:{kind:routine.kind,id:routine.id,expected_version:routine.version}});
  expect(response.status).toBe(200);
  const result=FutureWorkMutationResult.parse(await response.json());
  expect(result.work.state).toBe("cancelled");
  expect(result.already_dispatched_task_ids).toEqual([inFlight]);
  await f.sql`UPDATE assistant.responsibilities SET next_review_at=now()-interval '1 minute' WHERE id=${routine.id}`;
  await dueResponsibilities(f.sql,{role:"vm",workspace_id:f.workspace,vm_id:f.vm});
  expect(await f.sql`SELECT id FROM assistant.responsibility_actions WHERE responsibility_id=${routine.id} AND context_hash='queued' AND state<>'cancelled'`).toHaveLength(0);
  expect(await f.sql`SELECT id FROM assistant.responsibility_notifications WHERE responsibility_id=${routine.id} AND state<>'cancelled'`).toHaveLength(0);
});
test("owned run cannot see or mutate another VM responsibility and list never dispatches due work",async()=>{
  const current=await active();
  await f.request("/v1/daemon/responsibilities",f.machine,{...current,vm_id:f.vm,client_responsibility_id:crypto.randomUUID(),objective:"VM isolation test",trigger:{kind:"daily",hour:9,minute:0,timezone:"UTC"}});
  const original=(await list(current.run_id)).items.find(row=>row.configuration.objective==="VM isolation test");
  if(!original)throw new Error("Missing routine");
  await f.sql`UPDATE assistant.responsibilities SET next_review_at=now()-interval '1 minute' WHERE id=${original.id}`;
  await list(current.run_id);
  expect(await f.sql`SELECT id FROM assistant.responsibility_actions WHERE responsibility_id=${original.id}`).toHaveLength(0);
  const other=crypto.randomUUID();
  await f.sql`INSERT INTO assistant.vms(id,workspace_id,name) VALUES(${other},${f.workspace},'isolated')`;
  await f.sql`UPDATE assistant.responsibilities SET vm_id=${other} WHERE id=${original.id}`;
  expect((await list(current.run_id)).items.some(row=>row.id===original.id)).toBe(false);
  expect((await f.request(`${base}/cancel`,f.machine,{...current,client_action_id:crypto.randomUUID(),target:{kind:original.kind,id:original.id,expected_version:original.version}})).status).toBe(404);
});
test("schedule updates preserve ID; invalid source and foreign VM cannot mutate; cancellation prevents wake",async()=>{
  const origin=await active();
  expect((await f.request("/v1/daemon/schedules",f.machine,{...origin,client_schedule_id:crypto.randomUUID(),objective:"Scheduled original",due_at:"2099-01-01T09:00:00Z",timezone:"UTC"})).status).toBe(200);
  const current=await active();
  const schedule=(await list(current.run_id)).items.find(row=>row.kind==="schedule"&&row.configuration.objective==="Scheduled original");
  if(schedule?.kind!=="schedule")throw new Error("Missing schedule");
  const mutation={...current,client_action_id:crypto.randomUUID(),work:{kind:"schedule",id:schedule.id,expected_version:schedule.version,configuration:{...schedule.configuration,objective:"Updated reminder",due_at:"2099-02-01T09:00:00Z"}}};
  expect((await f.request(`${base}/update`,f.machine,{...mutation,source_quote:"forged source"})).status).toBe(409);
  const update=await f.request(`${base}/update`,f.machine,mutation);
  expect(update.status).toBe(200);
  const changed=FutureWorkMutationResult.parse(await update.json()).work;
  expect(changed.id).toBe(schedule.id);
  expect(changed.next_due_at).toBe("2099-02-01T09:00:00.000Z");
  const source=z.object({source_message_id:z.uuid()}).parse((await f.sql`SELECT source_message_id FROM assistant.schedules WHERE id=${changed.id}`)[0]);
  expect(source.source_message_id).toBe(origin.source_message_id);
  const otherVm=crypto.randomUUID();
  await f.sql`INSERT INTO assistant.vms(id,workspace_id,name) VALUES(${otherVm},${f.workspace},'other')`;
  await f.sql`UPDATE assistant.runs SET vm_id=${otherVm} WHERE id=${current.run_id}`;
   const before = Array.from(await f.sql`SELECT * FROM assistant.schedules WHERE id=${changed.id}`);
   const rejected = await f.request(`${base}/update`,f.machine,{...mutation,client_action_id:crypto.randomUUID(),work:{...mutation.work,expected_version:changed.version}});
   // The route's owned-run fence rejects before the proactive repository executes.
   expect(rejected.status).toBe(404);
   expect(await rejected.json()).toMatchObject({error:{code:'not_found'}});
   expect(Array.from(await f.sql`SELECT * FROM assistant.schedules WHERE id=${changed.id}`)).toEqual(before);
  await f.sql`UPDATE assistant.runs SET vm_id=${f.vm} WHERE id=${current.run_id}`;
  expect((await f.request(`${base}/cancel`,f.machine,{...current,client_action_id:crypto.randomUUID(),target:{kind:"schedule",id:changed.id,expected_version:changed.version}})).status).toBe(200);
  await f.sql`UPDATE assistant.schedules SET due_at=now()-interval '1 second' WHERE id=${changed.id}`;
  await dispatchDueSchedules(f.sql);
  expect(await f.sql`SELECT id FROM assistant.messages WHERE workspace_id=${f.workspace} AND client_message_id=${changed.id}`).toHaveLength(0);
});
test("source-free UI reminder remains manageable from an owned active run",async()=>{
  const current=await active();
  const schedule=crypto.randomUUID();
  await f.sql`INSERT INTO assistant.schedules(id,workspace_id,conversation_id,objective,due_at,timezone,client_schedule_id) VALUES(${schedule},${f.workspace},${current.conversation_id},'UI reminder','2099-01-01','UTC',${crypto.randomUUID()})`;
  const item=(await list(current.run_id)).items.find(row=>row.id===schedule);
  if(!item)throw new Error("UI schedule omitted");
  expect((await f.request(`${base}/cancel`,f.machine,{...current,client_action_id:crypto.randomUUID(),target:{kind:item.kind,id:item.id,expected_version:item.version}})).status).toBe(200);
});
test("delivery preference update preserves pending notification and client ABA invalidates version",async()=>{
  const current=await active();
  await f.request("/v1/daemon/responsibilities",f.machine,{...current,vm_id:f.vm,client_responsibility_id:crypto.randomUUID(),objective:"Preferences fixture",trigger:{kind:"periodic",interval_minutes:60},notification_mode:"quiet"});
  const item=(await list(current.run_id)).items.find(row=>row.configuration.objective==="Preferences fixture");
  if(item?.kind!=="responsibility")throw new Error("Missing preference fixture");
  const row=ResponsibilityRow.parse((await f.sql`SELECT * FROM assistant.responsibilities WHERE id=${item.id}`)[0]);
  const context=await snapshot(f.sql,row);
  await f.sql`INSERT INTO assistant.responsibility_notifications(workspace_id,responsibility_id,context_hash,content) VALUES(${f.workspace},${item.id},${context.context_hash},'Retain pending notification')`;
  const update={...current,client_action_id:crypto.randomUUID(),work:{kind:"responsibility",id:item.id,expected_version:item.version,configuration:{...item.configuration,notification_mode:"enabled"}}};
  expect((await f.request(`${base}/update`,f.machine,update)).status).toBe(200);
  expect(await f.sql`SELECT id FROM assistant.responsibility_notifications WHERE responsibility_id=${item.id} AND state='pending'`).toHaveLength(1);
  await dueResponsibilities(f.sql,{role:"vm",workspace_id:f.workspace,vm_id:f.vm});
  expect(await f.sql`SELECT id FROM assistant.responsibility_notifications WHERE responsibility_id=${item.id} AND state='delivered'`).toHaveLength(1);
  const latest=(await list(current.run_id)).items.find(row=>row.id===item.id);
  if(!latest)throw new Error("Missing updated fixture");
  for(const mode of ["quiet","enabled"]){expect((await f.request(`/v1/responsibilities/${item.id}/settings`,f.client,{notification_mode:mode,quiet_hours:null})).status).toBe(200);}
  expect((await f.request(`${base}/update`,f.machine,{...update,client_action_id:crypto.randomUUID(),work:{...update.work,expected_version:latest.version}})).status).toBe(409);
});
