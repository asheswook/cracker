import { expect, test } from "bun:test";
import { DaemonPoll } from "../packages/protocol";
import { controlFixture } from "./control-fixture";
import { hashToken } from "../services/control/auth";

const { sql, app, vm, workspace, client, machine, request, newTask, finishActive } = controlFixture();
const reason = "Invalid provider response: invalid_tool_arguments; no calls from that response were executed";
for (const failureReason of [reason, "Invalid provider response: invalid_tool_call; no calls from that response were executed", "Future unknown error category", "Control disconnected during execution; reconcile interrupted effects before resuming", "Runtime/provider/tool failure; inspect protected local journal before resuming"])
for (const text of ["retry", "continue", "예약은 안해도됨"]) test(`${failureReason}: same-run recovery for ${text}`, async () => {
  await finishActive();
  const initial = await newTask();
  const first = DaemonPoll.parse(await (await request("/v1/daemon/poll", machine)).json());
  if (!first.assignment) throw new Error("missing assignment");
  const run = first.assignment.run_id;
  await request("/v1/daemon/events", machine, { kind: "input_applied", event_id: crypto.randomUUID(), run_id: run, message_id: initial.message.id });
  await request("/v1/daemon/events", machine, { kind: "state", event_id: crypto.randomUUID(), run_id: run, state: "unknown", reason: failureReason });
  expect((await (await request("/v1/daemon/poll", machine)).json()).recovery_run_id).toBeUndefined();
  await request(`/v1/conversations/${initial.task.conversation_id}/messages`, client, { client_message_id: crypto.randomUUID(), content: text });
  if (failureReason.startsWith("Runtime/provider/")) {
    await sql`INSERT INTO assistant.chatgpt_accounts(vm_id,workspace_id,request_id,action,request_status,state,lease_until) VALUES(${vm},${workspace},${crypto.randomUUID()},'connect','running','connecting',now()+interval '5 minutes') ON CONFLICT(vm_id) DO UPDATE SET request_status='running',state='connecting',lease_until=excluded.lease_until`;
    expect((await (await request("/v1/daemon/poll", machine)).json()).recovery_run_id).toBeUndefined();
    expect((await request(`/v1/daemon/resume/${run}`, machine, {checkpoint_cursor:initial.message.sequence})).status).toBe(409);
    await sql`UPDATE assistant.chatgpt_accounts SET request_status='completed',state='connected',lease_until=NULL WHERE vm_id=${vm}`;
  }
  const candidate = await (await request("/v1/daemon/poll", machine)).json();
  expect(candidate.recovery_run_id).toBe(run);
  expect(candidate.assignment).toBeNull();
  const otherVm=crypto.randomUUID(),otherToken=crypto.randomUUID()+crypto.randomUUID();
  await sql`INSERT INTO assistant.vms(id,workspace_id,name) VALUES(${otherVm},${workspace},'foreign-retry-vm')`;
  await sql`INSERT INTO assistant.credentials(token_hash,workspace_id,role,vm_id) VALUES(${await hashToken(otherToken)},${workspace},'vm',${otherVm})`;
  expect((await request(`/v1/daemon/resume/${run}`, otherToken, {checkpoint_cursor:initial.message.sequence})).status).toBe(404);
  expect((await (await request(`/v1/daemon/poll?run_id=${run}`, machine)).json()).recovery_run_id).toBeUndefined();
  expect((await request(`/v1/daemon/resume/${run}`, machine, {})).status).toBe(409);
  expect((await request(`/v1/daemon/resume/${run}`, machine, { checkpoint_cursor: Number.MAX_SAFE_INTEGER })).status).toBe(409);
  await sql`UPDATE assistant.vms SET control_state='user' WHERE id=${vm}`;
  expect((await (await request("/v1/daemon/poll", machine)).json()).recovery_run_id).toBeUndefined();
  expect((await request(`/v1/daemon/resume/${run}`, machine, { checkpoint_cursor: initial.message.sequence })).status).toBe(409);
  await sql`UPDATE assistant.vms SET control_state='agent' WHERE id=${vm}`;
  const command = crypto.randomUUID();
  await sql`INSERT INTO assistant.commands(id,workspace_id,vm_id,kind) SELECT ${command},workspace_id,id,'takeover' FROM assistant.vms WHERE id=${vm}`;
  expect((await (await request("/v1/daemon/poll", machine)).json()).recovery_run_id).toBeUndefined();
  expect((await request(`/v1/daemon/resume/${run}`, machine, { checkpoint_cursor: initial.message.sequence })).status).toBe(409);
  await sql`UPDATE assistant.commands SET status='applied' WHERE id=${command}`;
  const resumed = await request(`/v1/daemon/resume/${run}`, machine, { checkpoint_cursor: initial.message.sequence });
  expect(resumed.status).toBe(200);
  const body = await resumed.json();
  expect(body.assignment.run_id).toBe(run);
  expect(body.assignment.messages.some((m: {content: string}) => m.content === text)).toBe(true);
  const rows = await sql`SELECT count(*)::int AS count FROM assistant.runs WHERE task_id=${initial.task.id}`;
  expect(rows[0]?.["count"]).toBe(1);
});
test("recovery candidates ignore error prose but require new same-task input and a live task", async () => {
  await finishActive();
  const initial = await newTask();
  const first = DaemonPoll.parse(await (await request("/v1/daemon/poll", machine)).json());
  if (!first.assignment) throw new Error("missing assignment");
  const run = first.assignment.run_id;
  await request("/v1/daemon/events", machine, { kind: "state", event_id: crypto.randomUUID(), run_id: run, state: "unknown", reason: "Desktop execution failed: uncertain" });
  await request(`/v1/conversations/${initial.task.conversation_id}/messages`, client, { client_message_id: crypto.randomUUID(), content: "retry" });
  expect((await (await request("/v1/daemon/poll", machine)).json()).recovery_run_id).toBe(run);
  expect((await request(`/v1/daemon/resume/${run}`, machine, {})).status).toBe(409);
  await sql`UPDATE assistant.tasks SET reason=${reason} WHERE id=${initial.task.id}`;
  await sql`UPDATE assistant.runs SET updated_at=now() WHERE id=${run}`;
  await sql`INSERT INTO assistant.input_receipts(workspace_id,run_id,message_id) SELECT workspace_id,${run},id FROM assistant.messages WHERE task_id=${initial.task.id} AND role IN ('user','system') ON CONFLICT DO NOTHING`;
  await newTask();
  expect((await (await request("/v1/daemon/poll", machine)).json()).recovery_run_id).toBeUndefined();
  await sql`UPDATE assistant.tasks SET state='cancelled' WHERE id=${initial.task.id}`;
  await sql`UPDATE assistant.runs SET state='cancelled' WHERE id=${run}`;
  expect((await request(`/v1/daemon/resume/${run}`, machine, { checkpoint_cursor: 0 })).status).toBe(409);
  await sql`UPDATE assistant.vms SET control_state='agent' WHERE id=${vm}`;
});

test("followup received during inference remains recoverable when failure occurs later",async()=>{
  await finishActive();
  const initial=await newTask();
  const poll=DaemonPoll.parse(await (await request('/v1/daemon/poll',machine)).json());
  if(!poll.assignment)throw new Error('missing run');
  const run=poll.assignment.run_id;
  await request('/v1/daemon/events',machine,{kind:'input_applied',event_id:crypto.randomUUID(),run_id:run,message_id:initial.message.id});
  await request(`/v1/conversations/${initial.task.conversation_id}/messages`,client,{client_message_id:crypto.randomUUID(),content:'Also check this'});
  await request('/v1/daemon/events',machine,{kind:'state',event_id:crypto.randomUUID(),run_id:run,state:'unknown',reason:'Unexpected failure after new input'});
  expect((await (await request('/v1/daemon/poll',machine)).json()).recovery_run_id).toBe(run);
  expect((await request(`/v1/daemon/resume/${run}`,machine,{checkpoint_cursor:initial.message.sequence})).status).toBe(200);
});

test("unsafe recovery creates an idempotent explanation run and preserves the interrupted run", async () => {
  await finishActive();
  const initial=await newTask();
  const first=DaemonPoll.parse(await (await request('/v1/daemon/poll',machine)).json());
  if(!first.assignment)throw new Error('missing assignment');
  const source=first.assignment.run_id;
  await request('/v1/daemon/events',machine,{kind:'state',event_id:crypto.randomUUID(),run_id:source,state:'unknown',reason:'Unknown side effect'});
  await request(`/v1/conversations/${initial.task.conversation_id}/messages`,client,{client_message_id:crypto.randomUUID(),content:'What failed?'});
  const recovery={completed_actions:3,uncertain_actions:1,history_available:false};
  const resumed=await request(`/v1/daemon/resume/${source}`,machine,{recovery});
  if(resumed.status!==200)throw new Error(await resumed.text());
  expect(resumed.status).toBe(200);
  const assignment=DaemonPoll.parse({...await resumed.json(),commands:[],messages:[]}).assignment;
  if(!assignment)throw new Error('missing replacement');
  expect(assignment.run_id).not.toBe(source);
  expect(assignment.recovery).toEqual({...recovery,mode:'explain_only',source_run_id:source,reason:'Unknown side effect'});
  expect((await sql`SELECT state FROM assistant.runs WHERE id=${source}`)[0]?.['state']).toBe('unknown');
  const again=await request(`/v1/daemon/resume/${source}`,machine,{recovery});
  expect(again.status).toBe(200);
  expect((await again.json()).assignment.run_id).toBe(assignment.run_id);
  expect((await sql`SELECT count(*)::int AS n FROM assistant.runs WHERE task_id=${initial.task.id}`)[0]?.['n']).toBe(2);
  const full=await request(`/v1/daemon/context/${assignment.run_id}?view=work`,machine);
  expect((await full.json()).recovery).toEqual(assignment.recovery);
  await sql`UPDATE assistant.vms SET control_state='user' WHERE id=${vm}`;
  expect((await request(`/v1/daemon/resume/${source}`,machine,{recovery})).status).toBe(409);
  await sql`UPDATE assistant.vms SET control_state='agent' WHERE id=${vm}`;
  const finish={kind:'state',event_id:crypto.randomUUID(),run_id:assignment.run_id,state:'failed',reason:'Explanation delivered'};
  const premature=await request('/v1/daemon/events',machine,finish);
  expect(premature.status).toBe(409);
  expect((await premature.json()).error.code).toBe('pending_input');
  for(const message of assignment.messages.filter(message=>message.role==='user'||message.role==='system')){
    expect((await request('/v1/daemon/events',machine,{kind:'input_applied',event_id:crypto.randomUUID(),run_id:assignment.run_id,message_id:message.id})).status).toBe(200);
  }
  expect((await request('/v1/daemon/events',machine,finish)).status).toBe(200);
  expect((await request(`/v1/daemon/resume/${source}`,machine,{recovery})).status).toBe(409);
  expect((await (await request('/v1/daemon/poll',machine)).json()).recovery_run_id).toBeUndefined();
  expect((await sql`SELECT state FROM assistant.tasks WHERE id=${initial.task.id}`)[0]?.['state']).toBe('failed');
});

test('a new fenced daemon session adopts an unknown predecessor with unapplied input',async()=>{
  await finishActive();
  const initial=await newTask();
  const poll=DaemonPoll.parse(await (await request('/v1/daemon/poll',machine)).json());
  if(!poll.assignment)throw new Error('missing assignment');
  const run=poll.assignment.run_id,old=crypto.randomUUID(),current=crypto.randomUUID();
  await request('/v1/daemon/events',machine,{kind:'input_applied',event_id:crypto.randomUUID(),run_id:run,message_id:initial.message.id});
  await request('/v1/daemon/events',machine,{kind:'state',event_id:crypto.randomUUID(),run_id:run,state:'unknown',reason:'Old session failed'});
  await request(`/v1/conversations/${initial.task.conversation_id}/messages`,client,{client_message_id:crypto.randomUUID(),content:'continue'});
  await sql`INSERT INTO assistant.daemon_sessions(id,vm_id,epoch) VALUES(${old},${vm},1),(${current},${vm},2)`;
  await sql`UPDATE assistant.runs SET daemon_session_id=${old} WHERE id=${run}`;
  await sql`UPDATE assistant.vms SET daemon_session_id=${current},daemon_epoch=2,daemon_reconciled=true WHERE id=${vm}`;
  const resume=(session:string)=>app.request(`/v1/daemon/resume/${run}`,{method:'POST',headers:{Authorization:`Bearer ${machine}`,'Content-Type':'application/json','x-daemon-session':session},body:JSON.stringify({checkpoint_cursor:initial.message.sequence,desktop_control_scoped:true})});
  expect((await resume(old)).status).toBe(409);
  const resumed=await resume(current);
  expect(resumed.status).toBe(200);
  expect((await resumed.json()).assignment.run_id).toBe(run);
  expect((await sql`SELECT daemon_session_id FROM assistant.runs WHERE id=${run}`)[0]?.['daemon_session_id']).toBe(current);
  await sql`UPDATE assistant.vms SET daemon_session_id=NULL,daemon_epoch=0 WHERE id=${vm}`;
});
