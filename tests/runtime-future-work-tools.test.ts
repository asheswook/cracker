import { expect, test } from "bun:test";
import ky from "ky";
import { z } from "zod";
import { futureWorkTools, runFutureWork } from "../services/daemon/future-work.ts";
import { ResponsibilityConfiguration, ScheduleConfiguration } from "../packages/proactive/schema.ts";
import { ResponsibilityInput } from "../packages/memory/responsibility-schema.ts";
import { ScheduleRequest } from "../services/control/repository/schedule-enrollment.ts";

const scope = { runId: crypto.randomUUID(), actionId: "synthetic-run:edit-1" };
const source = { source_message_id: crypto.randomUUID(), source_quote: "Update the existing routine." };
const target = { kind: "responsibility", id: crypto.randomUUID(), expected_version: "a".repeat(64) } as const;
const configuration = { title: "정오 알림", until_at: null, objective: "Include a submission reminder", trigger: { kind: "daily", hour: 12, minute: 0, timezone: "Asia/Seoul" }, notification_mode: "enabled", quiet_hours: null };
const updated = { work: { kind: "responsibility", id: target.id, version: "b".repeat(64), state: "active", conversation_id: crypto.randomUUID(), configuration, next_due_at: "2027-01-01T03:00:00.000Z", skill_id: null, skill_revision: null }, already_dispatched_task_ids: [] };

test("work titles normalize blank values and enforce the display limit", () => {
  for (const schema of [ResponsibilityInput.shape.title, ScheduleRequest.shape.title, ResponsibilityConfiguration.shape.title, ScheduleConfiguration.shape.title]) {
    expect(schema.parse("  ")).toBeNull();
    expect(schema.parse(null)).toBeNull();
    expect(schema.parse("  메일 확인  ")).toBe("메일 확인");
    expect(schema.safeParse("가".repeat(61)).success).toBe(false);
  }
  expect(ResponsibilityInput.shape.title.parse(undefined)).toBeNull();
  expect(ScheduleRequest.shape.title.parse(undefined)).toBeNull();
});

test("future work parameter schemas describe strict objects including every trigger alternative", () => {
  // Given all model-visible parameter definitions, including transformed timezone inputs.
  function inspect(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const record = z.record(z.string(), z.unknown()).parse(value);
    expect(record["oneOf"]).toBeUndefined();
    if (record["type"] === "object") {
      const properties = z.record(z.string(), z.unknown()).parse(record["properties"]);
      expect(record["additionalProperties"]).toBe(false);
      expect(z.array(z.string()).parse(record["required"]).sort()).toEqual(Object.keys(properties).sort());
    }
    for (const nested of Object.values(record)) {
      if (Array.isArray(nested)) nested.forEach(inspect);
      else inspect(nested);
    }
  }
  // When / Then: the actual advertised schemas are recursively strict.
  for (const tool of futureWorkTools) if (tool.type === "function") inspect(tool.parameters);
});

test("invalid mutation arguments never reach the control service", async () => {
  // Given
  let requests = 0;
  const server = Bun.serve({ port: 0, fetch: () => { requests++; return Response.json(updated); } });
  const http = ky.create({ prefixUrl: server.url.href, retry: 0 });
  try {
    // When
    const result: unknown = JSON.parse(await runFutureWork(http, scope, { name: "update_future_work", args: "{", signal: AbortSignal.timeout(5000) }));
    // Then
    expect(result).toMatchObject({ kind: "future_work_rejected", code: "invalid_request", persisted: false });
    expect(requests).toBe(0);
  } finally { await server.stop(true); }
});

test("repeated mutation delivery uses one durable action ID and unchanged configuration", async () => {
  // Given
  const requests: unknown[] = [];
  const server = Bun.serve({ port: 0, async fetch(request) { requests.push(await request.json()); return Response.json(updated); } });
  const http = ky.create({ prefixUrl: server.url.href, retry: 0 });
  const args = JSON.stringify({ ...source, work: { ...target, configuration } });
  try {
    // When
    await runFutureWork(http, scope, { name: "update_future_work", args, signal: AbortSignal.timeout(5000) });
    await runFutureWork(http, scope, { name: "update_future_work", args, signal: AbortSignal.timeout(5000) });
    // Then
    const bodies = z.array(z.object({ run_id: z.uuid(), client_action_id: z.uuid(), work: z.unknown() })).parse(requests);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[0]?.work).toEqual({ ...target, configuration });
  } finally { await server.stop(true); }
});

for (const outcome of [
  { status: 409, code: "stale_version", recoverable: true },
  { status: 404, code: "not_found", recoverable: true },
  { status: 409, code: "inactive", recoverable: true },
  { status: 500, code: "stale_version", recoverable: false },
  { status: 409, code: "unrecognized_failure", recoverable: false },
]) test(`future work ${outcome.status}/${outcome.code} ${outcome.recoverable ? "allows correction" : "preserves uncertain outcome"}`, async () => {
  // Given
  let requests = 0;
  const server = Bun.serve({ port: 0, fetch: () => { requests++; return Response.json({ error: { code: outcome.code } }, { status: outcome.status }); } });
  const http = ky.create({ prefixUrl: server.url.href, retry: 2 });
  try {
    // When
    const result = runFutureWork(http, scope, { name: "cancel_future_work", args: JSON.stringify({ ...source, target }), signal: AbortSignal.timeout(5000) });
    // Then
    if (outcome.recoverable) expect(JSON.parse(await result)).toMatchObject({ kind: "future_work_rejected", code: outcome.code, persisted: false });
    else await expect(result).rejects.toThrow(`future_work_http_${outcome.status}_${outcome.code}`);
    expect(requests).toBe(1);
  } finally { await server.stop(true); }
});

test("a malformed success receipt is not reported as a confirmed mutation", async () => {
  // Given
  const server = Bun.serve({ port: 0, fetch: () => Response.json({ ok: true }) });
  const http = ky.create({ prefixUrl: server.url.href, retry: 0 });
  try {
    // When / Then
    await expect(runFutureWork(http, scope, { name: "update_future_work", args: JSON.stringify({ ...source, work: { ...target, configuration } }), signal: AbortSignal.timeout(5000) })).rejects.toThrow("future_work_outcome_unconfirmed");
  } finally { await server.stop(true); }
});
