import { test, expect } from "bun:test";
import { watch } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime } from "../services/daemon/runtime.ts";
import { Journal } from "../services/daemon/journal.ts";
import { ToolExecutor } from "../services/daemon/tools.ts";
import { DaemonEvent, type Assignment, type Command } from "../packages/protocol/index.ts";
import type { Provider } from "../packages/provider/index.ts";

test("takeover after a yielded shell session refuses checkpoint recovery while background effects remain", async () => {
  // Given a real shell effect followed by a still-running process group.
  const dir = await mkdtemp(join(tmpdir(), "takeover-effect-")), ready = join(dir, "ready.txt");
  const effect = Promise.withResolvers<void>();
  const watcher = watch(dir, (_event, file) => { if (file === "ready.txt") effect.resolve(); });
  const events: Array<ReturnType<typeof DaemonEvent.parse>> = [];
  let assigned = false; let command: Command | undefined;
  const assignment: Assignment = { run_id: crypto.randomUUID(), task: { id: crypto.randomUUID(), conversation_id: crypto.randomUUID(), objective: "fixture", state: "running", reason: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }, messages: [], instructions: "", memory: [] };
  const waiting=Promise.withResolvers<void>();let calls=0;
  const provider: Provider = { respond: async (_input,_tools,signal) => {if(calls++>0){waiting.resolve();return new Promise((_resolve,reject)=>signal.addEventListener("abort",()=>reject(new DOMException("aborted","AbortError")),{once:true}));}return ({ id: "fixture", created_at: 0, output_text: "", error: null, incomplete_details: null, instructions: null, metadata: null, model: "fixture", object: "response", output: [{ type: "function_call", id: "tool", call_id: "call", name: "shell_start", arguments: JSON.stringify({ cwd:null,yield_ms:0,max_output_chars:1000,command: `printf effect > '${ready}'; sleep 30` }) }], parallel_tool_calls: false, temperature: null, tool_choice: "auto", tools: [], top_p: null, status: "completed" });} };
  const server = Bun.serve({ port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/v1/daemon/poll") { const next = assigned ? null : assignment; assigned = true; return Response.json({ assignment: next, commands: command ? [command] : [], messages: [] }); }
    if (path === "/v1/daemon/events") { events.push(DaemonEvent.parse(await request.json())); return Response.json({ accepted: true }); }
    return Response.json({ messages: [], memory: [], instructions: "" });
  } });
  const journal = new Journal(":memory:"), runtime = new Runtime({ controlUrl: server.url.href, token: "fixture", journal, provider, tools: new ToolExecutor() });
  try {
    await runtime.tick(); await effect.promise;await waiting.promise;
    command = { id: crypto.randomUUID(), task_id: null, kind: "takeover", created_at: new Date().toISOString() };
    // When
    await runtime.tick();
    // Then the drain ACK does not imply safe replay of the interrupted effect.
    expect(events.filter(e => e.kind === "command_ack").map(e => e.resume_safe)).toEqual([false]);
    expect(journal.resumeSafe(assignment.run_id)).toBe(false);
  } finally { watcher.close(); await runtime.stop(); journal.close(); await server.stop(true); await rm(dir, { recursive: true }); }
});
