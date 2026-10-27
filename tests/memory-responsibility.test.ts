import { beforeAll, afterAll, test, expect } from "bun:test";
import { z } from "zod";
import { createDatabase } from "../services/control/db.ts";
import { createApp } from "../services/control/app.ts";
import { hashToken } from "../services/control/auth.ts";
import { createResponsibility, dueResponsibilities, recordEvaluation, snapshot, ResponsibilityRow } from "../packages/memory/responsibility-store.ts";
import { ResponsibilityInput, quietNow } from "../packages/memory/responsibility-schema.ts";
import { dispatchActions } from "../packages/memory/responsibility-actions.ts";
const sql = createDatabase(process.env["TEST_DATABASE_URL"] ?? "postgres://assistant:assistant@127.0.0.1:55439/assistant_dev");
const workspace = crypto.randomUUID(), vm = crypto.randomUUID(), clientToken = crypto.randomUUID() + crypto.randomUUID(), machineToken = crypto.randomUUID() + crypto.randomUUID();
const client = { workspace_id: workspace, vm_id: null, role: "client" as const }, machine = { workspace_id: workspace, vm_id: vm, role: "vm" as const };
const app = createApp(sql);
beforeAll(async () => {
  await sql`INSERT INTO assistant.workspaces(id,name) VALUES(${workspace},'responsibility-test')`;
  await sql`INSERT INTO assistant.vms(id,workspace_id,name) VALUES(${vm},${workspace},'responsibility-vm')`;
  await sql`INSERT INTO assistant.credentials(token_hash,workspace_id,role,vm_id) VALUES(${await hashToken(clientToken)},${workspace},'client',NULL),(${await hashToken(machineToken)},${workspace},'vm',${vm})`;
});
afterAll(async () => { await sql.end(); });
async function fixture(mode: "enabled" | "quiet" = "enabled") {
  const conversation = crypto.randomUUID(), task = crypto.randomUUID(), message = crypto.randomUUID();
  await sql`INSERT INTO assistant.conversations(id,workspace_id,title) VALUES(${conversation},${workspace},'responsibility')`;
  await sql`INSERT INTO assistant.tasks(id,workspace_id,conversation_id,objective,state) VALUES(${task},${workspace},${conversation},'watched task','running')`;
  await sql`INSERT INTO assistant.messages(id,workspace_id,conversation_id,task_id,role,content) VALUES(${message},${workspace},${conversation},${task},'user','Notify me once the watched task fails')`;
  const input = ResponsibilityInput.parse({ client_responsibility_id: crypto.randomUUID(), conversation_id: conversation, vm_id: vm, source_message_id: message, source_quote: "Notify me once the watched task fails", objective: "Notify me once the watched task fails", trigger: { kind: "task_change", task_id: task }, notification_mode: mode });
  const row = await createResponsibility(sql, client, input);
  return { row, task, conversation, input };
}
const notify = { outcome: "notify", reason: "Watched task changed", notification: "The watched task needs attention", action_objective: null, next_review_minutes: 60 } as const;
async function scheduledFixture(trigger: z.infer<typeof ResponsibilityInput>["trigger"] = { kind: "deadline", due_at: "2000-01-01T00:00:00Z", timezone: "UTC" }, mode: "enabled" | "quiet" = "enabled") {
  const f = await fixture(mode);
  await sql`UPDATE assistant.responsibilities SET trigger=${JSON.stringify(trigger)}::text::jsonb,next_review_at='2000-01-01T00:00:00Z' WHERE id=${f.row.id}`;
  return { ...f, row: ResponsibilityRow.parse((await sql`SELECT * FROM assistant.responsibilities WHERE id=${f.row.id}`)[0]) };
}
async function scheduledReview(id: string, hour: number, evaluation = notify) {
  await sql`UPDATE assistant.responsibilities SET next_review_at=${`2000-01-01T${String(hour).padStart(2, "0")}:00:00Z`} WHERE id=${id}`;
  const row = ResponsibilityRow.parse((await sql`SELECT * FROM assistant.responsibilities WHERE id=${id}`)[0]);
  const current = await snapshot(sql, row);
  await recordEvaluation(sql, machine, { responsibility_id: id, context_hash: current.context_hash, evaluation });
  return current;
}
test("same creation key reuses one durable responsibility", async () => {
  // Given
  const { row, input } = await fixture();
  // When
  const repeated = await createResponsibility(sql, client, input);
  // Then
  expect(repeated.id).toBe(row.id);
});
test("quiet evaluation persists without a user notification", async () => {
  // Given
  const { row, conversation } = await fixture(), current = await snapshot(sql, row);
  // When
  await recordEvaluation(sql, machine, { responsibility_id: row.id, context_hash: current.context_hash, evaluation: { outcome: "quiet", reason: "No meaningful change", notification: null, action_objective: null, next_review_minutes: 60 } });
  // Then
  expect(z.object({ count: z.coerce.number() }).parse((await sql`SELECT count(*) AS count FROM assistant.messages WHERE conversation_id=${conversation} AND role='assistant'`)[0]).count).toBe(0);
});
test("deadline and periodic quiet evaluations run again for the next scheduled review", async () => {
  for (const trigger of [{ kind: "deadline", due_at: "2000-01-01T00:00:00Z", timezone: "UTC" } as const, { kind: "periodic", interval_minutes: 60 } as const]) {
    const { input } = await fixture();
    const row = await createResponsibility(sql, client, { ...input, client_responsibility_id: crypto.randomUUID(), trigger });
    await sql`UPDATE assistant.responsibilities SET next_review_at='2000-01-01T00:00:00Z' WHERE id=${row.id}`;
    const first = (await dueResponsibilities(sql, machine)).find(item => item.id === row.id);
    if (!first) throw new Error("Missing first review");
    await recordEvaluation(sql, machine, { responsibility_id: row.id, context_hash: first.context_hash, evaluation: { outcome: "quiet", reason: "Still waiting", notification: null, action_objective: null, next_review_minutes: 5 } });
    expect((await sql`SELECT next_review_at>now()+interval '4 minutes' AS scheduled FROM assistant.responsibilities WHERE id=${row.id}`)[0]?.['scheduled']).toBe(true);
    expect((await dueResponsibilities(sql, machine)).some(item => item.id === row.id)).toBe(false);
    // Advance the persisted due occurrence without waiting on the wall clock.
    await sql`UPDATE assistant.responsibilities SET next_review_at='2000-01-01T00:05:00Z' WHERE id=${row.id}`;
    const second = (await dueResponsibilities(sql, machine)).find(item => item.id === row.id);
    if (!second) throw new Error("Missing next review");
    expect(second.context_hash).not.toBe(first.context_hash);
    await recordEvaluation(sql, machine, { responsibility_id: row.id, context_hash: second.context_hash, evaluation: { outcome: "quiet", reason: "Still waiting", notification: null, action_objective: null, next_review_minutes: 5 } });
    expect(await sql`SELECT id FROM assistant.responsibility_evaluations WHERE responsibility_id=${row.id}`).toHaveLength(2);
  }
});
test("unchanged evidence suppresses reworded notifications for 24 hours after delivery, not creation", async () => {
  const { input, conversation } = await fixture();
  const row = await createResponsibility(sql, client, { ...input, client_responsibility_id: crypto.randomUUID(), trigger: { kind: "deadline", due_at: "2000-01-01T00:00:00Z", timezone: "UTC" } });
  const first = await snapshot(sql, row);
  await recordEvaluation(sql, machine, { responsibility_id: row.id, context_hash: first.context_hash, evaluation: notify });
  await sql`UPDATE assistant.responsibility_notifications SET created_at=now()-interval '25 hours' WHERE responsibility_id=${row.id}`;
  await sql`UPDATE assistant.responsibilities SET next_review_at='2000-01-01T01:00:00Z' WHERE id=${row.id}`;
  const second = (await dueResponsibilities(sql, machine)).find(item => item.id === row.id);
  if (!second) throw new Error("Missing repeat review");
  await recordEvaluation(sql, machine, { responsibility_id: row.id, context_hash: second.context_hash, evaluation: { ...notify, notification: "Reworded reminder about the same watched task" } });
  expect(await sql`SELECT outcome FROM assistant.responsibility_evaluations WHERE responsibility_id=${row.id} AND context_hash=${second.context_hash}`).toMatchObject([{ outcome: "quiet" }]);
  expect(await sql`SELECT id FROM assistant.responsibility_notifications WHERE responsibility_id=${row.id}`).toHaveLength(1);
  expect(await sql`SELECT id FROM assistant.messages WHERE conversation_id=${conversation} AND role='assistant'`).toHaveLength(1);
  await sql`UPDATE assistant.responsibility_notifications SET created_at=now(),delivered_at=now()-interval '25 hours' WHERE responsibility_id=${row.id}`;
  await sql`UPDATE assistant.responsibilities SET next_review_at='2000-01-01T02:00:00Z' WHERE id=${row.id}`;
  const third = (await dueResponsibilities(sql, machine)).find(item => item.id === row.id);
  if (!third) throw new Error("Missing later review");
  await recordEvaluation(sql, machine, { responsibility_id: row.id, context_hash: third.context_hash, evaluation: notify });
  expect(await sql`SELECT id FROM assistant.messages WHERE conversation_id=${conversation} AND role='assistant'`).toHaveLength(2);
});
test("new message evidence notifies normally even with identical notification text", async () => {
  const { row, conversation } = await scheduledFixture();
  await scheduledReview(row.id, 0);
  await sql`INSERT INTO assistant.messages(workspace_id,conversation_id,role,content) VALUES(${workspace},${conversation},'user','The awaited document arrived')`;
  const next = await scheduledReview(row.id, 1);
  expect(await sql`SELECT outcome FROM assistant.responsibility_evaluations WHERE responsibility_id=${row.id} AND context_hash=${next.context_hash}`).toMatchObject([{ outcome: "notify" }]);
  expect(await sql`SELECT id FROM assistant.messages WHERE conversation_id=${conversation} AND role='assistant'`).toHaveLength(2);
});
test("task evidence is compared with the last delivery, not any older matching delivery", async () => {
  const { row, task, conversation } = await scheduledFixture();
  await scheduledReview(row.id, 0);
  await sql`UPDATE assistant.tasks SET state='failed' WHERE id=${task}`;
  await scheduledReview(row.id, 1);
  await sql`UPDATE assistant.tasks SET state='running' WHERE id=${task}`;
  await scheduledReview(row.id, 2);
  expect(await sql`SELECT id FROM assistant.messages WHERE conversation_id=${conversation} AND role='assistant'`).toHaveLength(3);
});
test("periodic cadence still notifies with unchanged evidence and identical text", async () => {
  const { row, conversation } = await scheduledFixture({ kind: "periodic", interval_minutes: 60 });
  await scheduledReview(row.id, 0);
  await scheduledReview(row.id, 1);
  expect(await sql`SELECT outcome FROM assistant.responsibility_evaluations WHERE responsibility_id=${row.id}`).toMatchObject([{ outcome: "notify" }, { outcome: "notify" }]);
  expect(await sql`SELECT id FROM assistant.messages WHERE conversation_id=${conversation} AND role='assistant'`).toHaveLength(2);
});
test("pending notifications do not dedupe until delivery, then unchanged queued repeats become quiet", async () => {
  const { row, conversation } = await scheduledFixture(undefined, "quiet");
  await scheduledReview(row.id, 0);
  const repeat = await scheduledReview(row.id, 1);
  expect(await sql`SELECT state FROM assistant.responsibility_notifications WHERE responsibility_id=${row.id}`).toMatchObject([{ state: "pending" }, { state: "pending" }]);
  expect(await sql`SELECT outcome FROM assistant.responsibility_evaluations WHERE responsibility_id=${row.id} AND context_hash=${repeat.context_hash}`).toMatchObject([{ outcome: "notify" }]);
  await sql`UPDATE assistant.responsibilities SET notification_mode='enabled' WHERE id=${row.id}`;
  await dueResponsibilities(sql, machine);
  expect(await sql`SELECT id FROM assistant.messages WHERE conversation_id=${conversation} AND role='assistant'`).toHaveLength(1);
  expect(await sql`SELECT outcome FROM assistant.responsibility_evaluations WHERE responsibility_id=${row.id} AND context_hash=${repeat.context_hash}`).toMatchObject([{ outcome: "quiet" }]);
});
test("unchanged evidence skips model reevaluation regardless of review time", async () => {
  // Given
  const { row } = await fixture(), current = await snapshot(sql, row);
  await recordEvaluation(sql, machine, { responsibility_id: row.id, context_hash: current.context_hash, evaluation: { outcome: "quiet", reason: "Nothing changed", notification: null, action_objective: null, next_review_minutes: 5 } });
  await sql`UPDATE assistant.responsibilities SET next_review_at=now() WHERE id=${row.id}`;
  // When
  const due = await dueResponsibilities(sql, machine);
  // Then
  expect(due.some(item => item.id === row.id)).toBe(false);
});
test("task completion changes evidence without waiting for review time", async () => {
  // Given
  const { row, task } = await fixture(), current = await snapshot(sql, row);
  await recordEvaluation(sql, machine, { responsibility_id: row.id, context_hash: current.context_hash, evaluation: { outcome: "quiet", reason: "Task running", notification: null, action_objective: null, next_review_minutes: 1000 } });
  await sql`UPDATE assistant.tasks SET state='failed' WHERE id=${task}`;
  // When
  const due = await dueResponsibilities(sql, machine);
  // Then
  expect(due.find(item => item.id === row.id)?.context_hash).not.toBe(current.context_hash);
});
test("duplicate model result produces exactly one durable follow-up", async () => {
  // Given
  const { row, conversation } = await fixture(), current = await snapshot(sql, row);
  const request = { responsibility_id: row.id, context_hash: current.context_hash, evaluation: notify };
  // When
  await Promise.all([recordEvaluation(sql, machine, request), recordEvaluation(sql, machine, request)]);
  // Then
  expect(z.object({ count: z.coerce.number() }).parse((await sql`SELECT count(*) AS count FROM assistant.messages WHERE conversation_id=${conversation} AND role='assistant'`)[0]).count).toBe(1);
});
test("quiet mode retains notification then delivers once after unmuting", async () => {
  // Given
  const { row, conversation } = await fixture("quiet"), current = await snapshot(sql, row);
  await recordEvaluation(sql, machine, { responsibility_id: row.id, context_hash: current.context_hash, evaluation: notify });
  const pending = z.object({ state: z.string(), message_id: z.string().nullable() }).parse((await sql`SELECT state,message_id FROM assistant.responsibility_notifications WHERE responsibility_id=${row.id}`)[0]);
  await sql`UPDATE assistant.responsibilities SET notification_mode='enabled' WHERE id=${row.id}`;
  // When
  await dueResponsibilities(sql, machine); await dueResponsibilities(sql, machine);
  // Then
  expect(pending).toEqual({ state: "pending", message_id: null });
  expect(z.object({ count: z.coerce.number() }).parse((await sql`SELECT count(*) AS count FROM assistant.messages WHERE conversation_id=${conversation} AND role='assistant'`)[0]).count).toBe(1);
});
test("cancellation prevents pending quiet follow-up delivery", async () => {
  // Given
  const { row } = await fixture("quiet"), current = await snapshot(sql, row);
  await recordEvaluation(sql, machine, { responsibility_id: row.id, context_hash: current.context_hash, evaluation: notify });
  // When
  const response = await app.request(`/v1/responsibilities/${row.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${clientToken}` } });
  // Then
  expect(response.status).toBe(200);
  expect(z.object({ state: z.string() }).parse((await sql`SELECT state FROM assistant.responsibility_notifications WHERE responsibility_id=${row.id}`)[0]).state).toBe("cancelled");
});
test("stale evidence cannot generate a follow-up", async () => {
  // Given
  const { row, task } = await fixture(), current = await snapshot(sql, row);
  await sql`UPDATE assistant.tasks SET state='succeeded' WHERE id=${task}`;
  // When / Then
  await expect(recordEvaluation(sql, machine, { responsibility_id: row.id, context_hash: current.context_hash, evaluation: notify })).rejects.toThrow("Evidence changed");
});
test("provider failure schedules backoff without completing responsibility", async () => {
  // Given
  const { row } = await fixture();
  // When
  const response = await app.request("/v1/daemon/responsibilities/failure", { method: "POST", headers: { Authorization: `Bearer ${machineToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ responsibility_id: row.id, error_code: "provider_error" }) });
  // Then
  expect(response.status).toBe(200);
  expect(z.object({ state: z.string(), failure_count: z.number(), future: z.boolean() }).parse((await sql`SELECT state,failure_count,next_review_at>now() AS future FROM assistant.responsibilities WHERE id=${row.id}`)[0])).toEqual({ state: "active", failure_count: 1, future: true });
});
test("quiet-hours boundaries use declared timezone across midnight", () => {
  // Given
  const hours = { start_hour: 22, end_hour: 7, timezone: "Asia/Seoul" };
  // When / Then
  expect(quietNow(hours, new Date("2026-10-01T14:00:00Z"))).toBe(true);
  expect(quietNow(hours, new Date("2026-10-01T23:00:00Z"))).toBe(false);
});

test("assistant promise cannot activate a responsibility without user source", async () => {
  // Given
  const { input } = await fixture();
  await sql`UPDATE assistant.messages SET role='assistant' WHERE id=${input.source_message_id}`;
  // When / Then
  await expect(createResponsibility(sql, client, { ...input, client_responsibility_id: crypto.randomUUID() })).rejects.toThrow("Explicit user source");
});
test("quiet pending notification becomes superseded when substantive evidence changes", async () => {
  // Given
  const { row, task, conversation } = await fixture("quiet"), current = await snapshot(sql, row);
  await recordEvaluation(sql, machine, { responsibility_id: row.id, context_hash: current.context_hash, evaluation: notify });
  await sql`UPDATE assistant.tasks SET state='succeeded' WHERE id=${task}`;
  await sql`UPDATE assistant.responsibilities SET notification_mode='enabled' WHERE id=${row.id}`;
  // When
  await dueResponsibilities(sql, machine);
  // Then obsolete content remains recorded but is never sent.
  expect(z.object({ state: z.string(), content: z.string() }).parse((await sql`SELECT state,content FROM assistant.responsibility_notifications WHERE responsibility_id=${row.id}`)[0])).toEqual({ state: "cancelled", content: notify.notification });
  expect(z.object({ count: z.coerce.number() }).parse((await sql`SELECT count(*) AS count FROM assistant.messages WHERE conversation_id=${conversation} AND role='assistant'`)[0]).count).toBe(0);
});

test("follow-up action creates exactly one queued task and durable binding", async () => {
  // Given an authorized responsibility whose previous task has ended.
  const { row, task, conversation } = await fixture(); await sql`UPDATE assistant.tasks SET state='failed' WHERE id=${task}`;
  const current = await snapshot(sql, row), request = { responsibility_id: row.id, context_hash: current.context_hash, evaluation: { outcome: "action", reason: "Authorized follow-up needed", notification: null, action_objective: "Inspect the report source", next_review_minutes: 5 } as const };
  // When the same decision is delivered twice.
  await Promise.all([recordEvaluation(sql, machine, request), recordEvaluation(sql, machine, request)]);
  // Then
  expect(z.object({ count: z.coerce.number() }).parse((await sql`SELECT count(*) AS count FROM assistant.tasks WHERE conversation_id=${conversation} AND state='queued'`)[0]).count).toBe(1);
  expect(z.object({ state: z.string(), linked: z.boolean() }).parse((await sql`SELECT state,task_id IS NOT NULL AS linked FROM assistant.responsibility_actions WHERE responsibility_id=${row.id}`)[0])).toEqual({ state: "dispatched", linked: true });
});
test("an active foreground task coexists with exactly one background follow-up", async () => {
  // Given
  const { row, conversation } = await fixture(), current = await snapshot(sql, row);
  // When
  await recordEvaluation(sql, machine, { responsibility_id: row.id, context_hash: current.context_hash, evaluation: { outcome: "action", reason: "Follow up", notification: null, action_objective: "Inspect source", next_review_minutes: 5 } });
  await dueResponsibilities(sql,machine);
  expect(z.object({ count: z.coerce.number() }).parse((await sql`SELECT count(*) AS count FROM assistant.tasks WHERE conversation_id=${conversation} AND state NOT IN ('cancelled','succeeded','failed')`)[0]).count).toBe(2);
  expect(z.object({ state: z.string() }).parse((await sql`SELECT state FROM assistant.responsibility_actions WHERE responsibility_id=${row.id}`)[0]).state).toBe("dispatched");
  expect(await sql`SELECT t.lane,m.hidden,m.role FROM assistant.tasks t JOIN assistant.messages m ON m.task_id=t.id WHERE t.conversation_id=${conversation} AND t.lane='background'`).toMatchObject([{lane:'background',hidden:true,role:'system'}]);
});
test("responsibility cancellation prevents pending action dispatch", async () => {
  // Given
  const { row } = await fixture(), current = await snapshot(sql, row);
  await sql`INSERT INTO assistant.responsibility_actions(workspace_id,responsibility_id,context_hash,objective) VALUES(${workspace},${row.id},${current.context_hash},'Inspect source')`;
  // When
  await app.request(`/v1/responsibilities/${row.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${clientToken}` } }); await dueResponsibilities(sql, machine);
  // Then
  expect(z.object({ state: z.string(), task_id: z.string().nullable() }).parse((await sql`SELECT state,task_id FROM assistant.responsibility_actions WHERE responsibility_id=${row.id}`)[0])).toEqual({ state: "cancelled", task_id: null });
});

test('a daily routine with an end date completes after it instead of running on', async () => {
  const { input } = await fixture();
  const r = await createResponsibility(sql, client, ResponsibilityInput.parse({ ...input, client_responsibility_id: crypto.randomUUID(), trigger: { kind: 'daily', hour: 18, minute: 0, timezone: 'Asia/Seoul' }, until_at: new Date(Date.now() - 60_000).toISOString() }));
  await sql`UPDATE assistant.responsibilities SET next_review_at=now()+interval '1 day' WHERE id=${r.id}`;
  await dueResponsibilities(sql, machine);
  expect((await sql`SELECT state FROM assistant.responsibilities WHERE id=${r.id}`)[0]?.['state']).toBe('complete');
  expect((await sql`SELECT count(*)::int AS n FROM assistant.responsibility_actions WHERE responsibility_id=${r.id}`)[0]?.['n']).toBe(0);
  expect((await sql`SELECT management_revision FROM assistant.responsibilities WHERE id=${r.id}`)[0]?.['management_revision']).toBe(1);
});

test("expiry cancels pending actions before dispatch and leaves dispatched tasks alone", async () => {
  const { input, task } = await fixture();
  const row = await createResponsibility(sql, client, { ...input, client_responsibility_id: crypto.randomUUID(), trigger: { kind: "periodic", interval_minutes: 60 }, until_at: new Date(Date.now() - 60_000).toISOString() });
  await sql`UPDATE assistant.responsibilities SET next_review_at=now()+interval '1 day' WHERE id=${row.id}`;
  await sql`INSERT INTO assistant.responsibility_actions(workspace_id,responsibility_id,context_hash,objective) VALUES(${workspace},${row.id},'pending','Must not dispatch')`;
  await sql`INSERT INTO assistant.responsibility_actions(workspace_id,responsibility_id,context_hash,objective,state,task_id) VALUES(${workspace},${row.id},'dispatched','Running work','dispatched',${task})`;
  await dueResponsibilities(sql, machine);
  expect(await sql`SELECT state,task_id FROM assistant.responsibility_actions WHERE responsibility_id=${row.id} AND context_hash='pending'`).toMatchObject([{ state: "cancelled", task_id: null }]);
  expect(await sql`SELECT state FROM assistant.responsibility_actions WHERE responsibility_id=${row.id} AND context_hash='dispatched'`).toMatchObject([{ state: "dispatched" }]);
  expect(await sql`SELECT state FROM assistant.tasks WHERE id=${task}`).toMatchObject([{ state: "running" }]);
});

test("dispatch and evaluation independently refuse expired routines", async () => {
  const { input } = await fixture();
  const row = await createResponsibility(sql, client, { ...input, client_responsibility_id: crypto.randomUUID(), trigger: { kind: "periodic", interval_minutes: 60 }, until_at: new Date(Date.now() - 60_000).toISOString() });
  const current = await snapshot(sql, row);
  await sql`INSERT INTO assistant.responsibility_actions(workspace_id,responsibility_id,context_hash,objective) VALUES(${workspace},${row.id},${current.context_hash},'Must not dispatch')`;
  await sql.begin(tx => dispatchActions(tx, machine));
  expect(await sql`SELECT state,task_id FROM assistant.responsibility_actions WHERE responsibility_id=${row.id}`).toMatchObject([{ state: "cancelled", task_id: null }]);
  await expect(recordEvaluation(sql, machine, { responsibility_id: row.id, context_hash: current.context_hash, evaluation: { outcome: "action", reason: "Too late", notification: null, action_objective: "Must not create", next_review_minutes: 5 } })).rejects.toThrow("Responsibility is inactive");
  expect(await sql`SELECT id FROM assistant.responsibility_actions WHERE responsibility_id=${row.id}`).toHaveLength(1);
});

test("starts_at tomorrow selects tomorrow's first daily occurrence, including midnight", async () => {
  const { input } = await fixture();
  const tomorrow = new Date();
  tomorrow.setUTCHours(0, 0, 0, 0);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  for (const hour of [0, 18]) {
    const row = await createResponsibility(sql, client, { ...input, client_responsibility_id: crypto.randomUUID(), trigger: { kind: "daily", hour, minute: 0, timezone: "UTC" }, starts_at: tomorrow.toISOString() });
    const expected = new Date(tomorrow);
    expected.setUTCHours(hour);
    expect(row.next_review_at).toBe(expected.toISOString());
  }
  const periodic = await createResponsibility(sql, client, { ...input, client_responsibility_id: crypto.randomUUID(), trigger: { kind: "periodic", interval_minutes: 60 }, starts_at: tomorrow.toISOString() });
  expect(periodic.next_review_at).toBe(tomorrow.toISOString());
});

test("deadline and task-change reject routine start/end dates with invalid_until", async () => {
  const { input } = await fixture();
  for (const trigger of [{ kind: "deadline", due_at: "2099-01-01T00:00:00Z", timezone: "UTC" } as const, input.trigger]) {
    for (const dates of [{ until_at: "2099-01-02T00:00:00Z" }, { starts_at: "2099-01-01T00:00:00Z" }]) {
      await expect(createResponsibility(sql, client, { ...input, ...dates, client_responsibility_id: crypto.randomUUID(), trigger })).rejects.toMatchObject({ code: "invalid_until", status: 400 });
    }
  }
});

test("creation idempotency includes normalized start/end dates but not title", async () => {
  const { input } = await fixture();
  const creation = { ...input, client_responsibility_id: crypto.randomUUID(), trigger: { kind: "periodic", interval_minutes: 60 } as const, starts_at: "2098-01-01T09:00:00+09:00", until_at: "2099-01-01T09:00:00+09:00" };
  const row = await createResponsibility(sql, client, creation);
  expect(row.starts_at).toBe("2098-01-01T00:00:00.000Z");
  expect((await createResponsibility(sql, client, { ...creation, title: "Another title", starts_at: "2098-01-01T00:00:00.000Z", until_at: "2099-01-01T00:00:00.000Z" })).id).toBe(row.id);
  await expect(createResponsibility(sql, client, { ...creation, starts_at: null })).rejects.toMatchObject({ code: "idempotency_conflict" });
  await expect(createResponsibility(sql, client, { ...creation, starts_at: "2098-01-02T00:00:00Z" })).rejects.toMatchObject({ code: "idempotency_conflict" });
  await expect(createResponsibility(sql, client, { ...creation, until_at: null })).rejects.toMatchObject({ code: "idempotency_conflict" });
  await expect(createResponsibility(sql, client, { ...creation, until_at: "2099-01-02T00:00:00Z" })).rejects.toMatchObject({ code: "idempotency_conflict" });
});
