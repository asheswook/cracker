import { expect, test } from "bun:test";
import { z } from "zod";
import { Command, DaemonPoll, Message, Task } from "../packages/protocol";
import { dispatchDueSchedules } from "../services/control/repository/schedules";
import { controlFixture } from "./control-fixture";

const { sql, app, client, machine, alienToken, request, newConversation, newTask, finishActive } =
  controlFixture();
test("rejects missing authentication and credential audience confusion", async () => {
  // Given client and machine credentials; When crossing their audiences; Then reject.
  expect((await app.request("/v1/tasks")).status).toBe(401);
  expect((await request("/v1/tasks", machine)).status).toBe(403);
  expect((await request("/v1/daemon/poll", client)).status).toBe(403);
});
test("deduplicates concurrent messages transactionally and rejects changed payload", async () => {
  // Given one conversation and one idempotency key.
  const c = await newConversation(),
    body = { client_message_id: crypto.randomUUID(), content: "exactly once" };
  // When concurrent requests replay the message.
  const responses = await Promise.all(
    Array.from({ length: 8 }, () => request(`/v1/conversations/${c.id}/messages`, client, body)),
  );
  const results = await Promise.all(
    responses.map(async (r) => z.object({ message: Message, task: Task }).parse(await r.json())),
  );
  // Then all responses identify one message and one task; changed content conflicts.
  expect(new Set(results.map((r) => r.message.id)).size).toBe(1);
  expect(new Set(results.map((r) => r.task.id)).size).toBe(1);
  expect(
    (await request(`/v1/conversations/${c.id}/messages`, client, { ...body, content: "different" }))
      .status,
  ).toBe(409);
  expect((await request(`/v1/conversations/${c.id}/messages`, alienToken)).status).toBe(404);
});
test("claims one run and steers it without creating a second task", async () => {
  // Given queued work.
  await finishActive();
  const initial = await newTask();
  // When the daemon claims and user sends steering.
  const result = DaemonPoll.parse(await (await request("/v1/daemon/poll", machine)).json());
  expect(result.assignment).not.toBeNull();
  if (!result.assignment) throw new Error("missing assignment");
  const next = z.object({ task: Task, message: Message }).parse(
    await (
      await request(`/v1/conversations/${initial.task.conversation_id}/messages`, client, {
        client_message_id: crypto.randomUUID(),
        content: "steer",
      })
    ).json(),
  );
  // Then same task with steering appears in mailbox.
  expect(next.task.id).toBe(initial.task.id);
  const mailbox = DaemonPoll.parse(
    await (await request(`/v1/daemon/poll?run_id=${result.assignment.run_id}`, machine)).json(),
  );
  expect(mailbox.assignment).toBeNull();
  expect(mailbox.messages.some((m) => m.content === "steer")).toBe(true);
});
test("stop remains cancelling until ACK and rejects late conflicting ACK", async () => {
  // Given an active run.
  await finishActive();
  const initial = await newTask();
  await request("/v1/daemon/poll", machine);
  // When stop is requested then acknowledged.
  const response = await request(`/v1/tasks/${initial.task.id}/stop`, client, {});
  const { command } = z.object({ command: Command }).parse(await response.json());
  const pending = z
    .array(Task)
    .parse(
      z.object({ tasks: z.array(Task) }).parse(await (await request("/v1/tasks")).json()).tasks,
    )
    .find((t) => t.id === initial.task.id);
  expect(pending?.state).toBe("cancelling");
  const ack = {
    kind: "command_ack",
    event_id: crypto.randomUUID(),
    command_id: command.id,
    status: "applied",
    detail: "process group stopped",
  };
  expect((await request("/v1/daemon/events", machine, ack)).status).toBe(200);
  expect((await request("/v1/daemon/events", machine, ack)).status).toBe(200);
  // Then cancellation is persisted and unrelated replay is rejected.
  expect(
    z
      .object({ state: z.string() })
      .parse((await sql`SELECT state FROM tasks WHERE id=${initial.task.id}`)[0]).state,
  ).toBe("cancelled");
  expect(
    (await request("/v1/daemon/events", machine, { ...ack, event_id: crypto.randomUUID() })).status,
  ).toBe(409);
});
test("restart without journal quarantines unknown work rather than reassigning", async () => {
  // Given a claimed run.
  await finishActive();
  const initial = await newTask();
  await request("/v1/daemon/poll", machine);
  // When daemon restarts without a run id.
  const polled = DaemonPoll.parse(await (await request("/v1/daemon/poll", machine)).json());
  // Then it receives no assignment and the original task is unknown.
  expect(polled.assignment).toBeNull();
  expect(
    z
      .object({ state: z.string() })
      .parse((await sql`SELECT state FROM tasks WHERE id=${initial.task.id}`)[0]).state,
  ).toBe("unknown");
});
test("schedule dispatch is idempotent and cancellation prevents delivery", async () => {
  // Given a due and cancelled schedule.
  const c = await newConversation();
  const body = {
    conversation_id: c.id,
    objective: "wake",
    due_at: "2020-01-01T00:00:00Z",
    timezone: "UTC",
    client_schedule_id: crypto.randomUUID(),
  };
  const schema = z.object({ schedule: z.object({ id: z.uuid() }) });
  const first = schema.parse(await (await request("/v1/schedules", client, body)).json());
  const repeated = schema.parse(await (await request("/v1/schedules", client, body)).json());
  expect(first.schedule.id).toBe(repeated.schedule.id);
  const cancelled = schema.parse(
    await (
      await request("/v1/schedules", client, {
        ...body,
        client_schedule_id: crypto.randomUUID(),
        objective: "cancelled",
      })
    ).json(),
  );
  await request(`/v1/schedules/${cancelled.schedule.id}`, client, undefined, "DELETE");
  // When two dispatchers race.
  await Promise.all([dispatchDueSchedules(sql), dispatchDueSchedules(sql)]);
  // Then only one wake message exists.
  const result = z
    .object({ messages: z.array(Message) })
    .parse(await (await request(`/v1/conversations/${c.id}/messages`)).json());
  expect(result.messages.map((m) => m.content)).toEqual(["wake"]);
});
test("memory deletion suppresses re-extraction and isolates workspaces", async () => {
  // Given a memory derived from a user message.
  const { message } = await newTask();
  const body = { text: "preference", source_message_id: message.id };
  const created = z
    .object({ memory: z.object({ id: z.uuid() }) })
    .parse(await (await request("/v1/memory", client, body)).json());
  // When user deletes it.
  expect(
    (await request(`/v1/memory/${created.memory.id}`, client, undefined, "DELETE")).status,
  ).toBe(200);
  // Then it cannot be extracted again or read by another workspace.
  expect((await request("/v1/memory", client, body)).status).toBe(409);
  expect(
    z
      .object({ memories: z.array(z.unknown()) })
      .parse(await (await request("/v1/memory", alienToken)).json()).memories,
  ).toEqual([]);
});
