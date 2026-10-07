import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Response as ModelResponse } from "openai/resources/responses/responses";
import { DaemonEvent, type Assignment, type Message } from "../packages/protocol/index.ts";
import { ComposingRequest } from "../packages/protocol/composing.ts";
import type { Provider, ResponseInputItem } from "../packages/provider/index.ts";
import { Runtime } from "../services/daemon/runtime.ts";
import { Journal } from "../services/daemon/journal.ts";
import { ToolExecutor } from "../services/daemon/tools.ts";

class ObservedJournal extends Journal {
  readonly finished = Promise.withResolvers<void>();
  override finish(run: string): void { super.finish(run); this.finished.resolve(); }
}
function finalResponse(): ModelResponse {
  return { id: "fixture", created_at: 0, output_text: "", error: null, incomplete_details: null, instructions: null, metadata: null, model: "fixture", object: "response", output: [{ type: "message", id: "reply", role: "assistant", status: "completed", content: [{ type: "output_text", text: "done", annotations: [] }] }], parallel_tool_calls: false, temperature: null, tool_choice: "auto", tools: [], top_p: null, status: "completed" };
}
for (const mode of ["success", "failure", "cancel"] as const) test(`steering arriving during ${mode} compaction is applied before inference or cancellation`, async () => {
  // Given the real runtime and durable journal paused inside the provider compact request.
  const root = await mkdtemp(join(tmpdir(), "compact-steering-"));
  const assignment: Assignment = { run_id: crypto.randomUUID(), task: { id: crypto.randomUUID(), conversation_id: crypto.randomUUID(), objective: "fixture", state: "running", reason: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }, messages: [], instructions: "", memory: [] };
  const steering: Message = { id: crypto.randomUUID(), conversation_id: assignment.task.conversation_id, role: "user", content: "new steering", sequence: 1, created_at: new Date().toISOString(), client_message_id: null };
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const events: DaemonEvent[] = [], inputs: ResponseInputItem[][] = [], composing: string[][] = [], cursors: number[] = [], failures: string[] = [];
  let pending = false, assigned = false, compactCalls = 0;
  const journal = new ObservedJournal(join(root, "journal.sqlite"));
  const server = Bun.serve({ port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/v1/daemon/extensions") return Response.json({ skills: [], servers: [] });
    if (url.pathname === "/v1/daemon/poll") { const next = assigned ? null : assignment; assigned = true; return Response.json({ assignment: next, commands: [], messages: [] }); }
    if (url.pathname === "/v1/daemon/events") { events.push(DaemonEvent.parse(await request.json())); return Response.json({ accepted: true }); }
    if (url.pathname === "/v1/daemon/composing") {
      const event = ComposingRequest.parse(await request.json());
      if (event.kind === "begin") composing.push(event.input_message_ids);
      return Response.json({ generation: 1 });
    }
    return Response.json({ messages: pending && Number(url.searchParams.get("after")) < 1 ? [steering] : [] });
  } });
  const provider: Provider = {
    compact: async input => { compactCalls++; entered.resolve(); await release.promise; if (mode === "failure") throw new TypeError("fixture compaction failed"); return [...input, { type: "compaction", id: "compact", encrypted_content: "opaque-fixture" }]; },
    respond: async input => { inputs.push(structuredClone(input)); cursors.push(journal.recoverable(assignment.run_id)?.cursor ?? -1); return finalResponse(); },
  };
  const runtime = new Runtime({ controlUrl: server.url.href, token: "fixture", journal, provider, tools: new ToolExecutor(), artifactRoot: root, compactThreshold: 1, onFailure: event => failures.push(event.code) });
  try {
    await runtime.tick(); await entered.promise;
    // When input arrives before the deferred compaction completes (or after cancellation).
    pending = true;
    const stopping = mode === "cancel" ? runtime.stop() : undefined;
    release.resolve();
    if (stopping) await stopping; else await journal.finished.promise;
    await runtime.flush();
    // Then the first inference/checkpoint/composing lease already includes steering exactly once.
    if (mode === "cancel") {
      expect(inputs).toHaveLength(0);
      expect(journal.recoverable(assignment.run_id)?.input.some(item => item.type === "compaction")).toBe(false);
      expect(events.filter(event => event.kind === "input_applied")).toHaveLength(0);
    } else {
      expect(cursors).toEqual([1]);
      expect(compactCalls).toBe(1);
      expect(composing).toEqual([[steering.id]]);
      expect(inputs[0]?.filter(item => "role" in item && item.role === "user" && item.content === steering.content)).toHaveLength(1);
      expect(inputs[0]?.some(item => item.type === "compaction" && item.encrypted_content === "opaque-fixture")).toBe(mode === "success");
      expect(events.filter(event => event.kind === "input_applied" && event.message_id === steering.id)).toHaveLength(1);
      expect(events.filter(event => event.kind === "state" && event.state === "succeeded")).toHaveLength(1);
      expect(failures).toEqual(mode === "failure" ? ["context_compaction_failed"] : []);
    }
  } finally { release.resolve(); await runtime.stop(); journal.close(); await server.stop(true); await rm(root, { recursive: true, force: true }); }
});
