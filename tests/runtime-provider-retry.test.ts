import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture, message, wire } from "./anthropic-context-fixture.ts";
import { DaemonEvent, type Assignment } from "../packages/protocol/index.ts";
import { Runtime } from "../services/daemon/runtime.ts";
import { Journal } from "../services/daemon/journal.ts";
import { ToolExecutor } from "../services/daemon/tools.ts";

class RetryJournal extends Journal {
  readonly done = Promise.withResolvers<void>();
  override finish(run: string): void { super.finish(run); this.done.resolve(); }
}
class CountedTools extends ToolExecutor {
  calls = 0;
  override async run() { this.calls++; return { text: "fixture tool completed once" }; }
}

test("same runtime run retries a model failure after a completed tool without replaying that tool", async () => {
  // Given real loopback provider/control HTTP, SQLite journal, and one counted effect boundary.
  const root = await mkdtemp(join(tmpdir(), "provider-retry-runtime-"));
  const now = new Date().toISOString();
  const assignment: Assignment = {
    run_id: crypto.randomUUID(), task: { id: crypto.randomUUID(), conversation_id: crypto.randomUUID(), objective: "fixture", state: "running", reason: null, created_at: now, updated_at: now },
    messages: [], instructions: "", memory: [],
  };
  assignment.messages.push({ id: crypto.randomUUID(), conversation_id: assignment.task.conversation_id, role: "user", content: "fixture input", sequence: 1, created_at: now, client_message_id: null });
  let assigned = false;
  const events: DaemonEvent[] = [], failures: string[] = [];
  const control = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/v1/daemon/extensions") return Response.json({ skills: [], servers: [] });
    if (path === "/v1/daemon/poll") { const next = assigned ? null : assignment; assigned = true; return Response.json({ assignment: next, commands: [], messages: [] }); }
    if (path === "/v1/daemon/events") { events.push(DaemonEvent.parse(await request.json())); return Response.json({ accepted: true }); }
    if (path === "/v1/daemon/composing") return Response.json({ generation: 1 });
    return Response.json({ messages: [] });
  } });
  const provider = fixture({ count: () => 100, respond: (_body, index) => {
    if (index === 2) return Response.json({ type: "error", error: { type: "overloaded_error", message: "synthetic" } }, { status: 503 });
    const blocks = index === 1 ? [{ type: "thinking", thinking: "fixture", signature: "signed-fixture-ancestry" }, { type: "tool_use", id: "tool_once", name: "shell", input: { command: "fixture" }, caller: { type: "direct" } }] : [{ type: "text", text: "finished" }];
    return new Response(wire(message(blocks, index === 1 ? "tool_use" : "end_turn", `msg_${index}`)), { headers: { "content-type": "text/event-stream" } });
  } });
  const journal = new RetryJournal(join(root, "journal.sqlite")), tools = new CountedTools();
  const runtime = new Runtime({ controlUrl: control.url.href, token: "fixture", journal, provider: provider.provider, tools, artifactRoot: root, compactThreshold: 190000, onFailure: event => failures.push(event.code) });
  try {
    // When
    await runtime.tick(); await journal.done.promise; await runtime.flush();
    // Then
    expect(failures).toEqual([]); expect(tools.calls).toBe(1); expect(provider.requests).toHaveLength(3);
    expect(provider.requests[1]).toEqual(provider.requests[2]);
    expect(events.flatMap(event => event.kind === "state" && event.state === "succeeded" ? [event.run_id] : [])).toEqual([assignment.run_id]);
    expect(events.filter(event => event.kind === "message").map(event => event.content)).toEqual(["finished"]);
  } finally { await runtime.stop(); provider.provider.close(); provider.close(); control.stop(true); journal.close(); await rm(root, { recursive: true, force: true }); }
});
