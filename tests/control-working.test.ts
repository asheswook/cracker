import { expect, test } from "bun:test";
import { z } from "zod";
import { DaemonPoll, Message, Task } from "../packages/protocol";
import { workingState } from "../services/control/repository/working";
import { controlFixture } from "./control-fixture";

const f = controlFixture();
const Page = z.object({
  working: z.object({
    task_id: z.uuid(), run_id: z.uuid(), input_message_id: z.uuid(), expires_at: z.iso.datetime(),
  }).nullable(),
  composing: z.unknown().nullable(),
});

async function setup(applied = true) {
  await f.finishActive();
  await f.sql`UPDATE assistant.commands SET status='applied' WHERE vm_id=${f.vm} AND status='pending'`;
  await f.sql`UPDATE assistant.vms SET control_state='agent' WHERE id=${f.vm}`;
  const task = await f.newTask();
  const assignment = DaemonPoll.parse(await (await f.request("/v1/daemon/poll", f.machine)).json()).assignment;
  if (!assignment) throw new TypeError("No assignment");
  const run = assignment.run_id;
  const path = `/v1/conversations/${task.message.conversation_id}/messages`;
  const read = async (message = task.message.id) => {
    const response = await f.request("/v1/daemon/events", f.machine, {
      kind: "input_applied", run_id: run, event_id: crypto.randomUUID(), message_id: message,
    });
    expect(response.status).toBe(200);
  };
  const page = async () => {
    const response = await f.request(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    return Page.parse(await response.json());
  };
  if (applied) await read();
  return { task, run, path, read, page };
}

test("working returns bounded applied-input execution without a composing signal", async () => {
  // Given
  const s = await setup();
  const before = Date.now();
  // When
  const page = await s.page();
  // Then
  expect(page.working).toMatchObject({ task_id: s.task.task.id, run_id: s.run, input_message_id: s.task.message.id });
  expect(page.composing).toBeNull();
  if (!page.working) throw new TypeError("Missing working snapshot");
  expect(Date.parse(page.working.expires_at)).toBeGreaterThan(before);
  expect(Date.parse(page.working.expires_at)).toBeLessThanOrEqual(Date.now() + 5000);
});

test("working stays absent until input is applied", async () => {
  // Given
  const s = await setup(false);
  // When
  const page = await s.page();
  // Then
  expect(page.working).toBeNull();
});

test("working rejects a historical receipt without application timestamp", async () => {
  // Given
  const s = await setup();
  await f.sql`UPDATE assistant.input_receipts SET applied_at=NULL WHERE run_id=${s.run}`;
  // When
  const page = await s.page();
  // Then
  expect(page.working).toBeNull();
});

for (const state of ["queued", "waiting", "pausing", "paused", "cancelling", "cancelled", "succeeded", "failed", "unknown"] as const) {
  for (const source of ["task", "run"] as const) {
    test(`working clears when ${source} is ${state}`, async () => {
      // Given
      const s = await setup();
      if (source === "task") await f.sql`UPDATE assistant.tasks SET state=${state} WHERE id=${s.task.task.id}`;
      else await f.sql`UPDATE assistant.runs SET state=${state} WHERE id=${s.run}`;
      // When
      const page = await s.page();
      // Then
      expect(page.working).toBeNull();
    });
  }
}

for (const state of ["switching", "unknown"] as const) {
  test(`working clears when VM control is ${state}`, async () => {
    // Given
    const s = await setup();
    await f.sql`UPDATE assistant.vms SET control_state=${state} WHERE id=${f.vm}`;
    // When
    const page = await s.page();
    // Then
    expect(page.working).toBeNull();
  });
}

test("working clears when VM liveness is stale", async () => {
  // Given
  const s = await setup();
  await f.sql`UPDATE assistant.vms SET last_seen_at=now()-interval '61 seconds' WHERE id=${f.vm}`;
  // When
  const page = await s.page();
  // Then
  expect(page.working).toBeNull();
});

test("working clears when VM liveness is missing", async () => {
  // Given
  const s = await setup();
  await f.sql`UPDATE assistant.vms SET last_seen_at=NULL WHERE id=${f.vm}`;
  // When
  const page = await s.page();
  // Then
  expect(page.working).toBeNull();
});

test("working expiry cannot outlive the VM liveness deadline", async () => {
  // Given
  const s = await setup();
  const row = z.object({ expires_at: z.string() }).parse((await f.sql`
    UPDATE assistant.vms SET last_seen_at=now()-interval '58 seconds' WHERE id=${f.vm}
    RETURNING last_seen_at+interval '60 seconds' AS expires_at`)[0]);
  // When
  const page = await s.page();
  // Then
  expect(page.working?.expires_at).toBe(row.expires_at);
});

for (const kind of ["stop", "takeover", "return_control"] as const) {
  test(`working clears immediately for a pending ${kind} before daemon acknowledgement`, async () => {
    // Given
    const s = await setup();
    await f.sql`INSERT INTO assistant.commands(workspace_id,vm_id,task_id,run_id,kind)
      VALUES(${f.workspace},${f.vm},${s.task.task.id},${s.run},${kind})`;
    // When
    const page = await s.page();
    // Then
    expect(page.working).toBeNull();
  });
}

for (const applied of [false, true]) {
  test(`working follows latest steering only when applied in the current run: ${applied}`, async () => {
    // Given
    const s = await setup();
    const steering = z.object({ message: Message, task: Task }).parse(await (await f.request(s.path, f.client, {
      content: "steering", client_message_id: crypto.randomUUID(),
    })).json());
    expect(steering.task.id).toBe(s.task.task.id);
    if (applied) await s.read(steering.message.id);
    // When
    const page = await s.page();
    // Then
    if (applied) expect(page.working?.input_message_id).toBe(steering.message.id);
    else expect(page.working).toBeNull();
  });
}

test("working ignores a pending stop for an unrelated completed task", async () => {
  // Given
  const old = await setup();
  const current = await setup();
  await f.sql`INSERT INTO assistant.commands(workspace_id,vm_id,task_id,run_id,kind)
    VALUES(${f.workspace},${f.vm},${old.task.task.id},${old.run},'stop')`;
  // When
  const page = await current.page();
  // Then
  expect(page.working?.run_id).toBe(current.run);
});

test("working cannot inherit a read receipt from a prior run", async () => {
  // Given
  const s = await setup();
  await f.sql`UPDATE assistant.runs SET state='succeeded' WHERE id=${s.run}`;
  await f.sql`INSERT INTO assistant.runs(workspace_id,task_id,vm_id) VALUES(${f.workspace},${s.task.task.id},${f.vm})`;
  // When
  const page = await s.page();
  // Then
  expect(page.working).toBeNull();
});

test("working does not bleed into a different conversation", async () => {
  // Given
  await setup();
  const other = await f.newConversation();
  // When
  const page = Page.parse(await (await f.request(`/v1/conversations/${other.id}/messages`)).json());
  // Then
  expect(page.working).toBeNull();
});

test("working repository scopes the snapshot to its workspace", async () => {
  // Given
  const s = await setup();
  // When
  const state = await workingState(f.sql, f.alien, s.task.message.conversation_id);
  // Then
  expect(state).toBeNull();
});

test("working endpoint denies another workspace", async () => {
  // Given
  const s = await setup();
  // When
  const response = await f.request(s.path, f.alienToken);
  // Then
  expect(response.status).toBe(404);
});
