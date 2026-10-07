import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Response as ModelResponse, ResponseOutputItem } from "openai/resources/responses/responses";
import type { Assignment } from "../packages/protocol/index.ts";
import type { Provider, ResponseInputItem } from "../packages/provider/index.ts";
import { Runtime } from "../services/daemon/runtime.ts";
import { Journal } from "../services/daemon/journal.ts";
import { ToolExecutor } from "../services/daemon/tools.ts";

class CompletedJournal extends Journal {
  readonly done = Promise.withResolvers<void>();
  override finish(run: string): void { super.finish(run); this.done.resolve(); }
}
class InertNavigation extends ToolExecutor {
  count = 0;
  override async run() {
    // Same semantic view, distinct frame bytes: a clock changes, navigation does not.
    const tick = ++this.count;
    return { text: JSON.stringify({ ok: true, view: "report", unsaved: true, clock: tick }), images: [`data:image/png;base64,${Buffer.from(`inert-report-frame-${tick}`).toString("base64")}`] };
  }
}
function response(output: ResponseOutputItem[]): ModelResponse {
  return { id: crypto.randomUUID(), object: "response", created_at: 0, output, output_text: "", model: "fixture", error: null, incomplete_details: null, instructions: null, metadata: null, parallel_tool_calls: false, temperature: null, top_p: null, tool_choice: "auto", tools: [], status: "completed" };
}
for (const family of ["chatgpt", "anthropic"] as const) test(`${family} runtime retains task context and observations across changing-frame no-op navigation`, async () => {
  const root = await mkdtemp(join(tmpdir(), "navigation-guidance-"));
  const assignment: Assignment = {
    run_id: crypto.randomUUID(), task: { id: crypto.randomUUID(), conversation_id: crypto.randomUUID(), objective: "Return to the list while preserving the unsaved report.", state: "running", reason: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    messages: [], instructions: "Preserve the current unsaved form. Do not submit it.", memory: [],
    model_binding: { revision_id: null, selection: family === "chatgpt" ? { provider: "chatgpt", model: "gpt-6-astra", reasoning_effort: "low" } : { provider: "anthropic", model: "claude-sonnet-4-6", reasoning_effort: null } },
  };
  let assigned = false;
  const server = Bun.serve({ port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/v1/daemon/extensions") return Response.json({ skills: [], servers: [] });
    if (path === "/v1/daemon/poll") { const work = assigned ? null : assignment; assigned = true; return Response.json({ assignment: work, commands: [], messages: [] }); }
    return Response.json({ messages: [], accepted: true });
  } });
  const journal = new CompletedJournal(":memory:"), tools = new InertNavigation(), history: ResponseInputItem[][] = [];
  const provider: Provider = { respond: async (input) => {
    history.push(structuredClone(input));
    const round = history.length;
    return response(round <= 7 ? [{ type: "function_call", call_id: `inert-${round}`, name: "computer_exec", arguments: JSON.stringify({ code: "await desktop.click(30, 40)", timeout_ms: 1000 }) }] : [{ type: "message", id: "done", role: "assistant", status: "completed", phase: "final_answer", content: [{ type: "output_text", text: "Fixture ended; navigation was not achieved.", annotations: [] }] }]);
  } };
  const runtime = new Runtime({ controlUrl: server.url.href, token: "inert-fixture", journal, provider, tools, artifactRoot: root });
  try {
    await runtime.tick(); await journal.done.promise; await runtime.flush();
    expect(history).toHaveLength(8); expect(tools.count).toBe(7);
    for (const input of history) {
      const system = input.flatMap(item => "role" in item && item.role === "system" && "content" in item && typeof item.content === "string" ? [item.content] : []).join("\n");
      expect(system.includes("<conversation_behavior>")).toBe(family === "anthropic");
      expect(system).not.toContain("Visual observation note:");
      expect(system).toContain(assignment.instructions);
    }
    const last = history.at(-1) ?? [];
    const observations = last.filter(item => item.type === "function_call_output");
    expect(observations).toHaveLength(7);
    expect(observations.every(item => item.type === "function_call_output" && String(item.output).includes('"view":"report"'))).toBe(true);
    const images = last.flatMap(item => "content" in item && Array.isArray(item.content) ? item.content.filter(part => part.type === "input_image") : []);
    expect(images).toHaveLength(2);
    expect(new Set(images.map(image => image.image_url)).size).toBe(2);
    expect(images.every(image => image.detail === "original")).toBe(true);
  } finally { await runtime.stop(); journal.close(); await server.stop(true); await rm(root, { recursive: true, force: true }); }
});
