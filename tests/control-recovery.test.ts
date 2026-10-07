import { expect, test } from "bun:test";
import { z } from "zod";
import { Command, Conversation, DaemonPoll } from "../packages/protocol";
import { quarantineStaleRuns } from "../services/control/repository/recovery";
import { controlFixture } from "./control-fixture";

const { sql, app, vm, client, machine, alien, request, newConversation, newTask, finishActive } =
  controlFixture();
test("completion rejects unconsumed input and accepts after explicit receipts", async () => {
  // Given an active task with an unapplied user input.
  await finishActive();
  const initial = await newTask();
  const polled = DaemonPoll.parse(await (await request("/v1/daemon/poll", machine)).json());
  if (!polled.assignment) throw new Error("missing assignment");
  const run_id = polled.assignment.run_id;
  const state = {
    kind: "state",
    event_id: crypto.randomUUID(),
    run_id,
    state: "succeeded",
    reason: null,
  };
  // When completion races ahead of input application.
  const rejected = await request("/v1/daemon/events", machine, state);
  // Then completion is rejected until durable input receipt exists.
  expect(rejected.status).toBe(409);
  expect(
    z.object({ error: z.object({ code: z.string() }) }).parse(await rejected.json()).error.code,
  ).toBe("pending_input");
  expect(
    (
      await request("/v1/daemon/events", machine, {
        kind: "input_applied",
        event_id: crypto.randomUUID(),
        run_id,
        message_id: initial.message.id,
      })
    ).status,
  ).toBe(200);
  expect((await request("/v1/daemon/events", machine, state)).status).toBe(200);
});
test("takeover is pending until ACK and return creates a fresh run", async () => {
  // Given active task and a takeover command.
  await finishActive();
  await newTask();
  const first = DaemonPoll.parse(await (await request("/v1/daemon/poll", machine)).json());
  if (!first.assignment) throw new Error("missing run");
  const commandSchema = z.object({ command: Command });
  const takeover = commandSchema.parse(
    await (await request(`/v1/vms/${vm}/control`, client, { kind: "takeover" })).json(),
  ).command;
  expect(
    z
      .object({ control_state: z.string() })
      .parse((await sql`SELECT control_state FROM vms WHERE id=${vm}`)[0]).control_state,
  ).toBe("switching");
  // When the daemon verifies takeover and return.
  expect(
    (
      await request("/v1/daemon/events", machine, {
        kind: "command_ack",
        event_id: crypto.randomUUID(),
        command_id: takeover.id,
        resume_safe: true,
        status: "applied",
        detail: "tools paused",
      })
    ).status,
  ).toBe(200);
  const returned = commandSchema.parse(
    await (await request(`/v1/vms/${vm}/control`, client, { kind: "return_control" })).json(),
  ).command;
  expect(
    (
      await request("/v1/daemon/events", machine, {
        kind: "command_ack",
        event_id: crypto.randomUUID(),
        command_id: returned.id,
        status: "applied",
        detail: "agent resumed",
      })
    ).status,
  ).toBe(200);
  // Then a fresh run is assigned, never the old journal.
  const next = DaemonPoll.parse(await (await request("/v1/daemon/poll", machine)).json());
  expect(next.assignment?.task.id).toBe(first.assignment.task.id);
  expect(next.assignment?.run_id).not.toBe(first.assignment.run_id);
});
test("enforces cross-workspace foreign keys below the HTTP boundary", async () => {
  // Given a conversation from workspace A.
  const c = await newConversation();
  // When SQL attempts a task referencing it from workspace B.
  let code = "";
  try {
    await sql`INSERT INTO tasks(workspace_id,conversation_id,objective) VALUES(${alien},${c.id},'invalid')`;
  } catch (error) {
    if (error instanceof Error && "code" in error) code = z.string().parse(error.code);
    else throw error;
  }
  // Then PostgreSQL itself rejects the cross-tenant link.
  expect(code).toBe("23503");
});
test("records durable journal and outbox with same-event dedupe", async () => {
  // Given a daemon heartbeat event.
  const event = { kind: "heartbeat", event_id: crypto.randomUUID() };
  // When retried at the event endpoint.
  await request("/v1/daemon/events", machine, event);
  await request("/v1/daemon/events", machine, event);
  // Then there is exactly one ingress journal row plus one durable outbound event.
  const rows =
    await sql`SELECT count(*)::integer AS count FROM events WHERE event_id=${event.event_id}`;
  expect(z.object({ count: z.number() }).parse(rows[0]).count).toBe(1);
  const outbox =
    await sql`SELECT count(*)::integer AS count FROM outbox o JOIN events e ON e.id=o.event_id WHERE e.payload->>'event_id'=${event.event_id}`;
  expect(z.object({ count: z.number() }).parse(outbox[0]).count).toBe(1);
});
test("serves authenticated conversation over a real listening HTTP socket", async () => {
  // Given the actual HTTP app listening on an ephemeral port.
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  try {
    // When a network client creates a conversation.
    const response = await fetch(new URL("/v1/conversations", server.url), {
      method: "POST",
      headers: { Authorization: `Bearer ${client}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "network transport" }),
    });
    // Then HTTP returns the persisted conversation contract.
    expect(response.status).toBe(201);
    expect(
      z.object({ conversation: Conversation }).parse(await response.json()).conversation.title,
    ).toBe("network transport");
  } finally {
    await server.stop(true);
  }
});

test("expired heartbeat quarantines run without making it available for another VM", async () => {
  // Given an active run whose VM heartbeat expired.
  await finishActive();
  const initial = await newTask();
  await request("/v1/daemon/poll", machine);
  await sql`UPDATE vms SET last_seen_at=now()-interval '10 minutes' WHERE id=${vm}`;
  // When the recovery sweep runs.
  await quarantineStaleRuns(sql);
  // Then source-of-truth state is unknown rather than queued.
  expect(
    z
      .object({ state: z.string() })
      .parse((await sql`SELECT state FROM tasks WHERE id=${initial.task.id}`)[0]).state,
  ).toBe("unknown");
});
test("queued stop confirms cancellation without claiming VM execution was stopped", async () => {
  // Given a queued task with no run.
  await finishActive();
  const initial = await newTask();
  // When user stops it before assignment.
  const response = await request(`/v1/tasks/${initial.task.id}/stop`, client, {});
  // Then cancellation is final with no VM command fabricated.
  expect(response.status).toBe(200);
  expect(z.object({ command: z.null() }).parse(await response.json()).command).toBeNull();
  expect(
    z
      .object({ state: z.string() })
      .parse((await sql`SELECT state FROM tasks WHERE id=${initial.task.id}`)[0]).state,
  ).toBe("cancelled");
});
