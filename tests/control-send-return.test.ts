import { expect, test } from 'bun:test';
import { z } from 'zod';
import { Command, DaemonPoll, Message, Task } from '../packages/protocol';
import { appendMessage } from '../services/control/repository/common';
import { dispatchDueSchedules } from '../services/control/repository/schedules';
import { controlFixture } from './control-fixture';

const f = controlFixture();
const Sent = z.object({ message: Message, task: Task });
async function setup() {
  await f.finishActive();
  await f.sql`DELETE FROM assistant.commands WHERE workspace_id=${f.workspace}`;
  await f.sql`UPDATE assistant.vms SET control_state='agent' WHERE id=${f.vm}`;
  const conversation = await f.newConversation();
  const body = { content: 'Explicit human message', client_message_id: crypto.randomUUID() };
  const send = () => f.request(`/v1/conversations/${conversation.id}/messages`, f.client, body);
  return { conversation: conversation.id, body, send };
}
async function control(kind: 'takeover' | 'return_control') {
  const response = await f.request(`/v1/vms/${f.vm}/control`, f.client, { kind });
  expect(response.status).toBe(200);
  return z.object({ command: Command }).parse(await response.json()).command;
}
async function ack(id: string, status: 'applied' | 'failed' = 'applied') {
  const response = await f.request('/v1/daemon/events', f.machine, {
    kind: 'command_ack', event_id: crypto.randomUUID(), command_id: id, status,
    detail: 'Synthetic local barrier result', resume_safe: true,
  });
  expect(response.status).toBe(200);
}
async function returned() {
  return z.array(Command.extend({ vm_id: z.uuid(), status: z.string() })).parse(
    await f.sql`SELECT * FROM assistant.commands WHERE workspace_id=${f.workspace} AND kind='return_control' ORDER BY created_at`,
  );
}
const vmState = async (vm = f.vm) => z.object({ control_state: z.string() }).parse((await f.sql`SELECT control_state FROM assistant.vms WHERE id=${vm}`)[0]).control_state;
const poll = async () => DaemonPoll.parse(await (await f.request('/v1/daemon/poll', f.machine)).json());

test('a new explicit send returns idle human control only after the normal daemon ACK', async () => {
  // Given
  const s = await setup(); await ack((await control('takeover')).id);
  // When
  const response = await s.send(), saved = Sent.parse(await response.json());
  // Then
  expect(response.status).toBe(200); expect(saved.task.state).toBe('queued');
  const commands = await returned(); expect(commands).toHaveLength(1);
  const command = commands[0]; if (!command) throw new TypeError('Missing return command');
  expect(await vmState()).toBe('switching'); expect((await poll()).assignment).toBeNull();
  await ack(command.id);
  expect(await vmState()).toBe('agent'); expect((await poll()).assignment?.task.id).toBe(saved.task.id);
});

test('a paused same-conversation run resumes only after the auto-return ACK', async () => {
  // Given
  const s = await setup(); const first = Sent.parse(await (await s.send()).json());
  const assigned = (await poll()).assignment; if (!assigned) throw new TypeError('Missing assignment');
  await ack((await control('takeover')).id);
  // When
  const steering = await f.request(`/v1/conversations/${s.conversation}/messages`, f.client,
    { content: 'Continue with this input', client_message_id: crypto.randomUUID() });
  // Then
  expect(steering.status).toBe(200);
  const command = (await returned())[0]; if (!command) throw new TypeError('Missing return command');
  expect((await f.request(`/v1/daemon/resume/${assigned.run_id}`, f.machine, {})).status).toBe(409);
  await ack(command.id);
  const resumed = await f.request(`/v1/daemon/resume/${assigned.run_id}`, f.machine, {});
  expect(resumed.status).toBe(200);
  expect(z.object({ assignment: z.object({ run_id: z.uuid(), task: Task }) }).parse(await resumed.json()).assignment)
    .toMatchObject({ run_id: assigned.run_id, task: { id: first.task.id, state: 'running' } });
});

test('simultaneous retries persist one message and one pending auto-return', async () => {
  // Given
  const s = await setup(); await ack((await control('takeover')).id);
  // When
  const responses = await Promise.all([s.send(), s.send(), s.send()]);
  const saved = await Promise.all(responses.map(async response => { expect(response.status).toBe(200); return Sent.parse(await response.json()); }));
  // Then
  expect(new Set(saved.map(result => result.message.id)).size).toBe(1);
  expect(await returned()).toHaveLength(1); expect(await vmState()).toBe('switching');
});

test('replaying a prior send after a newer human takeover never returns control again', async () => {
  // Given
  const s = await setup(); await ack((await control('takeover')).id);
  const original = Sent.parse(await (await s.send()).json());
  const command = (await returned())[0]; if (!command) throw new TypeError('Missing return command');
  await ack(command.id); await ack((await control('takeover')).id);
  // When
  const replay = await s.send();
  // Then
  expect(replay.status).toBe(200); expect(Sent.parse(await replay.json()).message.id).toBe(original.message.id);
  expect(await vmState()).toBe('user'); expect(await returned()).toHaveLength(1);
});

test('failed auto-return remains unknown and neither retry nor new send fabricates recovery', async () => {
  // Given
  const s = await setup(); await ack((await control('takeover')).id); await s.send();
  const command = (await returned())[0]; if (!command) throw new TypeError('Missing return command');
  await ack(command.id, 'failed');
  // When
  expect((await s.send()).status).toBe(200);
  expect((await f.request(`/v1/conversations/${s.conversation}/messages`, f.client,
    { content: 'Another input', client_message_id: crypto.randomUUID() })).status).toBe(200);
  // Then
  expect(await vmState()).toBe('unknown'); expect(await returned()).toHaveLength(1);
  expect((await returned())[0]?.status).toBe('failed'); expect((await poll()).assignment).toBeNull();
});

for (const state of ['agent', 'unknown', 'switching'] as const) test(`send leaves ${state} control unchanged`, async () => {
  // Given
  const s = await setup(); await f.sql`UPDATE assistant.vms SET control_state=${state} WHERE id=${f.vm}`;
  // When
  const response = await s.send();
  // Then
  expect(response.status).toBe(200); expect(await vmState()).toBe(state); expect(await returned()).toHaveLength(0);
});

test('send preserves a pending takeover and does not create a deferred return', async () => {
  // Given
  const s = await setup(), takeover = await control('takeover');
  // When
  expect((await s.send()).status).toBe(200); await ack(takeover.id);
  // Then
  expect(await vmState()).toBe('user'); expect(await returned()).toHaveLength(0);
  expect((await poll()).assignment).toBeNull();
});

test('send reuses an already pending return without a second command', async () => {
  // Given
  const s = await setup(); await ack((await control('takeover')).id);
  const pending = await control('return_control');
  // When
  const response = await s.send();
  // Then
  expect(response.status).toBe(200); expect((await returned()).map(command => command.id)).toEqual([pending.id]);
});

test('a due scheduled message cannot return human control', async () => {
  // Given
  const s = await setup(); await ack((await control('takeover')).id);
  await f.request('/v1/schedules', f.client, { conversation_id: s.conversation, objective: 'Scheduled input',
    due_at: new Date(Date.now() - 1000).toISOString(), timezone: 'UTC', client_schedule_id: crypto.randomUUID() });
  // When
  await dispatchDueSchedules(f.sql);
  // Then
  expect(await vmState()).toBe('user'); expect(await returned()).toHaveLength(0);
  expect((await poll()).assignment).toBeNull();
  expect(z.array(z.object({ role: z.string() })).parse(await f.sql`SELECT role FROM assistant.messages WHERE conversation_id=${s.conversation}`))
    .toEqual([{ role: 'system' }]);
});

test('new input does not return control while the same paused task has a pending stop', async () => {
  // Given
  const s = await setup(), saved = Sent.parse(await (await s.send()).json());
  await poll(); await ack((await control('takeover')).id);
  expect((await f.request(`/v1/tasks/${saved.task.id}/stop`, f.client, {})).status).toBe(200);
  // When
  const response = await f.request(`/v1/conversations/${s.conversation}/messages`, f.client,
    { content: 'Input while stopping', client_message_id: crypto.randomUUID() });
  // Then
  expect(response.status).toBe(200); expect(await returned()).toHaveLength(0); expect(await vmState()).toBe('user');
});

test('a non-chat repository input cannot opt into automatic control return by its user role', async () => {
  // Given
  const s = await setup(); await ack((await control('takeover')).id);
  // When
  await f.sql.begin(tx => appendMessage(tx, { workspace: f.workspace, conversation: s.conversation, content: 'Non-chat input', clientId: crypto.randomUUID() }));
  // Then
  expect(await vmState()).toBe('user'); expect(await returned()).toHaveLength(0);
});

test('a message in another conversation cannot resume unrelated paused work', async () => {
  // Given
  const s = await setup(); const original = await f.newTask(); await poll();
  await ack((await control('takeover')).id);
  // When
  const response = await s.send();
  // Then
  expect(response.status).toBe(200); expect(await vmState()).toBe('user'); expect(await returned()).toHaveLength(0);
  expect(z.object({ state: z.string() }).parse((await f.sql`SELECT state FROM assistant.tasks WHERE id=${original.task.id}`)[0]).state).toBe('paused');
});

test('invalid attachments roll back the message and do not request control', async () => {
  // Given
  const s = await setup(); await ack((await control('takeover')).id);
  // When
  const response = await f.request(`/v1/conversations/${s.conversation}/messages`, f.client,
    { ...s.body, attachment_ids: [crypto.randomUUID()] });
  // Then
  expect(response.status).toBe(409); expect(await vmState()).toBe('user'); expect(await returned()).toHaveLength(0);
  expect(z.object({ error: z.object({ code: z.string() }) }).parse(await response.json()).error.code).toBe('invalid_attachment');
  expect(await f.sql`SELECT id FROM assistant.messages WHERE conversation_id=${s.conversation}`).toHaveLength(0);
});

test('an unassigned message does not choose among multiple user-controlled computers', async () => {
  // Given
  const s = await setup(), other = crypto.randomUUID(); await ack((await control('takeover')).id);
  await f.sql`INSERT INTO assistant.vms(id,workspace_id,name,control_state) VALUES(${other},${f.workspace},'Other computer','user')`;
  try {
    // When
    const response = await s.send();
    // Then
    expect(response.status).toBe(200); expect(await returned()).toHaveLength(0); expect(await vmState()).toBe('user');
  } finally { await f.sql`DELETE FROM assistant.vms WHERE id=${other}`; }
});

test('a message targets only its own paused run when the workspace has multiple computers', async () => {
  // Given
  const s = await setup(); await s.send(); await poll(); await ack((await control('takeover')).id);
  const other = crypto.randomUUID();
  await f.sql`INSERT INTO assistant.vms(id,workspace_id,name,control_state) VALUES(${other},${f.workspace},'Unrelated computer','user')`;
  try {
    // When
    const response = await f.request(`/v1/conversations/${s.conversation}/messages`, f.client,
      { content: 'Continue exact work', client_message_id: crypto.randomUUID() });
    // Then
    expect(response.status).toBe(200); expect((await returned()).map(command => command.vm_id)).toEqual([f.vm]);
    expect(await vmState(other)).toBe('user');
  } finally { await f.sql`DELETE FROM assistant.vms WHERE id=${other}`; }
});

test('another workspace cannot send a message or change this computer control', async () => {
  // Given
  const s = await setup(); await ack((await control('takeover')).id);
  // When
  const response = await f.request(`/v1/conversations/${s.conversation}/messages`, f.alienToken, s.body);
  // Then
  expect(response.status).toBe(404); expect(await vmState()).toBe('user'); expect(await returned()).toHaveLength(0);
});
