import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Response, ResponseOutputItem } from "openai/resources/responses/responses";
import type { Provider, ResponseInputItem } from "../packages/provider/index.ts";
import { Message, Task } from "../packages/protocol/index.ts";
import { FutureWork, FutureWorkListResult, FutureWorkMutationResult } from "../packages/proactive/schema.ts";
import { Runtime } from "../services/daemon/runtime.ts";
import { Journal } from "../services/daemon/journal.ts";
import { ToolExecutor } from "../services/daemon/tools.ts";
import { controlFixture } from "./control-fixture.ts";

const f = controlFixture();
class CompletedJournal extends Journal {
  readonly done = Promise.withResolvers<void>();
  override finish(run: string): void { super.finish(run); this.done.resolve(); }
}
function response(output: ResponseOutputItem[]): Response {
  return { id: crypto.randomUUID(), created_at: 0, output_text: "", error: null, incomplete_details: null, instructions: null, metadata: null, model: "fixture", object: "response", output, parallel_tool_calls: false, temperature: null, tool_choice: "auto", tools: [], top_p: null, status: "completed" };
}
function result(input: ResponseInputItem[]): unknown {
  const item = input.findLast(entry => entry.type === "function_call_output");
  if (!item || item.type !== "function_call_output") throw new TypeError("Missing tool result");
  return JSON.parse(z.string().parse(item.output));
}

test("runtime edits and cancels the same responsibility through durable management tools", async () => {
  const conversation = await f.newConversation();
  const quote = "Create a daily noon routine, add submission reminders to it, then cancel it for this test.";
  const created = z.object({ message: Message, task: Task }).parse(await (await f.request(`/v1/conversations/${conversation.id}/messages`, f.client, { client_message_id: crypto.randomUUID(), content: quote })).json());
  const source = { source_message_id: created.message.id, source_quote: quote };
  const directory = await mkdtemp(join(tmpdir(), "future-work-runtime-"));
  const server = Bun.serve({ port: 0, fetch: f.app.fetch });
  const journal = new CompletedJournal(join(directory, "journal.sqlite"));
  let round = 0;
  let registeredId = "";
  let originalDue = "";
  let current: z.infer<typeof FutureWork> | undefined;
  const provider: Provider = {
    async respond(input, tools) {
      round++;
      const call = (name: string, args: unknown) => response([{ type: "function_call", call_id: `future-work-${round}`, name, arguments: JSON.stringify(args) }]);
      switch (round) {
        case 1:
          expect(tools.filter(tool => tool.type === "function").map(tool => tool.name)).toEqual(expect.arrayContaining(["list_future_work", "update_future_work", "cancel_future_work"]));
          return call("create_responsibility", { ...source, objective: "Synthetic noon routine", title: "점심 루틴", trigger_kind: "daily", hour: 12, minute: 0, timezone: "Asia/Seoul", due_at: null, task_id: null, interval_minutes: null, until_at: null });
        case 2: {
          const saved = z.object({ responsibility: z.object({ id: z.uuid(), next_review_at: z.string() }) }).parse(result(input)).responsibility;
          registeredId = saved.id;
          originalDue = saved.next_review_at;
          return call("list_future_work", { query: "Synthetic noon routine", include_inactive: false, cursor: null });
        }
        case 3: {
          current = FutureWorkListResult.parse(result(input)).items.find(item => item.id === registeredId);
          if (!current || current.kind !== "responsibility") throw new TypeError("Missing registered responsibility");
          return call("update_future_work", { ...source, work: { kind: current.kind, id: current.id, expected_version: current.version, configuration: { ...current.configuration, objective: "Synthetic noon routine, including submission reminders" } } });
        }
        case 4: {
          current = FutureWorkMutationResult.parse(result(input)).work;
          expect(current.id).toBe(registeredId);
          expect(Date.parse(current.next_due_at)).toBe(Date.parse(originalDue));
          return call("cancel_future_work", { ...source, target: { kind: current.kind, id: current.id, expected_version: current.version } });
        }
        case 5: {
          current = FutureWorkMutationResult.parse(result(input)).work;
          return response([{ type: "message", id: "done", role: "assistant", status: "completed", phase: "final_answer", content: [{ type: "output_text", text: "The test routine has been cancelled.", annotations: [] }] }]);
        }
        default: throw new TypeError("Unexpected model round");
      }
    },
  };
  const runtime = new Runtime({ controlUrl: server.url.href, token: f.machine, journal, provider, tools: new ToolExecutor(), artifactRoot: directory });
  try {
    await runtime.tick();
    await journal.done.promise;
    await runtime.flush();
    expect(round).toBe(5);
    expect(current).toMatchObject({ id: registeredId, state: "cancelled", configuration: { objective: "Synthetic noon routine, including submission reminders" } });
    const rows = await f.sql`SELECT id,state FROM assistant.responsibilities WHERE conversation_id=${conversation.id}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: registeredId, state: "cancelled" });
    expect((await f.sql`SELECT state FROM assistant.tasks WHERE id=${created.task.id}`)[0]?.["state"]).toBe("succeeded");
  } finally {
    await runtime.stop();
    journal.close();
    await server.stop(true);
    await f.sql`UPDATE assistant.responsibilities SET state='cancelled' WHERE workspace_id=${f.workspace}`;
    await rm(directory, { recursive: true, force: true });
  }
});
