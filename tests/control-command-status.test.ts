import { expect, test } from "bun:test";
import { z } from "zod";
import { Command, DaemonPoll } from "../packages/protocol";
import { controlFixture } from "./control-fixture";

const { sql, app, workspace, vm, client, machine, alienToken, request, newTask, finishActive } =
  controlFixture();
const Receipt = Command.extend({
  vm_id: z.uuid(),
  status: z.enum(["pending", "applied", "failed"]),
  detail: z.string().nullable(),
  acked_at: z.string().nullable(),
});
for (const status of ["applied", "failed"] as const)
  test(`scoped command receipt remains pending until ${status} ACK`, async () => {
    // Given an owned control command and unrelated credentials.
    const created = await request(`/v1/vms/${vm}/control`, client, { kind: "takeover" });
    const command = z.object({ command: Command }).parse(await created.json()).command;
    const path = `/v1/commands/${command.id}`;
    const pendingResponse = await request(path);
    const pending = z.object({ command: Receipt }).parse(await pendingResponse.json()).command;
    expect(pending).toMatchObject({
      ...command,
      vm_id: vm,
      status: "pending",
      detail: null,
      acked_at: null,
    });
    expect(pendingResponse.headers.get("cache-control")).toBe("no-store");
    expect((await app.request(path)).status).toBe(401);
    expect((await request(path, alienToken)).status).toBe(404);
    expect((await request(path, machine)).status).toBe(403);
    expect((await request(`/v1/commands/${crypto.randomUUID()}`)).status).toBe(404);
    // When the owning daemon records a confirmed outcome.
    expect(
      (
        await request("/v1/daemon/events", machine, {
          kind: "command_ack",
          event_id: crypto.randomUUID(),
          command_id: command.id,
          status,
          detail: `verified ${status}`,
          resume_safe: false,
        })
      ).status,
    ).toBe(200);
    // Then only the ACK makes the receipt terminal and supplies its timestamp/detail.
    const terminal = z
      .object({ command: Receipt })
      .parse(await (await request(path)).json()).command;
    expect(terminal.status).toBe(status);
    expect(terminal.detail).toBe(`verified ${status}`);
    expect(terminal.acked_at).not.toBeNull();
    expect(Date.parse(terminal.acked_at ?? "")).toBeGreaterThanOrEqual(
      Date.parse(terminal.created_at),
    );
    await sql`UPDATE assistant.vms SET control_state='agent' WHERE id=${vm} AND workspace_id=${workspace}`;
  });
test("commands-only active poll preserves receipts but excludes context; default remains full", async () => {
  // Given an assigned task and a pending stop command.
  await finishActive();
  const initial = await newTask();
  const claimed = DaemonPoll.parse(await (await request("/v1/daemon/poll", machine)).json());
  expect(claimed.assignment?.task.id).toBe(initial.task.id);
  expect(claimed.assignment?.messages).toHaveLength(1);
  if (!claimed.assignment) throw new Error("Missing assignment");
  const stop = z
    .object({ command: Command })
    .parse(await (await request(`/v1/tasks/${initial.task.id}/stop`, client, {})).json()).command;
  // When polling only commands for that active run.
  const queries: string[] = [];
  const previousDebug = sql.options.debug;
  sql.options.debug = (_connection, query) => {
    queries.push(query);
  };
  try {
    const lean = DaemonPoll.parse(
      await (
        await request(`/v1/daemon/poll?run_id=${claimed.assignment.run_id}&view=commands`, machine)
      ).json(),
    );
    expect(lean).toEqual({ assignment: null, commands: [stop], messages: [] });
  } finally {
    sql.options.debug = previousDebug;
  }
  // Then actual SQL dispatch performs no message, instruction or memory context reads.
  expect(queries.length).toBeGreaterThan(0);
  const contextQueries = queries.filter((query) =>
    /assistant\.(messages|message_attachments|memories|memory_assertions|memory_contexts|workspaces)\b/.test(
      query,
    ),
  );
  expect(contextQueries).toHaveLength(0);
  console.log(
    JSON.stringify({
      scenario: "commands_poll_sql",
      statements: queries.length,
      context_statements: contextQueries.length,
    }),
  );
  const full = DaemonPoll.parse(
    await (await request(`/v1/daemon/poll?run_id=${claimed.assignment.run_id}`, machine)).json(),
  );
  expect(full.messages.map((m) => m.id)).toContain(initial.message.id);
  const receipt = z
    .object({ command: Receipt })
    .parse(await (await request(`/v1/commands/${stop.id}`)).json()).command;
  expect(receipt.task_id).toBe(initial.task.id);
  expect(receipt.status).toBe("pending");
  expect((await request("/v1/daemon/poll?view=garbage", machine)).status).toBe(400);
  await request("/v1/daemon/events", machine, {
    kind: "command_ack",
    event_id: crypto.randomUUID(),
    command_id: stop.id,
    status: "applied",
    detail: "stopped",
  });
});
test("commands-only polling retains current-run mismatch quarantine", async () => {
  // Given a running task and its assignment.
  await finishActive();
  const initial = await newTask();
  const assigned = DaemonPoll.parse(await (await request("/v1/daemon/poll", machine)).json());
  expect(assigned.assignment).not.toBeNull();
  // When the daemon supplies the wrong active-run identity in the optimized mode.
  const result = DaemonPoll.parse(
    await (
      await request(`/v1/daemon/poll?view=commands&run_id=${crypto.randomUUID()}`, machine)
    ).json(),
  );
  // Then no input/assignment is returned and uncertain work is quarantined, never replayed.
  expect(result).toEqual({ assignment: null, commands: [], messages: [] });
  const state = z
    .object({ state: z.string() })
    .parse((await sql`SELECT state FROM assistant.tasks WHERE id=${initial.task.id}`)[0]);
  expect(state.state).toBe("unknown");
});
