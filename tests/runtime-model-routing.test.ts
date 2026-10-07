import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Response, ResponseOutputItem } from "openai/resources/responses/responses";
import { ModelAccess, type ModelBinding } from "../packages/models/schema.ts";
import { Runtime } from "../services/daemon/runtime.ts";
import { Journal } from "../services/daemon/journal.ts";
import { ToolExecutor } from "../services/daemon/tools.ts";
import type { RunModelResolver } from "../services/daemon/model-resolver.ts";
import { controlFixture } from "./control-fixture.ts";

const f = controlFixture();
class CompletedJournal extends Journal {
  readonly done = Promise.withResolvers<void>();
  override finish(run: string): void { super.finish(run); this.done.resolve(); }
}
function response(output: ResponseOutputItem[]): Response {
  return { id: crypto.randomUUID(), created_at: 0, output_text: "", error: null, incomplete_details: null, instructions: null, metadata: null, model: "fixture", object: "response", output, parallel_tool_calls: false, temperature: null, tool_choice: "auto", tools: [], top_p: null, status: "completed" };
}
test("runtime holds its selected provider for all tool turns and releases it when finished", async () => {
  const selection = { provider: "chatgpt", model: "gpt-6-astra", reasoning_effort: "low" } as const;
  await f.request("/v1/daemon/model-settings/defaults", f.machine, { selection, available: ["chatgpt"] });
  const { task } = await f.newTask();
  const server = Bun.serve({ port: 0, fetch: f.app.fetch }), directory = await mkdtemp(join(tmpdir(), "model-routing-"));
  const journal = new CompletedJournal(":memory:");
  const bindings: (ModelBinding | undefined)[] = [];
  let rounds = 0, released = 0;
  const models: RunModelResolver = {
    forRun: async (run, _signal, expected) => {
      const stored = ModelAccess.parse(await (await f.request(`/v1/daemon/model-settings/runs/${run}`, f.machine)).json());
      expect(stored.binding).toEqual(expected ?? null);
      bindings.push(expected);
      return { provider: { respond: async (input) => {
        rounds++;
        if (rounds === 1) {
          expect(JSON.stringify(input)).toContain("For the Responses API");
          await f.request("/v1/model-settings", f.client, { vm_id: f.vm, expected_revision_id: null, selection: { ...selection, model: "gpt-6-luna" } }, "PUT");
          return response([{ type: "function_call", call_id: "proof", name: "shell", arguments: JSON.stringify({ command: "printf 'routing-proof'" }) }]);
        }
        expect(input.some(item => item.type === "function_call_output" && String(item.output).includes("routing-proof"))).toBe(true);
        return response([{ type: "message", id: "answer", role: "assistant", status: "completed", phase: "final_answer", content: [{ type: "output_text", text: "Verified result.", annotations: [] }] }]);
      } }, release: async () => { released++; } };
    },
    current: async () => { throw new TypeError("No responsibility job expected"); },
  };
  const runtime = new Runtime({ controlUrl: server.url.href, token: f.machine, journal, models, provider: { respond: async () => { throw new TypeError("Legacy provider must not run"); } }, tools: new ToolExecutor(), artifactRoot: directory });
  try {
    await runtime.tick(); await journal.done.promise; await runtime.flush(); await runtime.stop();
    expect(rounds).toBe(2);
    expect(bindings).toEqual([{ revision_id: null, selection }]);
    expect(released).toBe(1);
    expect(z.object({ state: z.string() }).parse((await f.sql`SELECT state FROM assistant.tasks WHERE id=${task.id}`)[0]).state).toBe("succeeded");
  } finally {
    await runtime.stop(); journal.close(); await server.stop(true); await rm(directory, { recursive: true, force: true });
  }
});
