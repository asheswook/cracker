import { beforeAll, afterAll, test, expect } from "bun:test";
import { z } from "zod";
import { createDatabase } from "../services/control/db.ts";
import { createApp } from "../services/control/app.ts";
import { hashToken } from "../services/control/auth.ts";
import { createResponsibility, dueResponsibilities, recordEvaluation, snapshot, ResponsibilityRow } from "../packages/memory/responsibility-store.ts";
import { ResponsibilityInput, quietNow } from "../packages/memory/responsibility-schema.ts";
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
test("an active task prevents duplicate follow-up dispatch", async () => {
  // Given
  const { row, conversation } = await fixture(), current = await snapshot(sql, row);
  // When
  await recordEvaluation(sql, machine, { responsibility_id: row.id, context_hash: current.context_hash, evaluation: { outcome: "action", reason: "Follow up", notification: null, action_objective: "Inspect source", next_review_minutes: 5 } });
  // Then the action is durable but has not created another active task.
  expect(z.object({ count: z.coerce.number() }).parse((await sql`SELECT count(*) AS count FROM assistant.tasks WHERE conversation_id=${conversation} AND state NOT IN ('cancelled','succeeded','failed')`)[0]).count).toBe(1);
  expect(z.object({ state: z.string() }).parse((await sql`SELECT state FROM assistant.responsibility_actions WHERE responsibility_id=${row.id}`)[0]).state).toBe("pending");
});
test("responsibility cancellation prevents pending action dispatch", async () => {
  // Given
  const { row } = await fixture(), current = await snapshot(sql, row);
  await recordEvaluation(sql, machine, { responsibility_id: row.id, context_hash: current.context_hash, evaluation: { outcome: "action", reason: "Follow up", notification: null, action_objective: "Inspect source", next_review_minutes: 5 } });
  // When
  await app.request(`/v1/responsibilities/${row.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${clientToken}` } }); await dueResponsibilities(sql, machine);
  // Then
  expect(z.object({ state: z.string(), task_id: z.string().nullable() }).parse((await sql`SELECT state,task_id FROM assistant.responsibility_actions WHERE responsibility_id=${row.id}`)[0])).toEqual({ state: "cancelled", task_id: null });
});
