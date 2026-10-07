import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Response, ResponseOutputItem } from "openai/resources/responses/responses";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { controlFixture } from "./control-fixture.ts";
import { Journal } from "../services/daemon/journal.ts";
import { Runtime } from "../services/daemon/runtime.ts";
import { ToolExecutor } from "../services/daemon/tools.ts";
import type { Provider } from "../packages/provider/index.ts";
const f = controlFixture();
const response = (output: ResponseOutputItem[]): Response => ({
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
  parallel_tool_calls: true,
  temperature: null,
  tool_choice: "auto",
  tools: [],
  top_p: null,
  status: "completed",
});
const message = (text: string): ResponseOutputItem => ({
  type: "message",
  id: crypto.randomUUID(),
  role: "assistant",
  status: "completed",
  phase: "final_answer",
  content: [{ type: "output_text", text, annotations: [] }],
});
const call = (name: string, id: string, args: unknown): ResponseOutputItem => ({
  type: "function_call",
  name,
  call_id: id,
  arguments: JSON.stringify(args),
});
class ObservedJournal extends Journal {
  readonly finished = Promise.withResolvers<void>();
  override finish(run: string): void {
    super.finish(run);
    this.finished.resolve();
  }
}

for (const delegated of [false, true])
  test(`actual control task ${delegated ? "delegates children and fences premature final" : "overlaps read calls"} without extra public replies`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "runtime-parallel-")),
      journal = new ObservedJournal(join(dir, "journal.sqlite")),
      tools = new ToolExecutor();
    const mcp = new McpServer({ name: "research", version: "1" }),
      both = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    let active = 0,
      peak = 0,
      executions = 0;
    mcp.registerTool(
      "lookup",
      { annotations: { readOnlyHint: true }, inputSchema: { topic: z.string() } },
      async ({ topic }) => {
        executions++;
        peak = Math.max(peak, ++active);
        if (active === 2) {
          both.resolve();
          if (!delegated) release.resolve();
        }
        await release.promise;
        active--;
        return { content: [{ type: "text", text: `evidence:${topic}` }] };
      },
    );
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: true,
    });
    await mcp.connect(transport);
    const mcpServer = Bun.serve({ port: 0, fetch: (request) => transport.handleRequest(request) });
    await tools.addMcp("research", { transport: "http", url: mcpServer.url.href }, {});
    let leadTurns = 0,
      childTurns = 0;
    const provider: Provider = {
      respond: async (input, offered) => {
        const lookup = offered.find(
          (tool) => tool.type === "function" && tool.name.includes("lookup"),
        );
        if (!lookup || lookup.type !== "function") throw new TypeError("MCP missing");
        const isLead = offered.some(
          (tool) => tool.type === "function" && tool.name === "spawn_agent",
        );
        if (!isLead) {
          childTurns++;
          const result = input.find((item) => item.type === "function_call_output");
          if (result) return response([message("child evidence")]);
          return response([call(lookup.name, "lookup", { topic: "child" })]);
        }
        leadTurns++;
        if (leadTurns === 1)
          return response(
            delegated
              ? [
                  call("spawn_agent", "a", { task: "alpha" }),
                  call("spawn_agent", "b", { task: "beta" }),
                ]
              : [
                  call(lookup.name, "a", { topic: "alpha" }),
                  call(lookup.name, "b", { topic: "beta" }),
                ],
          );
        if (!delegated) return response([message("verified result")]);
        if (leadTurns === 2) return response([message("premature final")]);
        if (leadTurns === 3) {
          await both.promise;
          release.resolve();
          const ids = input.flatMap((item) =>
            item.type === "function_call_output" && (item.call_id === "a" || item.call_id === "b")
              ? [z.object({ agent_id: z.string() }).parse(JSON.parse(String(item.output))).agent_id]
              : [],
          );
          return response(
            ids.map((id, index) =>
              call("wait_agent", `wait${index}`, { agent_id: id, timeout_ms: 1000 }),
            ),
          );
        }
        return response([message("verified result")]);
      },
    };
    const server = Bun.serve({ port: 0, fetch: f.app.fetch }),
      runtime = new Runtime({
        controlUrl: server.url.href,
        token: f.machine,
        journal,
        provider,
        tools,
        artifactRoot: dir,
      });
    try {
      const { task } = await f.newTask();
      await runtime.tick();
      await journal.finished.promise;
      await runtime.flush();
      const rows =
        await f.sql`SELECT content FROM assistant.messages WHERE conversation_id=${task.conversation_id} AND role='assistant' ORDER BY sequence`;
      const states = await f.sql`SELECT state FROM assistant.tasks WHERE id=${task.id}`;
      expect(peak).toBe(2);
      expect(executions).toBe(2);
      expect(rows.map((row) => row["content"])).toEqual(["verified result"]);
      expect(states[0]?.["state"]).toBe("succeeded");
      expect(childTurns).toBe(delegated ? 4 : 0);
      expect(leadTurns).toBe(delegated ? 4 : 2);
    } finally {
      release.resolve();
      await runtime.stop();
      await mcp.close();
      await mcpServer.stop(true);
      await server.stop(true);
      journal.close();
      await rm(dir, { recursive: true });
    }
  }, 10000);

test("actual takeover drains parent and child inference before acknowledging user ownership", async () => {
  const dir = await mkdtemp(join(tmpdir(), "runtime-child-takeover-")),
    journal = new Journal(join(dir, "journal.sqlite")),
    tools = new ToolExecutor(),
    childEntered = Promise.withResolvers<void>(),
    parentEntered = Promise.withResolvers<void>();
  let childStopped = false,
    parentStopped = false,
    leadCalls = 0;
  const provider: Provider = {
    respond: async (_input, offered, signal) => {
      const lead = offered.some((tool) => tool.type === "function" && tool.name === "spawn_agent");
      if (lead && leadCalls++ === 0)
        return response([call("spawn_agent", "child", { task: "independent research" })]);
      (lead ? parentEntered : childEntered).resolve();
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            if (lead) parentStopped = true;
            else childStopped = true;
            reject(new DOMException("aborted", "AbortError"));
          },
          { once: true },
        );
      });
    },
  };
  const server = Bun.serve({ port: 0, fetch: f.app.fetch }),
    runtime = new Runtime({
      controlUrl: server.url.href,
      token: f.machine,
      journal,
      provider,
      tools,
      artifactRoot: dir,
    });
  try {
    await f.newTask();
    await runtime.tick();
    await Promise.all([childEntered.promise, parentEntered.promise]);
    const result = await f.request(`/v1/vms/${f.vm}/control`, f.client, {
      kind: "takeover",
      client_command_id: crypto.randomUUID(),
    });
    expect(result.status).toBe(200);
    await runtime.tick();
    expect(childStopped).toBe(true);
    expect(parentStopped).toBe(true);
    expect(journal.control()).toBe("user");
    const commands =
      await f.sql`SELECT status FROM assistant.commands WHERE vm_id=${f.vm} AND kind='takeover'`;
    expect(commands.map((row) => row["status"])).toEqual(["applied"]);
  } finally {
    await runtime.stop();
    await server.stop(true);
    journal.close();
    await rm(dir, { recursive: true });
  }
}, 10000);
