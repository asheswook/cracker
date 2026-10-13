import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { ResponseInputItem } from "../packages/provider/index.ts";
import type { Provider } from "../packages/provider/index.ts";
import { DaemonEvent, type Assignment } from "../packages/protocol/index.ts";
import { Journal } from "../services/daemon/journal.ts";
import { Runtime } from "../services/daemon/runtime.ts";
import { final, response } from "./delegation-fixture.ts";
import { mcpErrorFixture, parseCallFailure } from "./mcp-call-error-fixture.ts";

class ObservedJournal extends Journal {
  readonly finished = Promise.withResolvers<void>();
  readonly completedActions: string[] = [];
  override finish(run: string): void { super.finish(run); this.finished.resolve(); }
  override complete(id: string, result: string): void { super.complete(id, result); this.completedActions.push(result); }
}

for (const parallel of [false, true]) test(`runtime continues after a thrown MCP error with ${parallel ? "parallel sibling and follow-up" : "subsequent healthy tool"}`, async () => {
  // Given actual MCP wire errors, an HTTP control seam, and a real SQLite journal.
  const directory = await mkdtemp(join(tmpdir(), "runtime-mcp-errors-"));
  const mcp = await mcpErrorFixture({ failure: { kind: "protocol", code: ErrorCode.RequestTimeout }, annotations: { readOnlyHint: true } });
  const journal = new ObservedJournal(join(directory, "journal.sqlite"));
  const events: DaemonEvent[] = [];
  const inputs: ResponseInputItem[][] = [];
  const assignment: Assignment = { run_id: crypto.randomUUID(), task: { id: crypto.randomUUID(), conversation_id: crypto.randomUUID(), objective: "continue after MCP error", state: "running", reason: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }, messages: [], instructions: "", memory: [] };
  let assigned = false;
  const server = Bun.serve({ port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/v1/daemon/poll") { const next = assigned ? null : assignment; assigned = true; return Response.json({ assignment: next, commands: [], messages: [] }); }
    if (path === "/v1/daemon/events") { events.push(DaemonEvent.parse(await request.json())); return Response.json({ accepted: true }); }
    return Response.json({ messages: [], memory: [], instructions: "" });
  } });
  const provider: Provider = { respond: async input => {
    inputs.push(input);
    if (inputs.length === 1) return response([
      { type: "function_call", name: mcp.lookup, call_id: "failed-read", arguments: "{}" },
      ...(parallel ? [{ type: "function_call", name: mcp.healthy, call_id: "sibling-read", arguments: "{}" } as const] : []),
    ]);
    if (inputs.length === 2) return response([{ type: "function_call", name: mcp.healthy, call_id: "follow-up-read", arguments: "{}" }]);
    return final("Recovered and completed");
  } };
  const runtime = new Runtime({ controlUrl: server.url.href, token: "fixture", journal, provider, tools: mcp.tools, artifactRoot: directory });
  try {
    // When the runtime executes an MCP call whose server returns protocol errors.
    await runtime.tick();
    await journal.finished.promise;
    await runtime.flush();
    // Then the same run receives an error result, can use tools again, and succeeds.
    expect(events.filter(event => event.kind === "state").map(event => [event.run_id, event.state])).toEqual([[assignment.run_id, "succeeded"]]);
    expect(inputs).toHaveLength(3);
    const failed = inputs[1]?.find(item => item.type === "function_call_output" && item.call_id === "failed-read");
    if (!failed || failed.type !== "function_call_output") throw new TypeError("Model did not receive failed MCP result");
    expect(parseCallFailure(String(failed.output))).toMatchObject({ code: "timeout", attempts: 2 });
    if (parallel) expect(inputs[1]?.some(item => item.type === "function_call_output" && item.call_id === "sibling-read")).toBe(true);
    expect(inputs[2]?.some(item => item.type === "function_call_output" && item.call_id === "follow-up-read")).toBe(true);
    expect(journal.completedActions).toHaveLength(parallel ? 3 : 2);
    expect(journal.resumeSafe(assignment.run_id)).toBe(true);
    expect(mcp.attempts()).toBe(2);
    expect(mcp.healthyCalls()).toBe(parallel ? 2 : 1);
    expect(events.filter(event => event.kind === "message").map(event => event.content)).toEqual(["Recovered and completed"]);
  } finally {
    await mcp.close();
    await runtime.stop();
    journal.close();
    await server.stop(true);
    await rm(directory, { recursive: true });
  }
});
