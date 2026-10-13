import { expect, test } from "bun:test";
import { z } from "zod";
import { Command, DaemonPoll } from "../packages/protocol";
import { ComposingReceipt, ComposingState } from "../packages/protocol/composing";
import { controlFixture } from "./control-fixture";

const f = controlFixture();
const Control = z.object({ control_state: z.enum(["agent", "switching"]), command: Command.nullable() });
async function setup() {
  await f.finishActive();
  await f.sql`DELETE FROM assistant.commands WHERE workspace_id=${f.workspace}`;
  await f.sql`UPDATE assistant.vms SET control_state='agent' WHERE id=${f.vm}`;
  const task = await f.newTask();
  const assignment = DaemonPoll.parse(await (await f.request("/v1/daemon/poll", f.machine)).json()).assignment;
  if (!assignment) throw new TypeError("Missing assignment");
  return { ...task, run: assignment.run_id, request: { run_id: assignment.run_id, request_id: crypto.randomUUID(), reason: "Need desktop input" } };
}
async function takeover() {
  const result = await f.request(`/v1/vms/${f.vm}/control`, f.client, { kind: "takeover" });
  const command = z.object({ command: Command }).parse(await result.json()).command;
  expect((await f.request("/v1/daemon/events", f.machine, {
    kind: "command_ack", event_id: crypto.randomUUID(), command_id: command.id,
    status: "applied", execution_continues: true, detail: "Desktop input drained",
  })).status).toBe(200);
}
const requestControl = (body: unknown) => f.request("/v1/daemon/computer-control", f.machine, body);

for (const state of ["running", "waiting"] as const) test(`scoped takeover preserves ${state} task and run`, async () => {
  // Given
  const s = await setup();
  await f.sql`UPDATE assistant.runs SET state=${state} WHERE id=${s.run}`;
  await f.sql`UPDATE assistant.tasks SET state=${state} WHERE id=${s.task.id}`;
  // When
  await takeover();
  // Then
  expect(z.object({ state: z.string(), task_state: z.string(), control_state: z.string() }).parse((await f.sql`
    SELECT r.state,t.state AS task_state,v.control_state FROM assistant.runs r
    JOIN assistant.tasks t ON t.id=r.task_id JOIN assistant.vms v ON v.id=r.vm_id WHERE r.id=${s.run}`)[0]))
    .toEqual({ state, task_state: state, control_state: "user" });
});

test("scoped daemon claims queued work under user ownership while legacy poll cannot", async () => {
  // Given
  await setup(); await f.finishActive(); await takeover();
  const queued = await f.newTask();
  expect(DaemonPoll.parse(await (await f.request("/v1/daemon/poll", f.machine)).json()).assignment).toBeNull();
  // When
  const response = await f.request("/v1/daemon/poll?desktop_control_scoped=true", f.machine);
  // Then
  expect(DaemonPoll.parse(await response.json()).assignment?.task.id).toBe(queued.task.id);
});

test("scoped resume allows user ownership while legacy resume remains blocked", async () => {
  // Given
  const s = await setup(); await takeover();
  expect((await f.request(`/v1/daemon/resume/${s.run}`, f.machine, {})).status).toBe(409);
  // When
  const response = await f.request(`/v1/daemon/resume/${s.run}`, f.machine, { desktop_control_scoped: true });
  // Then
  expect(response.status).toBe(200);
  expect(z.object({ assignment: z.object({ run_id: z.uuid() }) }).parse(await response.json()).assignment.run_id).toBe(s.run);
});

test("explicit concurrent computer requests reuse one command, bound to the active run", async () => {
  // Given
  const s = await setup(); await takeover();
  // When
  const results = await Promise.all([requestControl(s.request), requestControl(s.request), requestControl({ ...s.request, request_id: crypto.randomUUID() })]);
  // Then
  const controls = await Promise.all(results.map(async response => { expect(response.status).toBe(200); return Control.parse(await response.json()); }));
  expect(new Set(controls.map(result => result.command?.id)).size).toBe(1);
  expect(controls[0]?.control_state).toBe("switching");
  expect(z.array(z.object({ run_id: z.uuid(), task_id: z.uuid(), kind: z.string() })).parse(await f.sql`
    SELECT run_id,task_id,kind FROM assistant.commands WHERE vm_id=${f.vm} AND status='pending'`))
    .toEqual([{ run_id: s.run, task_id: s.task.id, kind: "return_control" }]);
});

test("an already agent-owned computer requires no command and replay cannot undo a later takeover", async () => {
  // Given
  const s = await setup();
  expect(Control.parse(await (await requestControl(s.request)).json())).toEqual({ control_state: "agent", command: null });
  await takeover();
  // When
  const response = await requestControl(s.request);
  // Then
  expect(response.status).toBe(409);
  expect(await f.sql`SELECT id FROM assistant.commands WHERE vm_id=${f.vm} AND kind='return_control'`).toHaveLength(0);
});

for (const state of ["unknown", "switching"] as const) test(`explicit request rejects ${state} ownership without a matching command`, async () => {
  // Given
  const s = await setup(); await f.sql`UPDATE assistant.vms SET control_state=${state} WHERE id=${f.vm}`;
  // When
  const response = await requestControl(s.request);
  // Then
  expect(response.status).toBe(409);
  expect(await f.sql`SELECT id FROM assistant.commands WHERE vm_id=${f.vm} AND kind='return_control'`).toHaveLength(0);
});

for (const kind of ["takeover", "stop"] as const) test(`pending ${kind} blocks a scoped request`, async () => {
  // Given
  const s = await setup();
  if (kind === "stop") await f.request(`/v1/tasks/${s.task.id}/stop`, f.client, {});
  else await f.request(`/v1/vms/${f.vm}/control`, f.client, { kind });
  // When
  const response = await requestControl(s.request);
  // Then
  expect(response.status).toBe(409);
  expect(await f.sql`SELECT id FROM assistant.commands WHERE vm_id=${f.vm} AND kind='return_control'`).toHaveLength(0);
});

for (const state of ["paused", "unknown", "succeeded", "cancelling"] as const) test(`explicit request rejects a ${state} run`, async () => {
  // Given
  const s = await setup(); await f.sql`UPDATE assistant.runs SET state=${state} WHERE id=${s.run}`;
  // When
  const response = await requestControl(s.request);
  // Then
  expect(response.status).toBe(409);
});

test("request identity cannot change reason or cross daemon run ownership", async () => {
  // Given
  const s = await setup(); await takeover();
  expect((await requestControl(s.request)).status).toBe(200);
  // When
  const conflict = await requestControl({ ...s.request, reason: "Different action" });
  const missing = await requestControl({ ...s.request, run_id: crypto.randomUUID() });
  const alien = await f.request("/v1/daemon/computer-control", f.alienToken, s.request);
  // Then
  expect(conflict.status).toBe(409); expect(missing.status).toBe(404); expect(alien.status).toBe(403);
});

test("working and composing remain visible after scoped takeover", async () => {
  // Given
  const s = await setup();
  await f.request("/v1/daemon/events", f.machine, { kind: "input_applied", event_id: crypto.randomUUID(), run_id: s.run, message_id: s.message.id });
  const inference_id = crypto.randomUUID();
  const begin = await f.request("/v1/daemon/composing", f.machine, { kind: "begin", run_id: s.run, inference_id, input_message_ids: [s.message.id] });
  expect(begin.status).toBe(200);
  const token = ComposingReceipt.parse(await begin.json());
  // When
  const update = await f.request("/v1/daemon/composing", f.machine, { kind: "update", run_id: s.run, inference_id, generation: token.generation, sequence: 1, status: "composing", response_id: "response", item_id: "reply", occurred_at: new Date().toISOString() });
  // Then
  expect(update.status).toBe(200);
  await takeover();
  const userPage = z.object({ composing: ComposingState.nullable(), working: z.object({ run_id: z.uuid() }).nullable() }).parse(await (await f.request(`/v1/conversations/${s.message.conversation_id}/messages`)).json());
  expect(userPage.composing?.run_id).toBe(s.run); expect(userPage.working?.run_id).toBe(s.run);
  const requested = Control.parse(await (await requestControl(s.request)).json());
  if (!requested.command) throw new TypeError("Missing command");
  expect((await f.request("/v1/daemon/events", f.machine, { kind: "command_ack", event_id: crypto.randomUUID(), command_id: requested.command.id, status: "applied", execution_continues: true, detail: "Desktop input returned" })).status).toBe(200);
  const page = z.object({ composing: ComposingState.nullable(), working: z.object({ run_id: z.uuid() }).nullable() }).parse(await (await f.request(`/v1/conversations/${s.message.conversation_id}/messages`)).json());
  expect(page.composing?.run_id).toBe(s.run); expect(page.working?.run_id).toBe(s.run);
});

test("return acknowledgement settles ownership even if its requesting run became terminal", async () => {
  // Given
  const s = await setup(); await takeover();
  const requested = Control.parse(await (await requestControl(s.request)).json());
  if (!requested.command) throw new TypeError("Missing command");
  await f.sql`UPDATE assistant.runs SET state='cancelled' WHERE id=${s.run}`;
  await f.sql`UPDATE assistant.tasks SET state='cancelled' WHERE id=${s.task.id}`;
  // When
  const response = await f.request("/v1/daemon/events", f.machine, {
    kind: "command_ack", event_id: crypto.randomUUID(), command_id: requested.command.id,
    status: "applied", execution_continues: true, detail: "Desktop input returned",
  });
  // Then
  expect(response.status).toBe(200);
  expect(z.object({ control_state: z.string(), state: z.string() }).parse((await f.sql`
    SELECT v.control_state,r.state FROM assistant.vms v JOIN assistant.runs r ON r.vm_id=v.id WHERE r.id=${s.run}`)[0]))
    .toEqual({ control_state: "agent", state: "cancelled" });
});

for (const state of ["unknown", "switching"] as const) test(`scoped poll and resume still reject ${state} ownership`, async () => {
  // Given
  const s = await setup(); await f.sql`UPDATE assistant.vms SET control_state=${state} WHERE id=${f.vm}`;
  // When
  const resume = await f.request(`/v1/daemon/resume/${s.run}`, f.machine, { desktop_control_scoped: true });
  await f.finishActive(); await f.newTask();
  const poll = await f.request("/v1/daemon/poll?desktop_control_scoped=true", f.machine);
  // Then
  expect(resume.status).toBe(409); expect(DaemonPoll.parse(await poll.json()).assignment).toBeNull();
});

test("scoped poll and resume honor pending control commands", async () => {
  // Given
  const s = await setup(); await takeover();
  await requestControl(s.request);
  // When
  const response = await f.request(`/v1/daemon/resume/${s.run}`, f.machine, { desktop_control_scoped: true });
  await f.finishActive(); await f.newTask();
  const polled = await f.request("/v1/daemon/poll?desktop_control_scoped=true", f.machine);
  // Then
  expect(response.status).toBe(409); expect(DaemonPoll.parse(await polled.json()).assignment).toBeNull();
});

test("scoped return ACK preserves paused identity until scoped resume even without resume_safe", async () => {
  // Given a legacy paused run and a user-requested desktop return.
  const s = await setup();
  await f.sql`UPDATE assistant.runs SET state='paused' WHERE id=${s.run}`;
  await f.sql`UPDATE assistant.tasks SET state='paused' WHERE id=${s.task.id}`;
  await f.sql`UPDATE assistant.vms SET control_state='user' WHERE id=${f.vm}`;
  const returning = z.object({ command: Command }).parse(await (await f.request(`/v1/vms/${f.vm}/control`, f.client, { kind: "return_control" })).json()).command;
  // When a scoped daemon acknowledges desktop ownership without claiming legacy safe resumption.
  const response = await f.request("/v1/daemon/events", f.machine, {
    kind: "command_ack", event_id: crypto.randomUUID(), command_id: returning.id,
    status: "applied", resume_safe: false, execution_continues: true, detail: "Desktop ownership returned",
  });
  // Then ACK preserves paused task/run identity, and explicit scoped resume uses that same run.
  expect(response.status).toBe(200);
  expect(z.object({ state: z.string(), task_state: z.string(), control_state: z.string() }).parse((await f.sql`
    SELECT r.state,t.state AS task_state,v.control_state FROM assistant.runs r
    JOIN assistant.tasks t ON t.id=r.task_id JOIN assistant.vms v ON v.id=r.vm_id WHERE r.id=${s.run}`)[0]))
    .toEqual({ state: "paused", task_state: "paused", control_state: "agent" });
  const resumed = await f.request(`/v1/daemon/resume/${s.run}`, f.machine, { desktop_control_scoped: true });
  expect(resumed.status).toBe(200);
  expect(z.object({ assignment: z.object({ run_id: z.uuid(), task: z.object({ id: z.uuid(), state: z.string() }) }) }).parse(await resumed.json()).assignment)
    .toMatchObject({ run_id: s.run, task: { id: s.task.id, state: "running" } });
  expect(await f.sql`SELECT id FROM assistant.runs WHERE task_id=${s.task.id}`).toHaveLength(1);
});
