import { test, expect, afterAll } from "bun:test";
import { createDatabase } from "../services/control/db.ts";
import { createApp } from "../services/control/app.ts";
import { hashToken } from "../services/control/auth.ts";
import { dispatchDueSchedules } from "../services/control/repository/schedules.ts";
import { Assignment } from "../packages/protocol/index.ts";
import { ExtensionManager } from "../services/daemon/extensions.ts";
import { ToolExecutor } from "../services/daemon/tools.ts";
import ky from "ky";
import { z } from "zod";
const sql = createDatabase(
  process.env["TEST_DATABASE_URL"] ?? "postgres://assistant:assistant@127.0.0.1:55439/assistant_dev",
);
afterAll(() => sql.end());
async function fixture() {
  const workspace = crypto.randomUUID(),
    vm = crypto.randomUUID(),
    otherVm = crypto.randomUUID(),
    client = crypto.randomUUID() + crypto.randomUUID(),
    machine = crypto.randomUUID() + crypto.randomUUID(),
    otherMachine = crypto.randomUUID() + crypto.randomUUID();
  await sql`INSERT INTO workspaces(id,name) VALUES(${workspace},'skill-workflow-fixture')`;
  await sql`INSERT INTO vms(id,workspace_id,name) VALUES(${vm},${workspace},'vm'),(${otherVm},${workspace},'other')`;
  await sql`INSERT INTO credentials(token_hash,workspace_id,role,vm_id) VALUES(${await hashToken(client)},${workspace},'client',NULL),(${await hashToken(machine)},${workspace},'vm',${vm}),(${await hashToken(otherMachine)},${workspace},'vm',${otherVm})`;
  const app = createApp(sql);
  const request = (path: string, body?: unknown, token = client, method = body ? "POST" : "GET") =>
    app.request(path, {
      method,
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const draft = {
    vm_id: vm,
    name: "sum rows",
    description: "Calculate and verify a numeric total",
    content: "Version one: add the input values, report total and show arithmetic.",
    enabled: false,
  };
  const saved = await request("/v1/extensions/skills", draft);
  expect(saved.status).toBe(201);
  const { skill } = (await saved.json()) as { skill: { id: string; revision: number } };
  const start = async (input = "2, 3, 4", key = crypto.randomUUID()) => {
    const response = await request(`/v1/extensions/skills/${skill.id}/tests`, {
      revision: 1,
      client_execution_id: key,
      input,
    });
    expect(response.status).toBe(201);
    return response.json() as Promise<{
      execution_id: string;
      conversation_id: string;
      task: { id: string };
    }>;
  };
  return {
    workspace,
    vm,
    otherVm,
    client,
    machine,
    otherMachine,
    app,
    request,
    draft,
    skill,
    start,
  };
}
test("ordinary edits and enable toggles preserve the previous version origin", async () => {
  const f=await fixture(),source=await f.start();
  const origin=z.object({id:z.uuid()}).parse((await sql`SELECT id FROM messages WHERE task_id=${source.task.id}`)[0]).id;
  expect((await f.request("/v1/extensions/skills",{...f.draft,id:f.skill.id,expected_revision:1,origin_message_id:origin})).status).toBe(201);
  expect((await f.request("/v1/extensions/skills",{...f.draft,id:f.skill.id,expected_revision:2,content:"Edited without replacing source"})).status).toBe(201);
  expect((await f.request("/v1/extensions/skills",{...f.draft,id:f.skill.id,expected_revision:3,content:"Edited without replacing source",enabled:true})).status).toBe(201);
  const versions=z.object({versions:z.array(z.object({revision:z.number(),origin_message_id:z.uuid().nullable()}))}).parse(await (await f.request(`/v1/extensions/skills/${f.skill.id}/versions`)).json());
  expect(versions.versions.map(version=>[version.revision,version.origin_message_id])).toEqual([[4,origin],[3,origin],[2,origin],[1,null]]);
});
test("explicit source replacement validates ownership and leaves historical origins intact",async()=>{
  const f=await fixture(),foreign=await fixture(),first=await f.start(),second=await f.start("new source"),foreignSource=await foreign.start();
  const originFor=async(task:string)=>z.object({id:z.uuid()}).parse((await sql`SELECT id FROM messages WHERE task_id=${task}`)[0]).id;
  const firstOrigin=await originFor(first.task.id),secondOrigin=await originFor(second.task.id),foreignOrigin=await originFor(foreignSource.task.id);
  expect((await f.request("/v1/extensions/skills",{...f.draft,id:f.skill.id,expected_revision:1,origin_message_id:firstOrigin})).status).toBe(201);
  expect((await f.request("/v1/extensions/skills",{...f.draft,id:f.skill.id,expected_revision:2,origin_message_id:secondOrigin})).status).toBe(201);
  expect((await f.request("/v1/extensions/skills",{...f.draft,id:f.skill.id,expected_revision:3,origin_message_id:foreignOrigin})).status).toBe(404);
  const versions=z.object({versions:z.array(z.object({revision:z.number(),origin_message_id:z.uuid().nullable()}))}).parse(await (await f.request(`/v1/extensions/skills/${f.skill.id}/versions`)).json());
  expect(versions.versions.map(version=>[version.revision,version.origin_message_id])).toEqual([[3,secondOrigin],[2,firstOrigin],[1,null]]);
});
test("immutable version CAS, origin isolation and archive preserve historical text", async () => {
  const f = await fixture(),
    foreign = await fixture();
  const source = await f.start();
  const origin = (await sql`SELECT id FROM messages WHERE task_id=${source.task.id}`)[0]?.["id"];
  const edit = {
    ...f.draft,
    id: f.skill.id,
    expected_revision: 1,
    content: "Version two",
    origin_message_id: origin,
  };
  const results = await Promise.all([
    f.request("/v1/extensions/skills", edit),
    f.request("/v1/extensions/skills", { ...edit, content: "racing content" }),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
  const versions = (await (
    await f.request(`/v1/extensions/skills/${f.skill.id}/versions`)
  ).json()) as {
    versions: { revision: number; content: string; origin_message_id: string | null }[];
  };
  expect(versions.versions).toHaveLength(2);
  expect(versions.versions[1]?.content).toBe(f.draft.content);
  expect(versions.versions[0]?.origin_message_id).toBe(origin);
  expect((await foreign.request(`/v1/extensions/skills/${f.skill.id}/versions`)).status).toBe(404);
  const foreignSource = await foreign.start();
  const foreignMessage = (
    await sql`SELECT id FROM messages WHERE task_id=${foreignSource.task.id}`
  )[0]?.["id"];
  expect(
    (
      await f.request("/v1/extensions/skills", {
        ...edit,
        expected_revision: 2,
        origin_message_id: foreignMessage,
      })
    ).status,
  ).toBe(404);
  let rejected = false;
  try {
    await sql`UPDATE skill_versions SET content='tampered' WHERE skill_id=${f.skill.id}`;
  } catch (error) {
    rejected = error instanceof Error && error.message.includes("immutable");
  }
  expect(rejected).toBe(true);
  expect(
    (await f.request(`/v1/extensions/skills/${f.skill.id}`, undefined, f.client, "DELETE")).status,
  ).toBe(200);
  expect(
    (
      (await (await f.request(`/v1/extensions/skills/${f.skill.id}/versions`)).json()) as {
        versions: unknown[];
      }
    ).versions,
  ).toHaveLength(2);
});
test("explicit disabled draft test is idempotent, VM-bound, pinned after edit, and needs exact loaded receipt", async () => {
  const f = await fixture(),
    key = crypto.randomUUID(),
    work = await f.start("4 + 5", key);
  expect(await f.start("4 + 5", key)).toEqual(work);
  expect(
    (
      await f.request(`/v1/extensions/skills/${f.skill.id}/tests`, {
        revision: 1,
        client_execution_id: key,
        input: "changed",
      })
    ).status,
  ).toBe(409);
  expect(
    (await f.request(`/v1/daemon/extensions/skills/${f.skill.id}`, undefined, f.machine)).status,
  ).toBe(404);
  await f.request("/v1/extensions/skills", {
    ...f.draft,
    id: f.skill.id,
    expected_revision: 1,
    content: "latest v2",
  });
  // Exclude other workspaces when directly exercising the ordinary poll by making this VM the only candidate for its own task binding.
  expect(
    (
      (await (await f.request("/v1/daemon/poll?view=work", undefined, f.otherMachine)).json()) as {
        assignment: unknown;
      }
    ).assignment,
  ).toBeNull();
  const poll = (await (
    await f.request("/v1/daemon/poll?view=work", undefined, f.machine)
  ).json()) as { assignment: unknown };
  const assignment = Assignment.parse(poll.assignment);
  expect(assignment.task.id).toBe(work.task.id);
  expect(assignment.skill_binding?.revision).toBe(1);
  const server = Bun.serve({ port: 0, fetch: f.app.fetch });
  const tools = new ToolExecutor();
  try {
    const manager = new ExtensionManager(
      ky.create({
        prefixUrl: server.url.href,
        headers: { Authorization: `Bearer ${f.machine}` },
        retry: 0,
      }),
      tools,
    );
    const loaded = await manager.loadBound(assignment, AbortSignal.timeout(5000));
    expect(loaded?.content).toBe(f.draft.content);
    expect(
      (
        await f.request(
          `/v1/daemon/extensions/bound/${assignment.run_id}`,
          undefined,
          f.otherMachine,
        )
      ).status,
    ).toBe(404);
    const base = {
      kind: "skill_loaded",
      event_id: crypto.randomUUID(),
      run_id: assignment.run_id,
      skill_id: f.skill.id,
      revision: 1,
      content_hash: loaded?.content_hash,
    };
    expect(
      (await f.request("/v1/daemon/events", { ...base, content_hash: "0".repeat(64) }, f.machine))
        .status,
    ).toBe(409);
    expect((await f.request("/v1/daemon/events", base, f.machine)).status).toBe(200);
    expect((await f.request("/v1/daemon/events", base, f.machine)).status).toBe(200);
    const resumed = (await (
      await f.request(`/v1/daemon/resume/${assignment.run_id}`, {}, f.machine)
    ).json()) as { assignment: unknown };
    expect(Assignment.parse(resumed.assignment).skill_binding).toEqual(assignment.skill_binding);
    const history = (await (
      await f.request(`/v1/extensions/skills/${f.skill.id}/executions`)
    ).json()) as { executions: { loaded_run_id: string; checks: unknown[] }[] };
    expect(history.executions[0]?.loaded_run_id).toBe(assignment.run_id);
    expect(history.executions[0]?.checks).toEqual([]);
  } finally {
    await server.stop(true);
    await tools.close();
  }
});
test("pinned one-time schedule runs beside an unrelated task as one exact-version background execution", async () => {
  const f = await fixture(),
    busy = await f.start();
  const scheduleKey = crypto.randomUUID();
  const body = {
    conversation_id: busy.conversation_id,
    objective: "new input 8 + 9",
    due_at: new Date(Date.now() - 1000).toISOString(),
    timezone: "UTC",
    client_schedule_id: scheduleKey,
    skill_id: f.skill.id,
    skill_revision: 1,
  };
  expect((await f.request("/v1/schedules", body)).status).toBe(200);
  expect(
    (
      await f.request("/v1/schedules", {
        ...body,
        client_schedule_id: crypto.randomUUID(),
        skill_revision: null,
      })
    ).status,
  ).toBe(400);
  await f.request("/v1/extensions/skills", {
    ...f.draft,
    id: f.skill.id,
    expected_revision: 1,
    content: "head v2",
  });
  await dispatchDueSchedules(sql);
  await dispatchDueSchedules(sql);
  expect(
    (await sql`SELECT status FROM schedules WHERE client_schedule_id=${scheduleKey}`)[0]?.[
      "status"
    ],
  ).toBe("delivered");
  expect((await sql`SELECT lane FROM tasks WHERE id=${busy.task.id}`)[0]?.["lane"]).toBe("foreground");
  const executed =
    await sql`SELECT e.*,t.objective,t.lane FROM skill_executions e JOIN tasks t ON t.id=e.task_id WHERE e.skill_id=${f.skill.id} AND kind='scheduled'`;
  expect(executed).toHaveLength(1);
  expect(executed[0]?.["revision"]).toBe(1);
  expect(executed[0]?.["task_id"]).not.toBe(busy.task.id);
  expect(executed[0]?.["lane"]).toBe("background");
  expect(executed[0]?.["objective"]).toBe("new input 8 + 9");
});
test("completed turn never auto-certifies a method; explicit user check requires loaded execution result", async () => {
  const f = await fixture(),
    work = await f.start();
  const message = crypto.randomUUID();
  await sql`INSERT INTO messages(id,workspace_id,conversation_id,task_id,role,content) VALUES(${message},${f.workspace},${work.conversation_id},${work.task.id},'assistant','Total 9')`;
  await sql`UPDATE tasks SET state='succeeded' WHERE id=${work.task.id}`;
  const body = {
    client_check_id: crypto.randomUUID(),
    criterion: "sum of 2+3+4",
    observed: "Result message says 9; manually checked arithmetic",
    status: "pass",
    source_message_id: message,
  };
  const path = `/v1/extensions/skills/${f.skill.id}/executions/${work.execution_id}/checks`;
  expect((await f.request(path, body)).status).toBe(409);
  await sql`UPDATE skill_executions SET loaded_at=now() WHERE id=${work.execution_id}`;
  expect((await f.request(path, body)).status).toBe(201);
  expect((await f.request(path, body)).status).toBe(201);
  expect((await f.request(path, { ...body, status: "fail" })).status).toBe(409);
  const alien = await fixture();
  expect(
    (await alien.request(path, { ...body, client_check_id: crypto.randomUUID() })).status,
  ).toBe(409);
  const history = (await (
    await f.request(`/v1/extensions/skills/${f.skill.id}/executions`)
  ).json()) as { executions: { checks: { actor: string; status: string }[] }[] };
  expect(history.executions[0]?.checks).toHaveLength(1);
  expect(history.executions[0]?.checks[0]).toMatchObject({ actor: "user", status: "pass" });
});
test("daily responsibility preserves pinned revision and dispatches its bound action as a separate background task", async () => {
  const f = await fixture(),
    busy = await f.start("Every day sum new input 10 and 20.");
  const message = (
    await sql`SELECT id,content FROM messages WHERE task_id=${busy.task.id} AND role='user'`
  )[0];
  const body = {
    client_responsibility_id: crypto.randomUUID(),
    conversation_id: busy.conversation_id,
    vm_id: f.vm,
    source_message_id: message?.["id"],
    source_quote: message?.["content"],
    objective: "Calculate 10+20",
    trigger: { kind: "daily", hour: 9, minute: 0, timezone: "UTC" },
    skill_id: f.skill.id,
    skill_revision: 1,
  };
  const created = await f.request("/v1/responsibilities", body);
  expect(created.status).toBe(201);
  const { responsibility } = (await created.json()) as { responsibility: { id: string } };
  await f.request("/v1/extensions/skills", {
    ...f.draft,
    id: f.skill.id,
    expected_revision: 1,
    content: "changed v2",
  });
  await sql`UPDATE responsibilities SET next_review_at=now()-interval '1 minute' WHERE id=${responsibility.id}`;
  expect((await f.request("/v1/daemon/responsibilities", undefined, f.machine)).status).toBe(200);
  await f.request("/v1/daemon/responsibilities", undefined, f.machine);
  const rows =
    await sql`SELECT e.revision,e.kind,a.state,a.task_id,t.lane FROM responsibility_actions a JOIN skill_executions e ON e.task_id=a.task_id JOIN tasks t ON t.id=a.task_id WHERE a.responsibility_id=${responsibility.id}`;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ revision: 1, kind: "scheduled", state: "dispatched", lane: "background" });
  expect(rows[0]?.["task_id"]).not.toBe(busy.task.id);
});
test('archived skills remain rediscoverable only in explicit owned history listing',async()=>{
 const f=await fixture(),other=await fixture();
 await f.request(`/v1/extensions/skills/${f.skill.id}`,undefined,f.client,'DELETE');
 const read=async(path:string)=>await(await f.request(path)).json() as {skills:{id:string;archived_at:string|null;revision:number}[]};
 expect((await read(`/v1/extensions?vm_id=${f.vm}`)).skills).toEqual([]);
 const archived=await read(`/v1/extensions?vm_id=${f.vm}&include_archived=true`);
 expect(archived.skills).toHaveLength(1);expect(archived.skills[0]?.id).toBe(f.skill.id);expect(archived.skills[0]?.revision).toBe(1);expect(archived.skills[0]?.archived_at).toBeString();
 const foreign=await(await other.request(`/v1/extensions?vm_id=${f.vm}&include_archived=true`)).json() as {skills:unknown[]};expect(foreign.skills).toEqual([]);
 const manifest=await(await f.request('/v1/daemon/extensions',undefined,f.machine)).json() as {skills:unknown[]};expect(manifest.skills).toEqual([]);
 expect((await f.request(`/v1/extensions/skills/${archived.skills[0]?.id}/versions/1`)).status).toBe(200);
});
