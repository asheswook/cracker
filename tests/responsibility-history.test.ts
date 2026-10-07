import { expect, test } from "bun:test";
import { z } from "zod";
import { ResponsibilityHistory } from "../packages/memory/responsibility-history-schema";
import { controlFixture } from "./control-fixture";

const f = controlFixture();
async function routine() {
  const source = await f.newTask();
  await f.finishActive();
  const response = await f.request("/v1/responsibilities", f.client, {
    client_responsibility_id: crypto.randomUUID(), conversation_id: source.task.conversation_id,
    vm_id: f.vm, source_message_id: source.message.id, source_quote: source.message.content,
    objective: "History fixture", trigger: { kind: "daily", hour: 12, minute: 0, timezone: "Asia/Seoul" },
  });
  expect(response.status).toBe(201);
  const id = z.object({ responsibility: z.object({ id: z.uuid() }) }).parse(await response.json()).responsibility.id;
  return { id, conversation: source.task.conversation_id };
}
async function action(responsibility: string, created: string, task: string | null = null, id: string = crypto.randomUUID()) {
  await f.sql`INSERT INTO assistant.responsibility_actions(id,workspace_id,responsibility_id,context_hash,objective,state,task_id,created_at,scheduled_for)
    VALUES(${id},${f.workspace},${responsibility},${id},'History fixture',${task ? "dispatched" : "pending"},${task},${created},NULL)`;
  return id;
}
async function history(id: string, query = "") {
  const response = await f.request(`/v1/responsibilities/${id}/history${query}`);
  expect(response.status).toBe(200);
  return ResponsibilityHistory.parse(await response.json());
}

test("history retains two completed tasks below a pending occurrence and navigable task identity", async () => {
  // Given two completed occurrences and a newer pending occurrence.
  const r = await routine();
  const tasks = [crypto.randomUUID(), crypto.randomUUID()] as const;
  for (const id of tasks) await f.sql`INSERT INTO assistant.tasks(id,workspace_id,conversation_id,objective,state) VALUES(${id},${f.workspace},${r.conversation},'Completed occurrence','succeeded')`;
  const first = await action(r.id, "2026-10-01T03:00:00Z", tasks[0]);
  const second = await action(r.id, "2026-10-02T03:00:00Z", tasks[1]);
  const pending = await action(r.id, "2026-10-03T03:00:00Z");
  await f.sql`UPDATE assistant.responsibility_actions SET scheduled_for='2026-10-03T02:00:00Z' WHERE id=${pending}`;
  // When reading the history through the authenticated API.
  const page = await history(r.id);
  // Then pending never replaces earlier completed task links.
  expect(page.runs.map(run => run.id)).toEqual([pending, second, first]);
  expect(page.runs.map(run => run.task?.state ?? run.state)).toEqual(["pending", "succeeded", "succeeded"]);
  expect(page.runs.map(run => run.task?.id ?? null)).toEqual([null, tasks[1], tasks[0]]);
  expect(page.runs.slice(1).every(run => run.task?.conversation_id === r.conversation)).toBe(true);
  expect(page.next_cursor).toBeNull();
  expect(Date.parse(page.runs[0]?.scheduled_for ?? '')).toBe(Date.parse('2026-10-03T02:00:00Z'));
});

test("cursor pagination preserves timestamp ties and microseconds across newer concurrent inserts", async () => {
  // Given equal timestamps plus values differing only below JavaScript millisecond precision.
  const r = await routine();
  const prefix = crypto.randomUUID().slice(0, -12);
  const low = await action(r.id, "2026-10-01T03:00:00.000001Z", null, `${prefix}000000000001`);
  const high = await action(r.id, "2026-10-01T03:00:00.000001Z", null, `${prefix}000000000002`);
  const later = await action(r.id, "2026-10-01T03:00:00.000002Z");
  const first = await history(r.id, "?limit=1");
  await action(r.id, "2026-10-02T03:00:00Z");
  // When continuing the bounded cursor sequence after insertion.
  const second = await history(r.id, `?limit=1&cursor=${first.next_cursor}`);
  const third = await history(r.id, `?limit=1&cursor=${second.next_cursor}`);
  // Then every original row appears once in strict latest-first order.
  expect([...first.runs, ...second.runs, ...third.runs].map(run => run.id)).toEqual([later, high, low]);
  expect(third.next_cursor).toBeNull();
});

test("history rejects other workspace ownership, other routine cursors, and invalid page bounds", async () => {
  // Given a real routine and a cursor owned by another routine.
  const r = await routine(), other = await routine();
  const cursor = await action(other.id, "2026-10-01T00:00:00Z");
  // When requests cross ownership or the pagination boundary.
  const responses = await Promise.all([
    f.request(`/v1/responsibilities/${r.id}/history`, f.alienToken),
    f.request(`/v1/responsibilities/${r.id}/history?cursor=${cursor}`),
    f.request(`/v1/responsibilities/${r.id}/history?cursor=${crypto.randomUUID()}`),
    f.request(`/v1/responsibilities/${r.id}/history?cursor=not-a-uuid`),
    ...["0", "51", "1.5"].map(limit => f.request(`/v1/responsibilities/${r.id}/history?limit=${limit}`)),
  ]);
  // Then ownership is hidden and all invalid queries are rejected.
  expect(responses.map(response => response.status)).toEqual([404, 400, 400, 400, 400, 400, 400]);
});

test("history is bounded to 20 by default and 50 at the maximum", async () => {
  // Given 52 stored occurrences.
  const r = await routine();
  await f.sql`INSERT INTO assistant.responsibility_actions(workspace_id,responsibility_id,context_hash,objective,created_at)
    SELECT ${f.workspace},${r.id},n::text,'Bounded history','2026-10-01'::timestamptz+n*interval '1 second' FROM generate_series(1,52) n`;
  // When requesting default and maximum pages.
  const pages = await Promise.all([history(r.id), history(r.id, "?limit=50")]);
  // Then both page sizes and continuation remain bounded.
  expect(pages.map(page => page.runs.length)).toEqual([20, 50]);
  expect(pages.every(page => page.next_cursor === page.runs.at(-1)?.id)).toBe(true);
});

test("cancelled routines keep completed execution history and cancel only pending occurrences", async () => {
  // Given one completed task and one pending occurrence.
  const r = await routine();
  const task = crypto.randomUUID();
  await f.sql`INSERT INTO assistant.tasks(id,workspace_id,conversation_id,objective,state) VALUES(${task},${f.workspace},${r.conversation},'Completed','succeeded')`;
  await action(r.id, "2026-10-01T03:00:00Z", task);
  await action(r.id, "2026-10-02T03:00:00Z");
  // When cancelling the definition using the existing action.
  expect((await f.request(`/v1/responsibilities/${r.id}`, f.client, undefined, "DELETE")).status).toBe(200);
  const page = await history(r.id);
  // Then prior results remain navigable and the pending occurrence is cancelled.
  expect(page.runs.map(run => run.task?.state ?? run.state)).toEqual(["cancelled", "succeeded"]);
  expect(page.runs[1]?.task?.id).toBe(task);
});

test("an owned routine with no occurrences returns an empty terminal page", async () => {
  // Given a newly registered routine.
  const r = await routine();
  // When its history is requested.
  const page = await history(r.id);
  // Then the response distinguishes an empty history from a missing routine.
  expect(page).toEqual({ runs: [], next_cursor: null });
});
