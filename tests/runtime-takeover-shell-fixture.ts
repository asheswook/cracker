import { expect } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Response as ProviderResponse } from "openai/resources/responses/responses";
import { Runtime } from "../services/daemon/runtime.ts";
import { Journal } from "../services/daemon/journal.ts";
import { ToolExecutor } from "../services/daemon/tools.ts";
import { DaemonEvent, type Assignment, type Command } from "../packages/protocol/index.ts";
import type { Provider } from "../packages/provider/index.ts";

export async function shellTakeoverScenario(background: boolean): Promise<void> {
  // Given a real process held at an HTTP barrier after its first filesystem effect.
  const directory = await mkdtemp(join(tmpdir(), "scoped-takeover-shell-"));
  const effectFile = join(directory, "effects.txt");
  const shellEntered = Promise.withResolvers<void>();
  const releaseShell = Promise.withResolvers<void>();
  const shellCompleted = Promise.withResolvers<void>();
  const providerEntered = Promise.withResolvers<void>();
  const releaseProvider = Promise.withResolvers<void>();
  const runCompleted = Promise.withResolvers<void>();
  const events: Array<ReturnType<typeof DaemonEvent.parse>> = [];
  let assigned = false;
  let command: Command | undefined;
  let providerAborted = false;
  let calls = 0;
  let shellResult: unknown;
  const assignment: Assignment = { run_id: crypto.randomUUID(), task: { id: crypto.randomUUID(), conversation_id: crypto.randomUUID(), objective: "fixture", state: "running", reason: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }, messages: [], instructions: "", memory: [] };
  const server = Bun.serve({ port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/shell-gate") { shellEntered.resolve(); await releaseShell.promise; return new Response("released"); }
    if (path === "/shell-done") { shellCompleted.resolve(); return new Response("done"); }
    if (path === "/v1/daemon/poll") {
      const next = assigned ? null : assignment;
      assigned = true;
      return Response.json({ assignment: next, commands: command ? [command] : [], messages: [] });
    }
    if (path === "/v1/daemon/events") {
      const event = DaemonEvent.parse(await request.json());
      events.push(event);
      if (event.kind === "state" && event.state === "succeeded") runCompleted.resolve();
      return Response.json({ accepted: true });
    }
    return Response.json({ messages: [], memory: [], instructions: "" });
  } });
  const provider: Provider = { respond: async (input, _tools, signal): Promise<ProviderResponse> => {
    calls++;
    if (calls === 1) {
      const shellCommand = `printf started > '${effectFile}'; curl -fsS '${server.url}shell-gate' >/dev/null && printf completed >> '${effectFile}' && curl -fsS '${server.url}shell-done' >/dev/null`;
      const args = background ? { command: shellCommand, cwd: null, yield_ms: 0, max_output_chars: 1000 } : { command: shellCommand };
      return { id: "fixture", created_at: 0, output_text: "", error: null, incomplete_details: null, instructions: null, metadata: null, model: "fixture", object: "response", output: [{ type: "function_call", id: "tool", call_id: "shell-call", name: background ? "shell_start" : "shell", arguments: JSON.stringify(args) }], parallel_tool_calls: false, temperature: null, tool_choice: "auto", tools: [], top_p: null, status: "completed" };
    }
    providerEntered.resolve();
    await Promise.race([releaseProvider.promise, new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => { providerAborted = true; reject(new DOMException("aborted", "AbortError")); }, { once: true }))]);
    const result = input.findLast(item => item.type === "function_call_output");
    if (!result || result.type !== "function_call_output") throw new TypeError("Missing shell output");
    shellResult = JSON.parse(String(result.output));
    if (background && calls === 2) {
      const { session_id } = z.object({ session_id: z.string() }).parse(shellResult);
      return { id: "fixture", created_at: 0, output_text: "", error: null, incomplete_details: null, instructions: null, metadata: null, model: "fixture", object: "response", output: [{ type: "function_call", id: "poll", call_id: "shell-poll", name: "shell_session", arguments: JSON.stringify({ session_id, action: "poll", input: null, yield_ms: 1000, max_output_chars: 1000 }) }], parallel_tool_calls: false, temperature: null, tool_choice: "auto", tools: [], top_p: null, status: "completed" };
    }
    return { id: "fixture", created_at: 0, output_text: "Shell completed", error: null, incomplete_details: null, instructions: null, metadata: null, model: "fixture", object: "response", output: [{ type: "message", id: "final", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Shell completed", annotations: [] }] }], parallel_tool_calls: false, temperature: null, tool_choice: "auto", tools: [], top_p: null, status: "completed" };
  } };
  const journal = new Journal(":memory:");
  const runtime = new Runtime({ controlUrl: server.url.href, token: "fixture", journal, provider, tools: new ToolExecutor(), artifactRoot: directory });
  try {
    await runtime.tick();
    await shellEntered.promise;
    if (background) await providerEntered.promise;
    command = { id: crypto.randomUUID(), task_id: null, kind: "takeover", created_at: new Date().toISOString() };
    // When the user takes desktop ownership while the process is still running.
    await runtime.tick();
    // Then the existing process and inference finish without a replacement assignment.
    expect(journal.control()).toBe("user");
    expect(providerAborted).toBe(false);
    expect(events.filter(event => event.kind === "command_ack")).toMatchObject([{ status: "applied", execution_continues: true }]);
    releaseShell.resolve();
    await shellCompleted.promise;
    await providerEntered.promise;
    releaseProvider.resolve();
    await runCompleted.promise;
    expect(await readFile(effectFile, "utf8")).toBe("startedcompleted");
    expect(calls).toBe(background ? 3 : 2);
    expect(shellResult).toMatchObject(background ? { status: "exited", exit_code: 0, signal: null } : { exit_code: 0 });
    expect(events.filter(event => event.kind === "state").map(event => [event.run_id, event.state])).toEqual([[assignment.run_id, "succeeded"]]);
  } finally {
    releaseShell.resolve();
    releaseProvider.resolve();
    await runtime.stop();
    journal.close();
    await server.stop(true);
    await rm(directory, { recursive: true });
  }
}
