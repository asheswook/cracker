import { z } from "zod";
import { createDatabase } from "../services/control/db.ts";
import { OpenAIProvider } from "../packages/provider/index.ts";
import { createResponsibility, snapshot, recordEvaluation, dueResponsibilities } from "../packages/memory/responsibility-store.ts";
import { ResponsibilityInput } from "../packages/memory/responsibility-schema.ts";
import { evaluateResponsibility } from "../packages/memory/responsibility-evaluate.ts";
export async function responsibilityProbe(): Promise<void> {
  const sql = createDatabase(process.env["TEST_DATABASE_URL"] ?? "postgres://assistant:assistant@127.0.0.1:55439/assistant_dev");
  const workspace = crypto.randomUUID(), vm = crypto.randomUUID(), conversation = crypto.randomUUID(), task = crypto.randomUUID(), source = crypto.randomUUID();
  const provider = new OpenAIProvider({ mode: "api", model: "gpt-5.6-luna", apiKey: z.string().min(1).parse(process.env["OPENAI_API_KEY"]) });
  try {
    await sql`INSERT INTO assistant.workspaces(id,name) VALUES(${workspace},'responsibility-live')`;
    await sql`INSERT INTO assistant.vms(id,workspace_id,name) VALUES(${vm},${workspace},'probe')`;
    await sql`INSERT INTO assistant.conversations(id,workspace_id,title) VALUES(${conversation},${workspace},'probe')`;
    await sql`INSERT INTO assistant.tasks(id,workspace_id,conversation_id,objective,state,reason) VALUES(${task},${workspace},${conversation},'Compile report','failed','Source document unavailable')`;
    const content = "Notify me once if the report task fails; do not attempt to fix it.";
    await sql`INSERT INTO assistant.messages(id,workspace_id,conversation_id,task_id,role,content) VALUES(${source},${workspace},${conversation},${task},'user',${content})`;
    const machine = { workspace_id: workspace, vm_id: vm, role: "vm" as const };
    const row = await createResponsibility(sql, { workspace_id: workspace, vm_id: null, role: "client" }, ResponsibilityInput.parse({ client_responsibility_id: crypto.randomUUID(), conversation_id: conversation, vm_id: vm, source_message_id: source, source_quote: content, objective: content, trigger: { kind: "task_change", task_id: task } }));
    const current = await snapshot(sql, row);
    const evaluation = await evaluateResponsibility(provider, current, AbortSignal.timeout(120000));
    if (evaluation.outcome !== "notify") throw new TypeError("Failed task did not produce a notification decision");
    const request = { responsibility_id: row.id, context_hash: current.context_hash, evaluation };
    await recordEvaluation(sql, machine, request); await recordEvaluation(sql, machine, request);
    const notificationCount = z.object({ count: z.coerce.number() }).parse((await sql`SELECT count(*) AS count FROM assistant.messages WHERE conversation_id=${conversation} AND role='assistant'`)[0]).count;
    const unchanged = await dueResponsibilities(sql, machine);
    const state = z.object({ state: z.string() }).parse((await sql`SELECT state FROM assistant.tasks WHERE id=${task}`)[0]).state;
    if (notificationCount !== 1 || unchanged.length !== 0 || state !== "failed") throw new TypeError("Responsibility persistence invariant failed");
    console.log(JSON.stringify({ verified_at: new Date().toISOString(), mode: "api", model: "gpt-5.6-luna", outcome: evaluation.outcome, notification_count: notificationCount, repeated_context_silent: true, failed_task_preserved: true, notification: evaluation.notification }));
  } finally { await sql.end(); }
}
if (import.meta.main) {
  try { await responsibilityProbe(); }
  catch (error) { console.error(JSON.stringify({ failed: true, type: error instanceof Error ? error.name : "unknown" })); process.exitCode = 1; }
}
