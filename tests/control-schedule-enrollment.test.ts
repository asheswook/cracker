import { expect, test } from "bun:test";
import { z } from "zod";
import { DaemonPoll, Message } from "../packages/protocol";
import { Schedule } from "../services/control/repository/schedule-enrollment";
import { dispatchDueSchedules } from "../services/control/repository/schedules";
import { controlFixture } from "./control-fixture";

const { sql, request, client, machine, workspace, newConversation, finishActive } =
  controlFixture();
const envelope = z.object({ schedule: Schedule });
async function active() {
  await finishActive();
  const conversation = await newConversation();
  const content = "Remind me in one minute to review the deployment.";
  const source = z.object({ message: Message }).parse(
    await (
      await request(`/v1/conversations/${conversation.id}/messages`, client, {
        client_message_id: crypto.randomUUID(),
        content,
      })
    ).json(),
  ).message;
  const run = DaemonPoll.parse(await (await request("/v1/daemon/poll", machine)).json()).assignment;
  if (!run) throw new Error("Expected claimed run");
  return {
    conversation,
    source,
    run,
    body: {
      run_id: run.run_id,
      client_schedule_id: crypto.randomUUID(),
      objective: "Review the deployment",
      due_at: new Date(Date.now() + 60000).toISOString(),
      timezone: "Asia/Seoul",
      source_message_id: source.id,
      source_quote: content,
    },
  };
}
test("real user request persists once and wakes as machine provenance without duplicating", async () => {
  const context = await active();
  const first = await request("/v1/daemon/schedules", machine, context.body);
  expect(first.status).toBe(200);
  const saved = envelope.parse(await first.json()).schedule;
  const repeated = envelope.parse(
    await (await request("/v1/daemon/schedules", machine, context.body)).json(),
  ).schedule;
  expect(repeated.id).toBe(saved.id);
  expect(saved.status).toBe("pending");
  expect(saved.source_message_id).toBe(context.source.id);
  expect(
    (await request("/v1/daemon/schedules", machine, { ...context.body, objective: "different" }))
      .status,
  ).toBe(409);
  await finishActive();
  await sql`UPDATE assistant.schedules SET due_at=now()-interval '1 second' WHERE id=${saved.id}`;
  await dispatchDueSchedules(sql);
  await dispatchDueSchedules(sql);
  const rows = z
    .array(Message)
    .parse(
      await sql`SELECT * FROM assistant.messages WHERE workspace_id=${workspace} AND client_message_id=${saved.id}`,
    );
  expect(rows).toHaveLength(1);
  expect(rows[0]?.role).toBe("system");
  expect(rows[0]?.content).toBe(context.body.objective);
  const wake = DaemonPoll.parse(
    await (await request("/v1/daemon/poll", machine)).json(),
  ).assignment;
  expect(wake?.task.objective).toBe(context.body.objective);
  expect(wake?.messages.some((message) => message.role === "system")).toBe(true);
});
test("rejects assistant claims, forged spans, alien conversation and stale run", async () => {
  const context = await active();
  const assistant = crypto.randomUUID();
  await sql`INSERT INTO assistant.messages(id,workspace_id,conversation_id,role,content) VALUES(${assistant},${workspace},${context.conversation.id},'assistant',${context.body.source_quote})`;
  for (const patch of [
    { source_message_id: assistant },
    { source_quote: "not present" },
    { run_id: crypto.randomUUID() },
  ]) {
    expect(
      (await request("/v1/daemon/schedules", machine, { ...context.body, ...patch })).status,
    ).toBeGreaterThanOrEqual(400);
  }
  const other = await newConversation();
  const source = z.object({ message: Message }).parse(
    await (
      await request(`/v1/conversations/${other.id}/messages`, client, {
        client_message_id: crypto.randomUUID(),
        content: context.body.source_quote,
      })
    ).json(),
  ).message;
  expect(
    (
      await request("/v1/daemon/schedules", machine, {
        ...context.body,
        source_message_id: source.id,
      })
    ).status,
  ).toBe(409);
  await finishActive();
  expect((await request("/v1/daemon/schedules", machine, context.body)).status).toBe(409);
});
test("cancelled reservations stay cancelled on replay and never wake", async () => {
  const context = await active();
  const saved = envelope.parse(
    await (await request("/v1/daemon/schedules", machine, context.body)).json(),
  ).schedule;
  await request(`/v1/schedules/${saved.id}`, client, undefined, "DELETE");
  expect(
    envelope.parse(await (await request("/v1/daemon/schedules", machine, context.body)).json())
      .schedule.status,
  ).toBe("cancelled");
  await sql`UPDATE assistant.schedules SET due_at=now()-interval '1 second' WHERE id=${saved.id}`;
  await dispatchDueSchedules(sql);
  expect(
    await sql`SELECT id FROM assistant.messages WHERE client_message_id=${saved.id}`,
  ).toHaveLength(0);
});

test("completion cannot skip a scheduled system wake that arrived during the active run", async () => {
  const context = await active();
  const saved = envelope.parse(
    await (await request("/v1/daemon/schedules", machine, context.body)).json(),
  ).schedule;
  const event = (body: unknown) => request("/v1/daemon/events", machine, body);
  expect(
    (
      await event({
        kind: "input_applied",
        event_id: crypto.randomUUID(),
        run_id: context.run.run_id,
        message_id: context.source.id,
      })
    ).status,
  ).toBe(200);
  await sql`UPDATE assistant.schedules SET due_at=now()-interval '1 second' WHERE id=${saved.id}`;
  await dispatchDueSchedules(sql);
  const completed = () =>
    event({
      kind: "state",
      event_id: crypto.randomUUID(),
      run_id: context.run.run_id,
      state: "succeeded",
      reason: null,
    });
  expect((await completed()).status).toBe(409);
  const wake = Message.parse(
    (
      await sql`SELECT * FROM assistant.messages WHERE workspace_id=${workspace} AND client_message_id=${saved.id}`
    )[0],
  );
  expect(
    (
      await event({
        kind: "input_applied",
        event_id: crypto.randomUUID(),
        run_id: context.run.run_id,
        message_id: wake.id,
      })
    ).status,
  ).toBe(200);
  expect((await completed()).status).toBe(200);
});
