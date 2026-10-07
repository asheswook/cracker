import { expect, test } from "bun:test";
import { z } from "zod";
import { ownedScope } from "../packages/context/store-source.ts";
import { Principal } from "../services/control/auth.ts";
import { createDatabase, type Database } from "../services/control/db.ts";
import { appendMessage } from "../services/control/repository/common.ts";
import { updateComposing } from "../services/control/repository/composing.ts";

async function fixture() {
  const environment = z.object({ TEST_DATABASE_URL: z.string().optional() }).parse(process.env);
  const sql = createDatabase(environment.TEST_DATABASE_URL ?? "postgres://assistant:assistant@127.0.0.1:55439/semantic_context_1006");
  const workspace = crypto.randomUUID(), vm = crypto.randomUUID(), conversation = crypto.randomUUID(), task = crypto.randomUUID(), run = crypto.randomUUID();
  await sql`INSERT INTO assistant.workspaces(id,name) VALUES(${workspace},'semantic lock fixture')`;
  await sql`INSERT INTO assistant.vms(id,workspace_id,name) VALUES(${vm},${workspace},'fixture')`;
  await sql`INSERT INTO assistant.conversations(id,workspace_id,title) VALUES(${conversation},${workspace},'fixture')`;
  await sql`INSERT INTO assistant.tasks(id,workspace_id,conversation_id,objective,state) VALUES(${task},${workspace},${conversation},'fixture','running')`;
  await sql`INSERT INTO assistant.runs(id,workspace_id,task_id,vm_id,state) VALUES(${run},${workspace},${task},${vm},'running')`;
  return { sql, workspace, vm, conversation, task, run, principal: Principal.parse({ workspace_id: workspace, vm_id: vm, role: "vm" }) };
}
async function waitForBlock(sql: Database, pids: Readonly<{ waiting: number; holding: number }>) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const row = z.object({ blocked: z.boolean() }).parse((await sql`SELECT ${pids.holding}::int=ANY(pg_blocking_pids(${pids.waiting}::int)) AS blocked`)[0]);
    if (row.blocked) return;
    await Bun.sleep(5);
  }
  throw new TypeError("Transaction never reached the expected lock barrier");
}
for (const scenario of ["composing receipt FK", "conversation append"] as const) test(`metadata locking cannot deadlock ${scenario}`, async () => {
  const f = await fixture(), regularReady = Promise.withResolvers<number>(), metadataReady = Promise.withResolvers<number>(), proceed = Promise.withResolvers<void>();
  const regular = f.sql.begin(async tx => {
    await tx`SET LOCAL deadlock_timeout='100ms'`; await tx`SET LOCAL statement_timeout='4s'`;
    const { pid } = z.object({ pid: z.number() }).parse((await tx`SELECT pg_backend_pid() AS pid`)[0]);
    if (scenario === "composing receipt FK") await tx`SELECT id FROM assistant.vms WHERE id=${f.vm} FOR UPDATE`;
    else await tx`SELECT id FROM assistant.conversations WHERE id=${f.conversation} FOR UPDATE`;
    regularReady.resolve(pid); await proceed.promise;
    if (scenario === "composing receipt FK") return updateComposing(tx, f.principal, { kind: "begin", run_id: f.run, inference_id: crypto.randomUUID(), input_message_ids: [] });
    return appendMessage(tx, { workspace: f.workspace, conversation: f.conversation, content: "New input concurrent with metadata", clientId: crypto.randomUUID() });
  });
  const holder = await regularReady.promise;
  const metadata = f.sql.begin(async tx => {
    await tx`SET LOCAL deadlock_timeout='100ms'`; await tx`SET LOCAL statement_timeout='4s'`;
    const { pid } = z.object({ pid: z.number() }).parse((await tx`SELECT pg_backend_pid() AS pid`)[0]); metadataReady.resolve(pid);
    const scope = await ownedScope(tx, f.principal, f.run, true);
    await tx`SELECT id FROM assistant.conversations WHERE id=${scope.conversation_id} FOR UPDATE`;
    await tx`INSERT INTO assistant.semantic_context_mutations(workspace_id,operation_id,vm_id,request_hash,request,result) VALUES(${f.workspace},${crypto.randomUUID()},${f.vm},${'a'.repeat(64)},'{}'::jsonb,'{}'::jsonb)`;
    return scope;
  });
  const settled = Promise.allSettled([regular, metadata]);
  try {
    await waitForBlock(f.sql, { waiting: await metadataReady.promise, holding: holder }); proceed.resolve();
    const results = await settled;
    const codes = results.map(result => result.status === "rejected" ? z.object({ code: z.string() }).safeParse(result.reason).data?.code ?? "other" : "ok");
    console.log(JSON.stringify({ scenario, outcomes: results.map(result => result.status), codes }));
    expect(results.map(result => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(z.object({ count: z.coerce.number() }).parse((await f.sql`SELECT count(*) FROM assistant.semantic_context_mutations WHERE workspace_id=${f.workspace}`)[0]).count).toBe(1);
  } finally { proceed.resolve(); await settled; await f.sql.end(); }
});
test("live scope rechecks run and task state after waiting; backfill still permits terminal ownership", async () => {
  const f = await fixture(), held = Promise.withResolvers<number>(), metadataReady = Promise.withResolvers<number>(), release = Promise.withResolvers<void>();
  const finish = f.sql.begin(async tx => {
    await tx`SET LOCAL statement_timeout='4s'`;
    await tx`SELECT id FROM assistant.vms WHERE id=${f.vm} FOR UPDATE`;
    held.resolve(z.object({ pid: z.number() }).parse((await tx`SELECT pg_backend_pid() AS pid`)[0]).pid);
    await release.promise;
    await tx`UPDATE assistant.runs SET state='succeeded' WHERE id=${f.run}`;
    await tx`UPDATE assistant.tasks SET state='succeeded' WHERE id=${f.task}`;
  });
  const holder = await held.promise;
  const live = f.sql.begin(async tx => {
    await tx`SET LOCAL statement_timeout='4s'`;
    metadataReady.resolve(z.object({ pid: z.number() }).parse((await tx`SELECT pg_backend_pid() AS pid`)[0]).pid);
    return ownedScope(tx, f.principal, f.run, true);
  });
  const settled = Promise.allSettled([finish, live]);
  try {
    await waitForBlock(f.sql, { waiting: await metadataReady.promise, holding: holder }); release.resolve();
    const results = await settled;
    expect(results[0]?.status).toBe("fulfilled");
    const rejected = results[1]; if (rejected?.status !== "rejected") throw new TypeError("Live scope accepted terminal ownership");
    expect(z.object({ code: z.string() }).parse(rejected.reason).code).toBe("stale_run");
    const backfill = await f.sql.begin(tx => ownedScope(tx, f.principal, f.run, true, "backfill"));
    expect(backfill).toEqual({ task_id: f.task, conversation_id: f.conversation });
  } finally { release.resolve(); await settled; await f.sql.end(); }
});
