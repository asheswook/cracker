import { beforeEach, expect, test } from "bun:test";
import { DaemonPoll } from "../packages/protocol";
import { controlFixture } from "./control-fixture";

const f = controlFixture();
const safeReason =
  "Invalid provider response: invalid_tool_arguments; no calls from that response were executed";
const poll = async (run?: string) =>
  DaemonPoll.parse(
    await (await f.request(`/v1/daemon/poll${run ? `?run_id=${run}` : ""}`, f.machine)).json(),
  );
beforeEach(async () => {
  await f.finishActive();
  await f.sql`UPDATE assistant.commands SET status='applied' WHERE vm_id=${f.vm}`;
  await f.sql`UPDATE assistant.vms SET control_state='agent' WHERE id=${f.vm}`;
});
async function unknown(
  reason = "Control disconnected during execution; reconcile interrupted effects before resuming",
) {
  const input = await f.newTask();
  const assignment = (await poll()).assignment;
  if (!assignment) throw new TypeError("Expected initial assignment");
  expect((await f.request("/v1/daemon/events", f.machine, {
    kind: "input_applied", event_id: crypto.randomUUID(), run_id: assignment.run_id, message_id: input.message.id,
  })).status).toBe(200);
  expect(
    (
      await f.request("/v1/daemon/events", f.machine, {
        kind: "state",
        event_id: crypto.randomUUID(),
        run_id: assignment.run_id,
        state: "unknown",
        reason,
      })
    ).status,
  ).toBe(200);
  return { ...input, run: assignment.run_id };
}
async function followup(task: { readonly conversation_id: string }) {
  return f.request(`/v1/conversations/${task.conversation_id}/messages`, f.client, {
    client_message_id: crypto.randomUUID(),
    content: "retry",
  });
}

test("unrelated queued task runs while historical unknown and its followup stay quarantined", async () => {
  const old = await unknown();
  const before = Array.from(await f.sql`SELECT * FROM assistant.runs WHERE id=${old.run}`);
  const response = await followup(old.task);
  expect((await response.json()).task.id).toBe(old.task.id);
  const queued = await f.newTask();
  const next = await poll();
  expect(next.assignment?.task.id).toBe(queued.task.id);
  expect(Array.from(await f.sql`SELECT * FROM assistant.runs WHERE id=${old.run}`)).toEqual(before);
  expect(
    (await f.sql`SELECT state,reason FROM assistant.tasks WHERE id=${old.task.id}`)[0],
  ).toEqual({
    state: "unknown",
    reason: "Control disconnected during execution; reconcile interrupted effects before resuming",
  });
  expect(
    (await f.request(`/v1/daemon/resume/${old.run}`, f.machine, { checkpoint_cursor: 0 })).status,
  ).toBe(409);
  if (!next.assignment) throw new TypeError("Expected unrelated assignment");
  expect(
    (await poll(next.assignment.run_id)).messages.every(
      (m) => m.conversation_id === queued.task.conversation_id,
    ),
  ).toBe(true);
  expect(
    (await f.sql`SELECT state FROM assistant.runs WHERE id=${next.assignment.run_id}`)[0]?.[
      "state"
    ],
  ).toBe("running");
});

test("unknown work does not bypass user control, pending commands, or a paused known run", async () => {
  await unknown();
  await f.newTask();
  for (const state of ["user", "switching", "unknown"]) {
    await f.sql`UPDATE assistant.vms SET control_state=${state} WHERE id=${f.vm}`;
    expect((await poll()).assignment).toBeNull();
  }
  await f.sql`UPDATE assistant.vms SET control_state='agent' WHERE id=${f.vm}`;
  const command = crypto.randomUUID();
  await f.sql`INSERT INTO assistant.commands(id,workspace_id,vm_id,kind) VALUES(${command},${f.workspace},${f.vm},'takeover')`;
  expect((await poll()).assignment).toBeNull();
  await f.sql`UPDATE assistant.commands SET status='applied' WHERE id=${command}`;
  const assigned = (await poll()).assignment;
  expect(assigned).not.toBeNull();
  if (!assigned) throw new TypeError("Expected assignment");
  await f.sql`UPDATE assistant.runs SET state='paused' WHERE id=${assigned.run_id}`;
  await f.sql`UPDATE assistant.tasks SET state='paused' WHERE id=${assigned.task.id}`;
  await f.newTask();
  expect((await poll()).assignment).toBeNull();
  expect(
    (await f.sql`SELECT state FROM assistant.runs WHERE id=${assigned.run_id}`)[0]?.["state"],
  ).toBe("paused");
});

test("validation recovery waits for unrelated active slot and is discovered behind older unknown", async () => {
  await unknown();
  const recoverable = await unknown(safeReason);
  const queued = await f.newTask();
  const active = (await poll()).assignment;
  expect(active?.task.id).toBe(queued.task.id);
  if (!active) throw new TypeError("Expected active run");
  await followup(recoverable.task);
  const resumed = await f.request(`/v1/daemon/resume/${recoverable.run}`, f.machine, {
    checkpoint_cursor: recoverable.message.sequence,
  });
  expect(resumed.status).toBe(409);
  expect((await resumed.json()).error.code).toBe("run_busy");
  expect((await poll(active.run_id)).recovery_run_id).toBeUndefined();
  await f.sql`UPDATE assistant.runs SET state='succeeded' WHERE id=${active.run_id}`;
  await f.sql`UPDATE assistant.tasks SET state='succeeded' WHERE id=${active.task.id}`;
  expect((await poll()).recovery_run_id).toBe(recoverable.run);
  expect(
    (
      await f.request(`/v1/daemon/resume/${recoverable.run}`, f.machine, {
        checkpoint_cursor: recoverable.message.sequence,
      })
    ).status,
  ).toBe(200);
});

test("concurrent idle polls assign exactly one run around historical unknown", async () => {
  await unknown();
  await f.newTask();
  await f.newTask();
  const results = await Promise.all(Array.from({ length: 4 }, () => poll()));
  expect(results.filter((result) => result.assignment).length).toBe(1);
  expect(
    Number(
      (
        await f.sql`SELECT count(*) AS count FROM assistant.runs WHERE vm_id=${f.vm} AND state NOT IN ('succeeded','failed','cancelled')`
      )[0]?.["count"],
    ),
  ).toBe(2);
});

test("followups to unknown and paused tasks preserve explicit user computer ownership", async () => {
  const old = await unknown();
  await f.newTask();
  const active = (await poll()).assignment;
  if (!active) throw new TypeError("Expected active run");
  await f.sql`UPDATE assistant.runs SET state='paused' WHERE id=${active.run_id}`;
  await f.sql`UPDATE assistant.tasks SET state='paused' WHERE id=${active.task.id}`;
  await f.sql`UPDATE assistant.vms SET control_state='user' WHERE id=${f.vm}`;
  await followup(old.task);
  expect(
    (await f.sql`SELECT control_state FROM assistant.vms WHERE id=${f.vm}`)[0]?.["control_state"],
  ).toBe("user");
  expect(
    await f.sql`SELECT id FROM assistant.commands WHERE vm_id=${f.vm} AND status='pending'`,
  ).toHaveLength(0);
  await followup(active.task);
  expect(
    (await f.sql`SELECT control_state FROM assistant.vms WHERE id=${f.vm}`)[0]?.["control_state"],
  ).toBe("user");
  expect(await f.sql`SELECT id FROM assistant.commands WHERE vm_id=${f.vm} AND status='pending'`).toHaveLength(0);
});

test("commands-only observer never claims or quarantines work without run identity", async () => {
  await unknown();
  const queued = await f.newTask();
  expect((await f.request("/v1/daemon/poll?view=commands", f.machine)).status).toBe(200);
  expect(
    (await f.sql`SELECT state FROM assistant.tasks WHERE id=${queued.task.id}`)[0]?.["state"],
  ).toBe("queued");
  const active = (await poll()).assignment;
  if (!active) throw new TypeError("Expected active run");
  await f.request("/v1/daemon/poll?view=commands", f.machine);
  expect(
    (await f.sql`SELECT state FROM assistant.runs WHERE id=${active.run_id}`)[0]?.["state"],
  ).toBe("running");
});

test("concurrent resume and idle poll share one VM execution slot", async () => {
  const old = await unknown(safeReason);
  await followup(old.task);
  await f.newTask();
  const results = await Promise.all([
    f.request(`/v1/daemon/resume/${old.run}`, f.machine, {
      checkpoint_cursor: old.message.sequence,
    }),
    poll(),
  ]);
  const winner = results[1].assignment;
  expect(results[0].status).toBe(winner ? 409 : 200);
  expect(
    Array.from(await f.sql`SELECT id FROM assistant.runs WHERE vm_id=${f.vm} AND state='running'`),
  ).toEqual([{ id: winner?.run_id ?? old.run }]);
});

test("late poll for historical unknown cannot quarantine unrelated current run", async () => {
  const old = await unknown();
  await f.newTask();
  const active = (await poll()).assignment;
  if (!active) throw new TypeError("Expected active run");
  expect((await poll(old.run)).messages).toHaveLength(0);
  expect(
    (await f.sql`SELECT state FROM assistant.runs WHERE id=${active.run_id}`)[0]?.["state"],
  ).toBe("running");
});

test("idle poll skips a busy VM row instead of waiting with a stale run identity", async () => {
  await unknown();
  const queued = await f.newTask();
  const locked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const holder = f.sql.begin(async (tx) => {
    await tx`SELECT id FROM assistant.vms WHERE id=${f.vm} FOR UPDATE`;
    locked.resolve();
    await release.promise;
  });
  await locked.promise;
  try {
    const skipped = await poll();
    expect(skipped.assignment).toBeNull();
    expect(
      (await f.sql`SELECT state FROM assistant.tasks WHERE id=${queued.task.id}`)[0]?.["state"],
    ).toBe("queued");
  } finally {
    release.resolve();
    await holder;
  }
  expect((await poll()).assignment?.task.id).toBe(queued.task.id);
});

test("queued unrelated work takes priority over recovery without proof of a local checkpoint", async () => {
  const old = await unknown(safeReason);
  await followup(old.task);
  const queued = await f.newTask();
  const result = await poll();
  expect(result.assignment?.task.id).toBe(queued.task.id);
  expect(result.recovery_run_id).toBeUndefined();
  expect((await f.sql`SELECT state FROM assistant.runs WHERE id=${old.run}`)[0]?.["state"]).toBe(
    "unknown",
  );
  if (!result.assignment) throw new TypeError("Expected queued assignment");
  await f.sql`UPDATE assistant.runs SET state='succeeded' WHERE id=${result.assignment.run_id}`;
  await f.sql`UPDATE assistant.tasks SET state='succeeded' WHERE id=${queued.task.id}`;
  expect((await poll()).recovery_run_id).toBe(old.run);
});
