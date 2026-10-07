import { afterAll, beforeAll, expect, test } from "bun:test";
import { z } from "zod";
import { createDatabase } from "../services/control/db";
import { createApp } from "../services/control/app";
import { hashToken } from "../services/control/auth";
import { Assignment, DaemonPoll, PriorWorkPage, TaskSourcePage, WorkCapsule } from "../packages/protocol";
import { taskInput } from "../services/daemon/task-context";
const sql = createDatabase(
  process.env["TEST_DATABASE_URL"] ?? "postgres://assistant:assistant@127.0.0.1:55439/assistant_dev",
);
const workspace = crypto.randomUUID(),
  vm = crypto.randomUUID(),
  conversation = crypto.randomUUID(),
  task = crypto.randomUUID(),
  run = crypto.randomUUID(),
  token = crypto.randomUUID() + crypto.randomUUID(),
  foreign = crypto.randomUUID();
const prior: string[] = [],
  currentMessages: string[] = [],
  artifact = crypto.randomUUID();
const app = createApp(sql),
  headers = { authorization: `Bearer ${token}` };
const request = (path: string) =>
  app.request(`http://localhost/v1/daemon/context/${run}${path}`, { headers });
beforeAll(async () => {
  await sql`INSERT INTO assistant.workspaces(id,name,persona_name,persona_role,persona_style,instructions) VALUES(${workspace},'task-context','Fixture','Reviewer','Brief','fixture-settings')`;
  await sql`INSERT INTO assistant.vms(id,workspace_id,name) VALUES(${vm},${workspace},'fixture')`;
  await sql`INSERT INTO assistant.credentials(token_hash,workspace_id,role,vm_id) VALUES(${await hashToken(token)},${workspace},'vm',${vm})`;
  await sql`INSERT INTO assistant.conversations(id,workspace_id,title) VALUES(${conversation},${workspace},'feed')`;
  for (let i = 0; i < 10; i++) {
    const id = crypto.randomUUID();
    prior.push(id);
    await sql`INSERT INTO assistant.tasks(id,workspace_id,conversation_id,objective,state,created_at) VALUES(${id},${workspace},${conversation},${"prior-" + i},'succeeded',${`2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`})`;
    await sql`INSERT INTO assistant.messages(workspace_id,conversation_id,task_id,role,content) VALUES(${workspace},${conversation},${id},'user',${"source-" + i + "x".repeat(1400)}),(${workspace},${conversation},${id},'assistant','claimed completion')`;
  }
  await sql`INSERT INTO assistant.tasks(id,workspace_id,conversation_id,objective,created_at) VALUES(${task},${workspace},${conversation},'current','2026-02-01T00:00:00Z')`;
  await sql`INSERT INTO assistant.runs(id,workspace_id,task_id,vm_id) VALUES(${run},${workspace},${task},${vm})`;
  for (let i = 0; i < 101; i++) {
    const id = crypto.randomUUID();
    currentMessages.push(id);
    await sql`INSERT INTO assistant.messages(id,workspace_id,conversation_id,task_id,role,content) VALUES(${id},${workspace},${conversation},${task},'user',${i === 0 ? "current-full-" + "z".repeat(1500) : "steering-" + i})`;
  }
  await sql`INSERT INTO assistant.artifacts(id,workspace_id,conversation_id,name,media_type,bytes,sha256,object_key,state,lease_id) VALUES(${artifact},${workspace},${conversation},'source.txt','text/plain',5,${"a".repeat(64)},${artifact},'deleted',${crypto.randomUUID()})`;
  await sql`INSERT INTO assistant.message_artifacts(workspace_id,conversation_id,message_id,artifact_id,position) VALUES(${workspace},${conversation},${currentMessages[0] ?? ""},${artifact},0)`;
  await sql`INSERT INTO assistant.conversations(id,workspace_id,title) VALUES(${foreign},${workspace},'foreign')`;
});
afterAll(async () => {
  await sql.end();
});
test("work view preserves every current-task source and attachment while bounding prior work", async () => {
  // Given a101-message current task and ten completed tasks. When read through actual authenticated route.
  const response = await request("?view=work"),
    result = Assignment.parse(await response.json());
  // Then exact sources stay intact, no full prior transcript leaks into current input.
  expect(response.status).toBe(200);
  expect(result.messages.map((m) => m.id)).toEqual(currentMessages);
  expect(result.messages[0]?.content.length).toBe(1513);
  expect(result.messages[0]?.attachments?.[0]?.state).toBe("deleted");
  expect(result.work_context?.prior_work).toHaveLength(8);
  expect(result.work_context?.has_older_work).toBe(true);
  expect(result.work_context?.prior_work[0]?.sources[0]?.truncated).toBe(true);
  expect(result.work_context?.prior_work[0]?.sources[0]?.source_message_id).toBeTruthy();
  expect(result.persona?.name).toBe("Fixture");
  const input = taskInput(result);
  const data = input.flatMap((i) =>
    "content" in i && typeof i.content === "string" && i.content.startsWith("{")
      ? [
          z
            .object({
              kind: z.string(),
              name: z.string().optional(),
              prior_work: z.array(WorkCapsule).optional(),
            })
            .parse(JSON.parse(i.content)),
        ]
      : [],
  );
  expect(data.find((x) => x.kind === "assistant_persona")?.name).toBe("Fixture");
  expect(data.find((x) => x.kind === "prior_work")?.prior_work).toHaveLength(8);
});
test("legacy full context remains complete while work mailbox excludes prior tasks", async () => {
  const full = await request(""),
    mailbox = await request("?view=work_mailbox");
  const a = await full.json(),
    b = await mailbox.json();
  expect(a.messages).toHaveLength(121);
  expect(b.messages).toHaveLength(101);
});
test("memory task sources paginate without silent loss or foreign task sources", async () => {
  const first = TaskSourcePage.parse(await (await request("?view=task_sources")).json());
  const second = TaskSourcePage.parse(
    await (await request(`?view=task_sources&after=${first.next_after_sequence}`)).json(),
  );
  expect([...first.messages, ...second.messages].map((m) => m.id)).toEqual(currentMessages);
  expect(second.next_after_sequence).toBeNull();
});
test("prior-work explicit pages recover omitted older work and original untruncated sources", async () => {
  const work = Assignment.parse(await (await request("?view=work")).json());
  const page = PriorWorkPage.parse(
    await (
      await app.request(`http://localhost/v1/daemon/context/${run}/prior-work`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          task_id: null,
          before_task_id: work.work_context?.next_before_task_id,
          after_sequence: 0,
        }),
      })
    ).json(),
  );
  expect(page.capsules).toHaveLength(2);
  expect(page.has_more).toBe(false);
  const detail = PriorWorkPage.parse(
    await (
      await app.request(`http://localhost/v1/daemon/context/${run}/prior-work`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ task_id: prior[0], before_task_id: null, after_sequence: 0 }),
      })
    ).json(),
  );
  expect(detail.messages[0]?.content).toBe("source-0" + "x".repeat(1400));
});
test("work context rejects another VM and prior lookup rejects unrelated task IDs", async () => {
  const otherVm = crypto.randomUUID(),
    otherToken = crypto.randomUUID() + crypto.randomUUID();
  await sql`INSERT INTO assistant.vms(id,workspace_id,name) VALUES(${otherVm},${workspace},'other')`;
  await sql`INSERT INTO assistant.credentials(token_hash,workspace_id,role,vm_id) VALUES(${await hashToken(otherToken)},${workspace},'vm',${otherVm})`;
  const denied = await app.request(`http://localhost/v1/daemon/context/${run}?view=work`, {
    headers: { authorization: `Bearer ${otherToken}` },
  });
  const unrelated = await app.request(`http://localhost/v1/daemon/context/${run}/prior-work`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ task_id: foreign, before_task_id: null, after_sequence: 0 }),
  });
  expect(denied.status).toBe(404);
  expect(unrelated.status).toBe(404);
});

test("task-input builders do not share tool history between work units", async () => {
  // Given two independently built contexts for the same feed.
  const assignment = Assignment.parse(await (await request("?view=work")).json());
  const first = taskInput(assignment);
  first.push({ type: "function_call", call_id: "prior-tool", name: "shell", arguments: "{}" });
  first.push({ type: "function_call_output", call_id: "prior-tool", output: "prior-result" });
  // When a new work unit starts with its own assignment.
  const second = taskInput({
    ...assignment,
    task: { ...assignment.task, id: crypto.randomUUID() },
  });
  // Then no prior in-flight API items migrate across the boundary.
  expect(
    second.some((item) => item.type === "function_call" || item.type === "function_call_output"),
  ).toBe(false);
  expect(
    first.filter((item) => item.type === "function_call" || item.type === "function_call_output"),
  ).toHaveLength(2);
});

test("active work polling scopes sources while legacy polling preserves the feed", async () => {
  // Given an active run with101 own messages and20 historical messages.
  const work = await app.request(`http://localhost/v1/daemon/poll?run_id=${run}&view=work`, { headers });
  const legacy = await app.request(`http://localhost/v1/daemon/poll?run_id=${run}`, { headers });
  // When both authenticated poll views are parsed.
  const scoped = DaemonPoll.parse(await work.json());
  const complete = DaemonPoll.parse(await legacy.json());
  // Then work excludes prior-task sources without changing the legacy API.
  expect(scoped.assignment).toBeNull();
  expect(scoped.messages.map(message => message.id)).toEqual(currentMessages);
  expect(complete.messages).toHaveLength(121);
});

test("cancelled prior work carries both recent steering messages and attachment sources into next task", async () => {
  const previous = prior.at(-1);
  if (!previous) throw new Error("fixture requires prior task");
  const earlierSteering = crypto.randomUUID(), latestSteering = crypto.randomUUID();
  await sql`UPDATE assistant.tasks SET state='cancelled' WHERE id=${previous}`;
  await sql`INSERT INTO assistant.messages(id,workspace_id,conversation_id,task_id,role,content) VALUES(${earlierSteering},${workspace},${conversation},${previous},'user','Run daily and test now'),(${latestSteering},${workspace},${conversation},${previous},'user','Include the attachment already reviewed')`;
  await sql`INSERT INTO assistant.message_artifacts(workspace_id,conversation_id,message_id,artifact_id,position) VALUES(${workspace},${conversation},${latestSteering},${artifact},0)`;
  const assignment = Assignment.parse(await (await request("?view=work")).json());
  const capsule = assignment.work_context?.prior_work.find(item => item.task_id === previous);
  expect(capsule?.state).toBe("cancelled");
  expect(capsule?.sources).toHaveLength(4);
  expect(capsule?.sources.find(source => source.source_message_id === earlierSteering)?.excerpt).toBe("Run daily and test now");
  expect(capsule?.sources.find(source => source.source_message_id === latestSteering)?.attachment_ids).toEqual([artifact]);
  expect(JSON.stringify(taskInput(assignment))).toContain("Include the attachment already reviewed");
  expect(capsule?.sources.filter(source => source.role === "assistant")).toHaveLength(1);
});
