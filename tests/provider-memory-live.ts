import { retentionContext } from "../packages/memory/retention-store";
import { z } from "zod";
import { createDatabase } from "../services/control/db.ts";
import { OpenAIProvider } from "../packages/provider/index.ts";
import { extractMemory } from "../packages/memory/extract.ts";
import { persistExtraction, retrieveMemory } from "../packages/memory/persist.ts";
export async function liveMemoryProbe(): Promise<void> {
  const sql = createDatabase(process.env["TEST_DATABASE_URL"] ?? "postgres://assistant:assistant@127.0.0.1:55439/assistant_dev");
  const provider = new OpenAIProvider({ mode: "api", model: "gpt-5.6-luna", apiKey: z.string().min(1).parse(process.env["OPENAI_API_KEY"]) });
  const workspace = crypto.randomUUID(), vm = crypto.randomUUID(), conversation = crypto.randomUUID(), task = crypto.randomUUID(), run = crypto.randomUUID();
  const started = new Date().toISOString();
  try {
    await sql`INSERT INTO workspaces(id,name) VALUES(${workspace},'live-memory-probe')`;
    await sql`INSERT INTO vms(id,workspace_id,name) VALUES(${vm},${workspace},'probe')`;
    await sql`INSERT INTO conversations(id,workspace_id,title) VALUES(${conversation},${workspace},'probe')`;
    await sql`INSERT INTO tasks(id,workspace_id,conversation_id,objective,state) VALUES(${task},${workspace},${conversation},'probe','succeeded')`;
    await sql`INSERT INTO runs(id,workspace_id,task_id,vm_id,state) VALUES(${run},${workspace},${task},${vm},'succeeded')`;
    const reports = [];
    for (const scenario of [
      { name: "project_decision", role: "user", content: "For this product only, I have decided to use Cloudflare instead of Temporal. This is not a preference for other projects." },
      { name: "assistant_hypothesis", role: "assistant", content: "An unverified hypothesis: Redis might improve this cache. The user has not selected Redis and no benchmark has been run." },
      { name: "explicit_correction", role: "user", content: "Correction to my earlier product decision: this product now uses Temporal, not Cloudflare. Supersede my earlier choice. This takes effect on October 1, 2026." }
    ] as const) {
      const source = z.object({ id: z.uuid(), role: z.enum(["user", "assistant", "system"]), content: z.string(), created_at: z.string(), sequence: z.coerce.number().int() }).parse((await sql`INSERT INTO messages(workspace_id,conversation_id,task_id,role,content) VALUES(${workspace},${conversation},${task},${scenario.role},${scenario.content}) RETURNING id,role,content,created_at,sequence`)[0]);
      const extracted = await extractMemory(provider, { sources: [source], retention_context: await retentionContext(sql, { workspace, task }), known: await retrieveMemory(sql, workspace, conversation) }, AbortSignal.timeout(120000));
      const semanticPass = scenario.name === "project_decision"
        ? extracted.extraction.claims.some(c => c.kind === "decision" && c.epistemic_status === "reported")
        : scenario.name === "assistant_hypothesis"
          ? extracted.extraction.claims.every(c => c.kind !== "decision" && c.epistemic_status === "inferred")
          : extracted.extraction.claims.some(c => c.correction && c.supersedes_id !== null);
      if (!semanticPass) throw new TypeError(`Semantic acceptance failed: ${scenario.name}`);
      const persisted = await persistExtraction(sql, { workspace_id: workspace, vm_id: vm, role: "vm" }, { ...extracted, run_id: run, derivation_id: crypto.randomUUID(), source_ids: [source.id] });
      reports.push({ scenario: scenario.name, semantic_pass: semanticPass, persisted: persisted.count, claims: extracted.extraction.claims });
    }
    console.log(JSON.stringify({ started, completed: new Date().toISOString(), model: "gpt-5.6-luna", mode: "api", reports }, null, 2));
  } finally { await sql.end(); }
}
if (import.meta.main) {
  try { await liveMemoryProbe(); }
  catch (error) { console.error(JSON.stringify({ failed: true, error_type: error instanceof Error ? error.name : "unknown" })); process.exitCode = 1; }
}
