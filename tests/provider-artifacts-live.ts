import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { createDatabase } from "../services/control/db.ts";
import { createApp } from "../services/control/app.ts";
import { hashToken } from "../services/control/auth.ts";
import { LocalArtifactStore } from "../packages/artifacts/local-store.ts";
import { Artifact, Message, Task } from "../packages/protocol/index.ts";
import { OpenAIProvider } from "../packages/provider/index.ts";
import { Runtime } from "../services/daemon/runtime.ts";
import { Journal } from "../services/daemon/journal.ts";
import { ToolExecutor } from "../services/daemon/tools.ts";
export async function artifactProbe(): Promise<void> {
  const sql = createDatabase(process.env["TEST_DATABASE_URL"] ?? "postgres://assistant:assistant@127.0.0.1:55439/assistant_dev");
  const workspace = crypto.randomUUID(), vm = crypto.randomUUID(), conversation = crypto.randomUUID(), clientToken = crypto.randomUUID() + crypto.randomUUID(), vmToken = crypto.randomUUID() + crypto.randomUUID();
  const dir = await mkdtemp(join(tmpdir(), "artifact-live-")), marker = `DOCUMENT_PROOF_${crypto.randomUUID()}`;
  const mode = z.enum(["api", "chatgpt"]).parse(process.env["PROBE_MODE"] ?? "api");
  const app = createApp(sql, { artifactStore: new LocalArtifactStore(join(dir, "store")) }), server = Bun.serve({ port: 0, fetch: app.fetch });
  const provider = new OpenAIProvider({ mode, model: "gpt-5.6-luna", ...(mode === "api" ? { apiKey: z.string().min(1).parse(process.env["OPENAI_API_KEY"]) } : { tokenFile: ".local/chatgpt.json" }) });
  const journal = new Journal(join(dir, "journal.sqlite"));
  const runtime = new Runtime({ controlUrl: server.url.href, token: vmToken, journal, provider, tools: new ToolExecutor(), artifactRoot: join(dir, "runs") });
  try {
    await sql`INSERT INTO assistant.workspaces(id,name) VALUES(${workspace},'artifact-live')`;
    await sql`INSERT INTO assistant.vms(id,workspace_id,name) VALUES(${vm},${workspace},'vm')`;
    await sql`INSERT INTO assistant.credentials(token_hash,workspace_id,role,vm_id) VALUES(${await hashToken(clientToken)},${workspace},'client',NULL),(${await hashToken(vmToken)},${workspace},'vm',${vm})`;
    await sql`INSERT INTO assistant.conversations(id,workspace_id,title) VALUES(${conversation},${workspace},'attachment probe')`;
    const uploaded: string[] = [];
    const fixtures = [
      { name: "source.txt", type: "text/plain", bytes: new TextEncoder().encode(`The secret marker for this test is ${marker}.`) },
      { name: "reference.png", type: "image/png", bytes: new Uint8Array(await Bun.file("apps/client/.omo/evidence/connected-empty.png").arrayBuffer()) }
    ];
    for (const fixture of fixtures) {
      const response = await app.request(`/v1/conversations/${conversation}/artifacts`, { method: "POST", headers: { Authorization: `Bearer ${clientToken}`, "X-Artifact-Id": crypto.randomUUID(), "X-Artifact-Name": fixture.name, "Content-Type": fixture.type }, body: new Blob([fixture.bytes]) });
      if (response.status !== 201) throw new TypeError(`Source upload failed ${response.status}`);
      uploaded.push(z.object({ artifact: Artifact }).parse(await response.json()).artifact.id);
    }
    const response = await app.request(`/v1/conversations/${conversation}/messages`, { method: "POST", headers: { Authorization: `Bearer ${clientToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ client_message_id: crypto.randomUUID(), content: "Read the attached source.txt document; the reference image is supplemental. Use shell to create a plain text file in OUTPUT_DIR containing only the exact secret marker from the document. Then call publish_artifact to attach that task-created file and report completion. Do not modify other files.", attachment_ids: uploaded }) });
    const task = z.object({ task: Task }).parse(await response.json()).task;
    await runtime.recover(); const started = Date.now(); let succeeded = false;
    while (Date.now() - started < 150000) {
      await runtime.tick();
      const current = z.object({ state: z.string() }).parse((await sql`SELECT state FROM assistant.tasks WHERE id=${task.id}`)[0]).state;
      if (current === "failed" || current === "unknown") throw new TypeError(`Runtime ${current}`);
      if (current === "succeeded") { succeeded = true; break; }
      await Bun.sleep(500);
    }
    const messageResponse = await app.request(`/v1/conversations/${conversation}/messages`, { headers: { Authorization: `Bearer ${clientToken}` } });
    const messages = z.object({ messages: z.array(Message) }).parse(await messageResponse.json()).messages;
    const output = messages.filter(m => m.role === "assistant").flatMap(m => m.attachments ?? []).find(a => !uploaded.includes(a.id));
    if (!succeeded || !output) throw new TypeError("No completed published output");
    const download = await app.request(`/v1/artifacts/${output.id}/content`, { headers: { Authorization: `Bearer ${clientToken}` } });
    const content = await download.text(); if (content.trim() !== marker) throw new TypeError("Published document marker mismatch");
    console.log(JSON.stringify({ verified_at: new Date().toISOString(), mode, model: "gpt-5.6-luna", surface: "actual model + local HTTP + PostgreSQL + object store + macOS shell", image_and_document_inputs: true, task_succeeded: succeeded, published_output_id: output.id, published_output_bytes: output.bytes, published_content_matches_document: true, output_store: dir, elapsed_ms: Date.now() - started }));
  } finally { await runtime.stop(); journal.close(); await server.stop(true); await sql`UPDATE assistant.credentials SET revoked_at=now() WHERE workspace_id=${workspace}`; await sql.end(); }
}
if (import.meta.main) {
  try { await artifactProbe(); }
  catch (error) { console.error(JSON.stringify({ failed: true, type: error instanceof Error ? error.name : "unknown", detail: error instanceof TypeError ? error.message : undefined })); process.exitCode = 1; }
}
