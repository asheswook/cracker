import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createDatabase } from "../services/control/db.ts";
import { createApp } from "../services/control/app.ts";
import { hashToken } from "../services/control/auth.ts";
import { OpenAIProvider } from "../packages/provider/index.ts";
import { ResponsibilityInput } from "../packages/memory/responsibility-schema.ts";
import { createResponsibility, snapshot, recordEvaluation } from "../packages/memory/responsibility-store.ts";
import { evaluateResponsibility } from "../packages/memory/responsibility-evaluate.ts";
import { Runtime } from "../services/daemon/runtime.ts";
import { Journal } from "../services/daemon/journal.ts";
import { ToolExecutor } from "../services/daemon/tools.ts";
export async function actionProbe(): Promise<void> {
  const sql = createDatabase(process.env["TEST_DATABASE_URL"] ?? "postgres://assistant:assistant@127.0.0.1:55439/assistant_dev");
  const workspace = crypto.randomUUID(), vm = crypto.randomUUID(), conversation = crypto.randomUUID(), watched = crypto.randomUUID(), source = crypto.randomUUID(), vmToken = crypto.randomUUID() + crypto.randomUUID();
  const dir = await mkdtemp(join(tmpdir(), "responsibility-action-")), file = join(dir, "proof.txt"), marker = `ACTION_PROOF_${crypto.randomUUID()}`;
  const provider = new OpenAIProvider({ mode: "api", model: "gpt-5.6-luna", apiKey: z.string().min(1).parse(process.env["OPENAI_API_KEY"]) });
  const server = Bun.serve({ port: 0, fetch: createApp(sql).fetch });
  const journal = new Journal(join(dir, "journal.sqlite"));
  const runtime = new Runtime({ controlUrl: server.url.href, token: vmToken, journal, provider, tools: new ToolExecutor() });
  try {
    await sql`INSERT INTO assistant.workspaces(id,name) VALUES(${workspace},'responsibility-action-live')`;
    await sql`INSERT INTO assistant.vms(id,workspace_id,name) VALUES(${vm},${workspace},'probe')`;
    await sql`INSERT INTO assistant.credentials(token_hash,workspace_id,role,vm_id) VALUES(${await hashToken(vmToken)},${workspace},'vm',${vm})`;
    await sql`INSERT INTO assistant.conversations(id,workspace_id,title) VALUES(${conversation},${workspace},'probe')`;
    await sql`INSERT INTO assistant.tasks(id,workspace_id,conversation_id,objective,state,reason) VALUES(${watched},${workspace},${conversation},'Create initial report','failed','Initial source unavailable')`;
    const objective = `When the initial report task fails, do this authorized harmless follow-up once: use shell to write exactly ${marker} without newline into ${file}, read it back, and report the observed result. Do not modify any other file. Merely notifying me of failure does not fulfill this responsibility.`;
    await sql`INSERT INTO assistant.messages(id,workspace_id,conversation_id,task_id,role,content) VALUES(${source},${workspace},${conversation},${watched},'user',${objective})`;
    const machine = { workspace_id: workspace, vm_id: vm, role: "vm" as const };
    const row = await createResponsibility(sql, { workspace_id: workspace, vm_id: null, role: "client" }, ResponsibilityInput.parse({ client_responsibility_id: crypto.randomUUID(), conversation_id: conversation, vm_id: vm, source_message_id: source, source_quote: objective, objective, trigger: { kind: "task_change", task_id: watched } }));
    const current = await snapshot(sql, row), evaluation = await evaluateResponsibility(provider, current, AbortSignal.timeout(120000));
    if (evaluation.outcome !== "action") throw new TypeError("Expected actual follow-up action");
    const request = { responsibility_id: row.id, context_hash: current.context_hash, evaluation };
    await recordEvaluation(sql, machine, request); await recordEvaluation(sql, machine, request);
    const action = z.object({ task_id: z.uuid() }).parse((await sql`SELECT task_id FROM assistant.responsibility_actions WHERE responsibility_id=${row.id} AND state='dispatched'`)[0]);
    await runtime.recover();
    const started = Date.now(); let succeeded = false;
    while (Date.now() - started < 120000) {
      await runtime.tick();
      const state = z.object({ state: z.string() }).parse((await sql`SELECT state FROM assistant.tasks WHERE id=${action.task_id}`)[0]).state;
      if (state === "unknown" || state === "failed") throw new TypeError("Follow-up runtime failed");
      if (state === "succeeded") { succeeded = true; break; }
      await Bun.sleep(500);
    }
    const count = z.object({ count: z.coerce.number() }).parse((await sql`SELECT count(*) AS count FROM assistant.responsibility_actions WHERE responsibility_id=${row.id} AND state='dispatched'`)[0]).count;
    if (!succeeded || count !== 1 || await readFile(file, "utf8") !== marker) throw new TypeError("Follow-up proof mismatch");
    console.log(JSON.stringify({ verified_at: new Date().toISOString(), mode: "api", model: "gpt-5.6-luna", surface: "macOS shell + real model + local HTTP control + PostgreSQL", evaluator_outcome: evaluation.outcome, dispatched_tasks: count, task_succeeded: succeeded, shell_artifact: file, shell_content_matches: true }));
  } finally { await runtime.stop(); journal.close(); await server.stop(true); await sql.end(); }
}
if (import.meta.main) {
  try { await actionProbe(); }
  catch (error) { console.error(JSON.stringify({ failed: true, type: error instanceof Error ? error.name : "unknown" })); process.exitCode = 1; }
}
