import { expect, test } from "bun:test";
import ky from "ky";
import { TaskNavigation } from "../packages/protocol/task-navigation";
import { controlFixture } from "./control-fixture";

const { sql, app, workspace, client, machine, alienToken, request, newTask, newConversation } = controlFixture();

for (const role of ["user", "system"] as const) {
  test(`navigation selects first ${role} request and latest reply across steering and commentary`, async () => {
    // Given a task with several requests/replies and newer unrelated work in the same feed.
    const initial = await newTask(), reply = crypto.randomUUID(), otherTask = crypto.randomUUID();
    await sql`UPDATE assistant.messages SET role=${role} WHERE id=${initial.message.id}`;
    await sql`INSERT INTO assistant.messages(workspace_id,conversation_id,task_id,role,content) VALUES
      (${workspace},${initial.task.conversation_id},${initial.task.id},'assistant','commentary'),
      (${workspace},${initial.task.conversation_id},${initial.task.id},'user','steering'),
      (${workspace},${initial.task.conversation_id},${initial.task.id},'assistant','intermediate reply'),
      (${workspace},${initial.task.conversation_id},${initial.task.id},'user','more steering')`;
    await sql`INSERT INTO assistant.messages(id,workspace_id,conversation_id,task_id,role,content) VALUES(${reply},${workspace},${initial.task.conversation_id},${initial.task.id},'assistant','latest reply')`;
    await sql`UPDATE assistant.tasks SET state='succeeded' WHERE id=${initial.task.id}`;
    await sql`INSERT INTO assistant.tasks(id,workspace_id,conversation_id,objective) VALUES(${otherTask},${workspace},${initial.task.conversation_id},'unrelated')`;
    await sql`INSERT INTO assistant.messages(workspace_id,conversation_id,task_id,role,content) VALUES(${workspace},${initial.task.conversation_id},${otherTask},'assistant','unrelated reply')`;
    const unrelated = await newTask();
    await sql`INSERT INTO assistant.messages(workspace_id,conversation_id,task_id,role,content) VALUES(${workspace},${unrelated.task.conversation_id},${unrelated.task.id},'assistant','different conversation reply')`;
    // When navigation resolves through the authenticated HTTP application.
    const response = await request(`/v1/tasks/${initial.task.id}/navigation`);
    // Then identities remain exact, regardless of later requests or other work.
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(TaskNavigation.parse(await response.json())).toEqual({
      task_id: initial.task.id, conversation_id: initial.task.conversation_id,
      request_message_id: initial.message.id, reply_message_id: reply, source: null,
    });
  });
}

test("navigation resolves exact source identities over real HTTP", async () => {
  // Given the production app served on an ephemeral loopback port with real PostgreSQL.
  const initial = await newTask();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  try {
    // When an authenticated client follows the navigation endpoint over HTTP.
    const response = await ky.get(new URL(`/v1/tasks/${initial.task.id}/navigation`, server.url), {
      headers: { Authorization: `Bearer ${client}` }, retry: 0,
    });
    const navigation = TaskNavigation.parse(await response.json());
    // Then the wire response carries only the exact request and an absent reply.
    expect(response.status).toBe(200);
    expect(navigation).toEqual({
      task_id: initial.task.id, conversation_id: initial.task.conversation_id,
      request_message_id: initial.message.id, reply_message_id: null, source: null,
    });
    console.log(JSON.stringify({ scenario: "task_navigation_http", status: response.status, navigation }));
  } finally {
    await server.stop(true);
  }
});

test("navigation returns null targets when task has no messages", async () => {
  // Given an empty task beside other work with messages.
  await newTask();
  const conversation = await newConversation(), task = crypto.randomUUID();
  await sql`INSERT INTO assistant.tasks(id,workspace_id,conversation_id,objective) VALUES(${task},${workspace},${conversation.id},'empty')`;
  // When the empty task is opened.
  const response = await request(`/v1/tasks/${task}/navigation`);
  // Then neither target falls back to another task.
  expect(response.status).toBe(200);
  expect(TaskNavigation.parse(await response.json())).toEqual({
    task_id: task, conversation_id: conversation.id, request_message_id: null, reply_message_id: null, source: null,
  });
});

test("navigation preserves request-only tasks without inventing a reply", async () => {
  // Given a queued request with no assistant message.
  const initial = await newTask();
  // When navigation is requested.
  const response = await request(`/v1/tasks/${initial.task.id}/navigation`);
  // Then only its request is available.
  expect(response.status).toBe(200);
  expect(TaskNavigation.parse(await response.json())).toEqual({
    task_id: initial.task.id, conversation_id: initial.task.conversation_id,
    request_message_id: initial.message.id, reply_message_id: null, source: null,
  });
});

test("a scheduled run leads back to the message that asked for it, not at its own wake message", async () => {
  // Given a reminder asked for earlier and delivered later as its own run.
  const asked = await newTask(), there = { id: asked.task.conversation_id }, schedule = crypto.randomUUID(), task = crypto.randomUUID();
  await sql`INSERT INTO assistant.schedules(id,workspace_id,conversation_id,objective,due_at,timezone,client_schedule_id,source_message_id,source_quote,status,title)
    VALUES(${schedule},${workspace},${there.id},'약국 가기',now(),'Asia/Seoul',${crypto.randomUUID()},${asked.message.id},'약국 가야된다고 알려줘','delivered','약국 가기 알림')`;
  await sql`INSERT INTO assistant.tasks(id,workspace_id,conversation_id,objective,origin,lane) VALUES(${task},${workspace},${there.id},'약국 가기','schedule','background')`;
  await sql`INSERT INTO assistant.messages(workspace_id,conversation_id,task_id,role,content,client_message_id,origin,hidden) VALUES(${workspace},${there.id},${task},'system','약국 가기',${schedule},'schedule',true)`;
  // When its navigation is read.
  const response = await request(`/v1/tasks/${task}/navigation`);
  // Then the original ask is named exactly.
  expect(TaskNavigation.parse(await response.json()).source).toEqual({ conversation_id: asked.task.conversation_id, message_id: asked.message.id });
});

test("navigation includes attachment-only assistant replies", async () => {
  // Given an assistant message whose only user-visible content is an attachment.
  const initial = await newTask(), reply = crypto.randomUUID(), artifact = crypto.randomUUID();
  await sql`INSERT INTO assistant.messages(id,workspace_id,conversation_id,task_id,role,content) VALUES(${reply},${workspace},${initial.task.conversation_id},${initial.task.id},'assistant','')`;
  await sql`INSERT INTO assistant.artifacts(id,workspace_id,conversation_id,name,media_type,bytes,sha256,object_key,state,lease_id) VALUES(${artifact},${workspace},${initial.task.conversation_id},'reply.txt','text/plain',5,${"a".repeat(64)},${artifact},'deleted',${crypto.randomUUID()})`;
  await sql`INSERT INTO assistant.message_artifacts(workspace_id,conversation_id,message_id,artifact_id,position) VALUES(${workspace},${initial.task.conversation_id},${reply},${artifact},0)`;
  // When resolving navigation without filtering on text.
  const response = await request(`/v1/tasks/${initial.task.id}/navigation`);
  // Then the attachment message remains a valid reply destination.
  expect(response.status).toBe(200);
  expect(TaskNavigation.parse(await response.json()).reply_message_id).toBe(reply);
});

for (const access of ["foreign", "missing", "unauthenticated", "daemon", "invalid"] as const) {
  test(`navigation rejects ${access} access`, async () => {
    // Given an owned task and a separately scoped credential.
    const initial = await newTask();
    const identity = access === "missing" ? crypto.randomUUID() : access === "invalid" ? "invalid" : initial.task.id;
    const path = `/v1/tasks/${identity}/navigation`;
    // When the requested scope or audience is not valid.
    const response = access === "unauthenticated" ? await app.request(path)
      : await request(path, access === "foreign" ? alienToken : access === "daemon" ? machine : undefined);
    // Then task identities are not disclosed.
    const expected = { foreign: 404, missing: 404, unauthenticated: 401, daemon: 403, invalid: 400 };
    expect(response.status).toBe(expected[access]);
    expect(await response.json()).toHaveProperty("error");
  });
}
