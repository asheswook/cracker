import { test, expect } from "bun:test";
import { watch } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { createDatabase } from "../services/control/db.ts";
import { createApp } from "../services/control/app.ts";
import { hashToken } from "../services/control/auth.ts";
import { Runtime } from "../services/daemon/runtime.ts";
import { Journal } from "../services/daemon/journal.ts";
import { ToolExecutor } from "../services/daemon/tools.ts";
import type { Provider } from "../packages/provider/index.ts";
class CleanupFailure extends ToolExecutor{override async resetDesktop(workspace?:string):Promise<void>{if(!workspace)throw new TypeError("fixture release failure");await super.resetDesktop(workspace);}}
async function takeoverScenario(withEffect: boolean,cleanupFailure=false,kind:"takeover"|"stop"="takeover"): Promise<{ paused: string; returned: string }> {
  const sql = createDatabase(process.env["TEST_DATABASE_URL"] ?? "postgres://assistant:assistant@127.0.0.1:55439/assistant_dev");
  const workspace = crypto.randomUUID(), vm = crypto.randomUUID(), conversation = crypto.randomUUID(), task = crypto.randomUUID(), machine = crypto.randomUUID() + crypto.randomUUID(), client = crypto.randomUUID() + crypto.randomUUID();
  await sql`INSERT INTO assistant.workspaces(id,name) VALUES(${workspace},'takeover-runtime-pg')`;
  await sql`INSERT INTO assistant.vms(id,workspace_id,name) VALUES(${vm},${workspace},'vm')`;
  await sql`INSERT INTO assistant.credentials(token_hash,workspace_id,role,vm_id) VALUES(${await hashToken(machine)},${workspace},'vm',${vm}),(${await hashToken(client)},${workspace},'client',NULL)`;
  await sql`INSERT INTO assistant.conversations(id,workspace_id,title) VALUES(${conversation},${workspace},'takeover')`;
  await sql`INSERT INTO assistant.tasks(id,workspace_id,conversation_id,objective,state) VALUES(${task},${workspace},${conversation},'takeover fixture','queued')`;
  const app = createApp(sql), server = Bun.serve({ port: 0, fetch: app.fetch });
  const dir = await mkdtemp(join(tmpdir(), "pg-takeover-")), ready = Promise.withResolvers<void>(), file = join(dir, "effect.txt");
  const watcher = watch(dir, (_event, name) => { if (name === "effect.txt") ready.resolve(); });
  const provider: Provider = { respond: async (_input, _tools, signal) => {
    if (withEffect) return { id: "fixture", created_at: 0, output_text: "", error: null, incomplete_details: null, instructions: null, metadata: null, model: "fixture", object: "response", output: [{ type: "function_call", id: "tool", call_id: "call", name: "shell", arguments: JSON.stringify({ command: `printf effect > '${file}'; sleep 30` }) }], parallel_tool_calls: false, temperature: null, tool_choice: "auto", tools: [], top_p: null, status: "completed" };
    ready.resolve(); return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
  } };
  const journal = new Journal(":memory:"), runtime = new Runtime({ controlUrl: server.url.href, token: machine, journal, provider, tools: cleanupFailure?new CleanupFailure():new ToolExecutor() });
  try {
    await runtime.tick(); await ready.promise;
    const takeover = await app.request(kind==="stop"?`/v1/tasks/${task}/stop`:`/v1/vms/${vm}/control`, { method: "POST", headers: { Authorization: `Bearer ${client}`, "Content-Type": "application/json" }, body: JSON.stringify({ kind }) });
    if (takeover.status !== 200) throw new TypeError("Takeover request rejected");
    await runtime.tick();
    const paused = z.object({ state: z.string() }).parse((await sql`SELECT state FROM assistant.tasks WHERE id=${task}`)[0]).state;
    if(kind==="stop"){expect(z.object({status:z.string()}).parse((await sql`SELECT status FROM assistant.commands WHERE task_id=${task} AND kind='stop'`)[0]).status).toBe("failed");return {paused,returned:paused};}
    if(cleanupFailure){expect(journal.control()).toBe("agent");expect(z.object({control_state:z.string()}).parse((await sql`SELECT control_state FROM assistant.vms WHERE id=${vm}`)[0]).control_state).toBe("unknown");}
    const returned = await app.request(`/v1/vms/${vm}/control`, { method: "POST", headers: { Authorization: `Bearer ${client}`, "Content-Type": "application/json" }, body: JSON.stringify({ kind: "return_control" }) });
    if (returned.status !== 200) throw new TypeError("Return request rejected");
    await runtime.tick();
    if(!withEffect&&!cleanupFailure)expect((await sql`SELECT id FROM assistant.runs WHERE task_id=${task}`).length).toBe(1);
    return { paused, returned: z.object({ state: z.string() }).parse((await sql`SELECT state FROM assistant.tasks WHERE id=${task}`)[0]).state };
  } finally { watcher.close(); await runtime.stop(); journal.close(); await server.stop(true); await sql.end(); await rm(dir, { recursive: true }); }
}
test("provider-only takeover and return resumes the same checkpoint through actual PG control", async () => {
  // Given / When: drive actual runtime, user takeover, and return through HTTP and PostgreSQL.
  const result = await takeoverScenario(false);
  // Then
  expect(result).toEqual({ paused: "paused", returned: "running" });
});
test("interrupted real shell effect stays unknown after return through actual PG control", async () => {
  // Given / When: the same surface after a real side effect and process-group interruption.
  const result = await takeoverScenario(true);
  // Then
  expect(result).toEqual({ paused: "unknown", returned: "unknown" });
});

test("takeover and return fail closed when desktop release is unconfirmed through real PG",async()=>{const result=await takeoverScenario(false,true);expect(result).toEqual({paused:"unknown",returned:"unknown"});});

test("stop cannot acknowledge drained input after desktop cleanup failure",async()=>{expect(await takeoverScenario(false,true,"stop")).toEqual({paused:"unknown",returned:"unknown"});});

for(const fail of [false,true])test(`idle takeover waits for input release barrier; failure=${fail}`,async()=>{
 const sql=createDatabase(process.env['TEST_DATABASE_URL']??'postgres://assistant:assistant@127.0.0.1:55439/assistant_dev');
 const workspace=crypto.randomUUID(),vm=crypto.randomUUID(),machine=crypto.randomUUID()+crypto.randomUUID(),client=crypto.randomUUID()+crypto.randomUUID();
 await sql`INSERT INTO assistant.workspaces(id,name) VALUES(${workspace},'idle-input-barrier')`;
 await sql`INSERT INTO assistant.vms(id,workspace_id,name) VALUES(${vm},${workspace},'vm')`;
 await sql`INSERT INTO assistant.credentials(token_hash,workspace_id,role,vm_id) VALUES(${await hashToken(machine)},${workspace},'vm',${vm}),(${await hashToken(client)},${workspace},'client',NULL)`;
 const app=createApp(sql),server=Bun.serve({port:0,fetch:app.fetch}),journal=new Journal(':memory:');
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let barrierCalls=0;
 const runtime=new Runtime({controlUrl:server.url.href,token:machine,journal,tools:new ToolExecutor(),provider:{respond:async()=>{throw new TypeError('Idle runtime must not call provider');}},inputBarrier:async()=>{barrierCalls++;entered.resolve();await release.promise;if(fail)throw new TypeError('fixture input release failed');}});
 try{
  expect((await app.request(`/v1/vms/${vm}/control`,{method:'POST',headers:{Authorization:`Bearer ${client}`,'Content-Type':'application/json'},body:JSON.stringify({kind:'takeover'})})).status).toBe(200);
  const tick=runtime.tick();await entered.promise;
  expect(journal.control()).toBe('agent');
  expect(z.object({status:z.string()}).parse((await sql`SELECT status FROM assistant.commands WHERE vm_id=${vm}`)[0]).status).toBe('pending');
  release.resolve();await tick;
  expect(barrierCalls).toBe(1);expect(journal.control()).toBe(fail?'agent':'user');
  expect(z.object({control_state:z.string()}).parse((await sql`SELECT control_state FROM assistant.vms WHERE id=${vm}`)[0]).control_state).toBe(fail?'unknown':'user');
  expect(z.object({status:z.string()}).parse((await sql`SELECT status FROM assistant.commands WHERE vm_id=${vm}`)[0]).status).toBe(fail?'failed':'applied');
 }finally{release.resolve();await runtime.stop();journal.close();await server.stop(true);await sql.end();}
});
