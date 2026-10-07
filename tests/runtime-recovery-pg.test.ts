import { test, expect } from "bun:test";
import { createDatabase } from "../services/control/db.ts";
import { createApp } from "../services/control/app.ts";
import { hashToken } from "../services/control/auth.ts";
import { Journal } from "../services/daemon/journal.ts";
import { Runtime } from "../services/daemon/runtime.ts";
import { ToolExecutor } from "../services/daemon/tools.ts";

test("stale remote events retain rejected evidence without poisoning reconnect", async () => {
  // Given PostgreSQL has already quarantined a run, but local events remain pending.
  const sql = createDatabase(process.env["TEST_DATABASE_URL"] ?? "postgres://assistant:assistant@127.0.0.1:55439/assistant_dev");
  const workspace = crypto.randomUUID(), vm = crypto.randomUUID(), conversation = crypto.randomUUID(), task = crypto.randomUUID(), run = crypto.randomUUID(), token = crypto.randomUUID() + crypto.randomUUID();
  await sql`INSERT INTO assistant.workspaces(id,name) VALUES(${workspace},'recovery-regression')`;
  await sql`INSERT INTO assistant.vms(id,workspace_id,name) VALUES(${vm},${workspace},'vm')`;
  await sql`INSERT INTO assistant.credentials(token_hash,workspace_id,role,vm_id) VALUES(${await hashToken(token)},${workspace},'vm',${vm})`;
  await sql`INSERT INTO assistant.conversations(id,workspace_id,title) VALUES(${conversation},${workspace},'recovery')`;
  await sql`INSERT INTO assistant.tasks(id,workspace_id,conversation_id,objective,state) VALUES(${task},${workspace},${conversation},'recovery','unknown')`;
  await sql`INSERT INTO assistant.runs(id,workspace_id,task_id,vm_id,state) VALUES(${run},${workspace},${task},${vm},'unknown')`;
  const journal = new Journal(":memory:"), server = Bun.serve({ port: 0, fetch: createApp(sql).fetch });
  const message = { kind: "message", event_id: crypto.randomUUID(), run_id: run, content: "late result retained locally" } as const;
  const completed = { kind: "state", event_id: crypto.randomUUID(), run_id: run, state: "succeeded", reason: null } as const;
  journal.enqueue(message); journal.enqueue(completed);
  const runtime = new Runtime({ controlUrl: server.url.href, token, journal, tools: new ToolExecutor(), provider: { respond: async () => { throw new TypeError("No inference expected"); } } });
  // When
  await runtime.flush(); await runtime.tick();
  // Then neither event retries forever, neither is lost, and no model/tool was replayed.
  try { expect(journal.pending()).toEqual([]); expect(journal.rejected()).toEqual([{ event: message, reason: "stale_run" }, { event: completed, reason: "stale_run" }]); }
  finally { await runtime.stop(); journal.close(); await server.stop(true); await sql.end(); }
});
