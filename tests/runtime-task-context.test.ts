import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Response, ResponseOutputItem } from "openai/resources/responses/responses";
import type { Provider, ResponseInputItem } from "../packages/provider";
import { createDatabase } from "../services/control/db";
import { createApp } from "../services/control/app";
import { hashToken } from "../services/control/auth";
import { Runtime } from "../services/daemon/runtime";
import { Journal } from "../services/daemon/journal";
import { ToolExecutor } from "../services/daemon/tools";
class CompletionJournal extends Journal {
  next = Promise.withResolvers<void>();
  override finish(run: string) {
    super.finish(run);
    this.next.resolve();
  }
}
function completed(output: ResponseOutputItem[]): Response {
  return {
    id: crypto.randomUUID(),
    created_at: 0,
    output_text: "",
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    model: "fixture",
    object: "response",
    output,
    parallel_tool_calls: false,
    temperature: null,
    tool_choice: "auto",
    tools: [],
    top_p: null,
    status: "completed",
  };
}
const answer = (text: string): ResponseOutputItem => ({
  type: "message",
  id: crypto.randomUUID(),
  role: "assistant",
  status: "completed",
  phase: "final_answer",
  content: [{ type: "output_text", text, annotations: [] }],
});
test("same-task steering skips stale effects while next task receives fresh source context", async () => {
  // Given real PG/Hono, SQLite and shell adapter; fixture model controls arrival timing only.
  const sql = createDatabase(
    process.env["TEST_DATABASE_URL"] ?? "postgres://assistant:assistant@127.0.0.1:55439/assistant_dev",
  );
  const workspace = crypto.randomUUID(),
    vm = crypto.randomUUID(),
    conversation = crypto.randomUUID(),
    old = crypto.randomUUID(),
    task = crypto.randomUUID(),
    nextTask = crypto.randomUUID(),
    token = crypto.randomUUID() + crypto.randomUUID();
  const directory = await mkdtemp(join(tmpdir(), "context-steering-")),
    proof = join(directory, "unwanted-effect"),
    journal = new CompletionJournal(":memory:"),
    history: ResponseInputItem[][] = [];
  const app = createApp(sql),
    server = Bun.serve({ port: 0, fetch: app.fetch });
  const provider: Provider = {
    respond: async (input, tools) => {
      if (tools.length === 0)
        return completed([answer(JSON.stringify({ schema_version: 1, claims: [] }))]);
      history.push([...input]);
      if (history.length === 1) {
        await sql`INSERT INTO assistant.messages(workspace_id,conversation_id,task_id,role,content) VALUES(${workspace},${conversation},${task},'user','steering-source'),(${workspace},${conversation},${old},'assistant','late-unrelated-source')`;
        return completed([
          {
            type: "function_call",
            call_id: "stale-effect",
            name: "shell",
            arguments: JSON.stringify({ command: `touch '${proof}'` }),
          },
        ]);
      }
      return completed([answer("fixture final")]);
    },
  };
  const runtime = new Runtime({
    controlUrl: server.url.href,
    token,
    journal,
    provider,
    tools: new ToolExecutor(),
    artifactRoot: directory,
  });
  try {
    await sql`INSERT INTO assistant.workspaces(id,name) VALUES(${workspace},'context-steering')`;
    await sql`INSERT INTO assistant.vms(id,workspace_id,name) VALUES(${vm},${workspace},'fixture')`;
    await sql`INSERT INTO assistant.credentials(token_hash,workspace_id,role,vm_id) VALUES(${await hashToken(token)},${workspace},'vm',${vm})`;
    await sql`INSERT INTO assistant.conversations(id,workspace_id,title) VALUES(${conversation},${workspace},'feed')`;
    await sql`INSERT INTO assistant.tasks(id,workspace_id,conversation_id,objective,state,created_at) VALUES(${old},${workspace},${conversation},'old','succeeded','2026-01-01'),(${task},${workspace},${conversation},'current','queued','2026-02-01')`;
    await sql`INSERT INTO assistant.messages(workspace_id,conversation_id,task_id,role,content) VALUES(${workspace},${conversation},${old},'user',${"old-original" + "x".repeat(2000) + "original-tail"}),(${workspace},${conversation},${task},'user','initial-source')`;
    // When steering arrives after inference but before action dispatch.
    await runtime.tick();
    await journal.next.promise;
    await runtime.flush();
    expect(await Bun.file(proof).exists()).toBe(false);
    expect(history).toHaveLength(2);
    expect(
      history[1]?.some((item) => "content" in item && item.content === "steering-source"),
    ).toBe(true);
    expect(
      history[1]?.some((item) => "content" in item && item.content === "late-unrelated-source"),
    ).toBe(false);
    expect(
      history[1]?.some(
        (item) => item.type === "function_call_output" && item.call_id === "stale-effect",
      ),
    ).toBe(true);
    expect(JSON.stringify(history[0])).not.toContain("original-tail");
    // When a new task starts in the same feed after the first terminal boundary.
    journal.next = Promise.withResolvers<void>();
    await sql`INSERT INTO assistant.tasks(id,workspace_id,conversation_id,objective,state,created_at) VALUES(${nextTask},${workspace},${conversation},'next','queued','2026-03-01')`;
    await sql`INSERT INTO assistant.messages(workspace_id,conversation_id,task_id,role,content) VALUES(${workspace},${conversation},${nextTask},'user','next-source')`;
    await runtime.tick();
    await journal.next.promise;
    await runtime.flush();
    // Then source originals and API tool pairs stay inside their own task.
    expect(history).toHaveLength(3);
    expect(history[2]?.some((item) => "content" in item && item.content === "next-source")).toBe(
      true,
    );
    expect(history[2]?.some((item) => "content" in item && item.content === "initial-source")).toBe(
      false,
    );
    expect(
      history[2]?.some(
        (item) => item.type === "function_call" || item.type === "function_call_output",
      ),
    ).toBe(false);
  } finally {
    await runtime.stop();
    journal.close();
    await server.stop(true);
    await sql`UPDATE assistant.credentials SET revoked_at=now() WHERE workspace_id=${workspace}`;
    await sql.end();
    await rm(directory, { recursive: true, force: true });
  }
});
