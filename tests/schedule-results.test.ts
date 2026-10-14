import { expect, test } from "bun:test";
import { z } from "zod";
import { controlFixture } from "./control-fixture";
import { ResponsibilityView } from "../packages/memory/responsibility-list";
import { Schedule } from "../services/control/repository/schedule-enrollment";
import { dispatchDueSchedules } from "../services/control/repository/schedules";
import { Task } from "../packages/protocol";

const f = controlFixture();
test("recurring work exposes its pending occurrence and actual last task, scoped to its workspace", async () => {
  const source = await f.newTask();
  const response = await f.request("/v1/responsibilities", f.client, {
    client_responsibility_id: crypto.randomUUID(), conversation_id: source.task.conversation_id,
    vm_id: f.vm, source_message_id: source.message.id, source_quote: source.message.content,
    objective: "Daily source report", trigger: { kind: "daily", hour: 12, minute: 0, timezone: "Asia/Seoul" },
  });
  expect(response.status).toBe(201);
  const id = z.object({ responsibility: z.object({ id: z.uuid() }) }).parse(await response.json()).responsibility.id;
  const list = async (token = f.client) => z.object({ responsibilities: ResponsibilityView.array() }).parse(
    await (await f.request("/v1/responsibilities", token)).json()).responsibilities;
  expect((await list()).find(item => item.id === id)?.last_action).toBeNull();
  await f.sql`UPDATE assistant.responsibilities SET next_review_at='2000-01-01T03:00:00Z' WHERE id=${id}`;
  await f.request("/v1/daemon/responsibilities", f.machine);
  expect((await list()).find(item => item.id === id)?.last_action?.state).toBe("dispatched");
  await f.request("/v1/daemon/responsibilities", f.machine);
  const task = (await list()).find(item => item.id === id)?.last_action?.task;
  expect(task?.state).toBe("queued");
  expect(task?.id).not.toBe(source.task.id);
  expect(task?.conversation_id).toBe(source.task.conversation_id);
  await f.finishActive();
  expect((await list()).find(item => item.id === id)?.last_action?.task?.state).toBe("succeeded");
  expect((await list(f.alienToken)).some(item => item.id === id)).toBe(false);
});

test("one-shot schedule exposes the task actually created by delivery rather than implying completion", async () => {
  const source = await f.newTask(); await f.finishActive();
  const response = await f.request("/v1/schedules", f.client, {
    client_schedule_id: crypto.randomUUID(), conversation_id: source.task.conversation_id,
    objective: "Scheduled research", due_at: "2000-01-01T03:00:00Z", timezone: "Asia/Seoul",
  });
  expect(response.status).toBe(200);
  const id = z.object({ schedule: Schedule }).parse(await response.json()).schedule.id;
  await dispatchDueSchedules(f.sql);
  const list = async (token = f.client) => z.object({ schedules: Schedule.extend({ task: Task.nullable() }).array() }).parse(
    await (await f.request("/v1/schedules", token)).json()).schedules;
  const item = (await list()).find(item => item.id === id);
  expect(item?.status).toBe("delivered");
  expect(item?.task?.state).toBe("queued");
  expect(item?.task?.objective).toBe("Scheduled research");
  expect((await list(f.alienToken)).some(item => item.id === id)).toBe(false);
  await f.finishActive();
});

test("wake provenance repair changes only the machine-created first message, preserving actual user messages", async () => {
  const source = await f.newTask(); await f.finishActive();
  const response = await f.request('/v1/responsibilities',f.client,{
    client_responsibility_id:crypto.randomUUID(),conversation_id:source.task.conversation_id,vm_id:f.vm,
    source_message_id:source.message.id,source_quote:source.message.content,objective:'Daily research',
    trigger:{kind:'daily',hour:12,minute:0,timezone:'Asia/Seoul'},
  });
  const responsibility = z.object({responsibility:z.object({id:z.uuid()})}).parse(await response.json()).responsibility.id;
  const task=crypto.randomUUID(),wake=crypto.randomUUID(),steering=crypto.randomUUID();
  await f.sql`INSERT INTO assistant.tasks(id,workspace_id,conversation_id,objective,state) VALUES(${task},${f.workspace},${source.task.conversation_id},'machine wake','succeeded')`;
  await f.sql`INSERT INTO assistant.messages(id,workspace_id,conversation_id,task_id,role,content) VALUES(${wake},${f.workspace},${source.task.conversation_id},${task},'user','machine wake')`;
  await f.sql`INSERT INTO assistant.messages(id,workspace_id,conversation_id,task_id,role,content,client_message_id) VALUES(${steering},${f.workspace},${source.task.conversation_id},${task},'user','real correction',${crypto.randomUUID()})`;
  await f.sql`INSERT INTO assistant.responsibility_actions(workspace_id,responsibility_id,context_hash,objective,state,task_id) VALUES(${f.workspace},${responsibility},${'a'.repeat(64)},'machine wake','dispatched',${task}),(${f.workspace},${responsibility},${'b'.repeat(64)},'legacy linked real request','dispatched',${source.task.id})`;
  await f.sql.unsafe(await Bun.file(new URL('../infra/migrations/014_wake_provenance.sql',import.meta.url)).text());
  const roles=z.array(z.object({id:z.uuid(),role:z.string()})).parse(await f.sql`SELECT id,role FROM assistant.messages WHERE id IN (${wake},${steering},${source.message.id})`);
  expect(roles.find(item=>item.id===wake)?.role).toBe('system');
  expect(roles.find(item=>item.id===steering)?.role).toBe('user');
  expect(roles.find(item=>item.id===source.message.id)?.role).toBe('user');
});
