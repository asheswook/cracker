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

test('new sends and retries preserve human control without queuing a return', async () => {
  // Given
  const s = await setup(); await ack((await control('takeover')).id);
  // When
  const responses = await Promise.all([s.send(), s.send(), s.send()]);
  const saved = await Promise.all(responses.map(async response => { expect(response.status).toBe(200); return Sent.parse(await response.json()); }));
  // Then
  expect(new Set(saved.map(result => result.message.id)).size).toBe(1);
  expect(saved[0]?.task.state).toBe('queued');
  expect(await returned()).toHaveLength(0); expect(await vmState()).toBe('user');
  expect((await poll()).assignment).toBeNull();
});

test('steering a paused run does not implicitly return computer control', async () => {
  // Given
  const s = await setup(); await s.send();
  const assigned = (await poll()).assignment; if (!assigned) throw new TypeError('Missing assignment');
  await ack((await control('takeover')).id);
  // When
  const response = await f.request(`/v1/conversations/${s.conversation}/messages`, f.client,
    { content: 'Continue with this input', client_message_id: crypto.randomUUID() });
  // Then
  expect(response.status).toBe(200); expect(await returned()).toHaveLength(0);
  expect(await vmState()).toBe('user');
  expect((await f.request(`/v1/daemon/resume/${assigned.run_id}`, f.machine, {})).status).toBe(409);
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

test('a message leaves every computer under human control with multiple computers', async () => {
  // Given
  const s = await setup(); await s.send(); await poll(); await ack((await control('takeover')).id);
  const other = crypto.randomUUID();
  await f.sql`INSERT INTO assistant.vms(id,workspace_id,name,control_state) VALUES(${other},${f.workspace},'Unrelated computer','user')`;
  try {
    // When
    const response = await f.request(`/v1/conversations/${s.conversation}/messages`, f.client,
      { content: 'Continue exact work', client_message_id: crypto.randomUUID() });
    // Then
    expect(response.status).toBe(200); expect(await returned()).toHaveLength(0); expect(await vmState()).toBe('user');
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

test('replaying a message after another takeover cannot return control', async () => {
  // Given
  const s = await setup(), original = Sent.parse(await (await s.send()).json());
  await ack((await control('takeover')).id);
  // When
  const response = await s.send();
  // Then
  expect(Sent.parse(await response.json()).message.id).toBe(original.message.id);
  expect(await vmState()).toBe('user'); expect(await returned()).toHaveLength(0);
});

test('failed explicit return stays unknown after retried and new messages', async () => {
  // Given
  const s = await setup(); await ack((await control('takeover')).id); await s.send();
  const command = await control('return_control'); await ack(command.id, 'failed');
  // When
  const retry = await s.send();
  const next = await f.request(`/v1/conversations/${s.conversation}/messages`, f.client,
    { content: 'Another input', client_message_id: crypto.randomUUID() });
  // Then
  expect(retry.status).toBe(200); expect(next.status).toBe(200);
  expect(await vmState()).toBe('unknown'); expect(await returned()).toHaveLength(1);
  expect((await returned())[0]?.status).toBe('failed'); expect((await poll()).assignment).toBeNull();
});
