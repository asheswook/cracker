import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Journal } from "../services/daemon/journal.ts";
import { ToolExecutor } from "../services/daemon/tools.ts";
import { ToolScheduler } from "../services/daemon/tool-scheduler.ts";
import { Delegation } from "../services/daemon/delegation.ts";
import type { Provider } from "../packages/provider/index.ts";
import { response, final, status } from "./delegation-fixture.ts";

test("two independent child investigations actually overlap at HTTP MCP and return isolated results", async () => {
  const dir = await mkdtemp(join(tmpdir(), "child-overlap-")),
    journal = new Journal(join(dir, "journal.sqlite")),
    tools = new ToolExecutor();
  const mcp = new McpServer({ name: "research", version: "1" }),
    both = Promise.withResolvers<void>();
  let active = 0,
    peak = 0,
    executions = 0;
  mcp.registerTool(
    "lookup",
    { annotations: { readOnlyHint: true }, inputSchema: { topic: z.string() } },
    async ({ topic }) => {
      executions++;
      peak = Math.max(peak, ++active);
      if (active === 2) both.resolve();
      await both.promise;
      active--;
      return { content: [{ type: "text", text: `source:${topic}` }] };
    },
  );
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    enableJsonResponse: true,
  });
  await mcp.connect(transport);
  const server = Bun.serve({ port: 0, fetch: (request) => transport.handleRequest(request) });
  await tools.addMcp("research", { transport: "http", url: server.url.href }, {});
  const provider: Provider = {
    respond: async (input, offered) => {
      const result = input.find((item) => item.type === "function_call_output");
      if (result?.type === "function_call_output") return final(String(result.output));
      const task = input.find((item) => "role" in item && item.role === "user"),
        tool = offered.find((item) => item.type === "function" && item.name.includes("lookup"));
      if (!task || !("content" in task) || !tool || tool.type !== "function")
        throw new TypeError("Invalid child scope");
      return response([
        {
          type: "function_call",
          call_id: "lookup",
          name: tool.name,
          arguments: JSON.stringify({ topic: task.content }),
        },
      ]);
    },
  };
  const delegation = new Delegation(
    { runId: "parent", directory: dir, instructions: [] },
    {
      provider,
      journal: journal.children,
      scheduler: new ToolScheduler(3),
      shared: tools,
      signal: AbortSignal.timeout(5000),
      beforeAction: async () => {},
    },
  );
  try {
    const a = status.parse(
        JSON.parse(await delegation.tool("spawn_agent", '{"task":"alpha"}', "a")),
      ),
      b = status.parse(JSON.parse(await delegation.tool("spawn_agent", '{"task":"beta"}', "b")));
    await both.promise;
    const results = await Promise.all(
      [a, b].map((child) =>
        delegation.tool(
          "wait_agent",
          JSON.stringify({ agent_id: child.agent_id, timeout_ms: 1000 }),
          "wait",
        ),
      ),
    );
    expect(peak).toBe(2);
    expect(executions).toBe(2);
    expect(results[0]).toContain("source:alpha");
    expect(results[1]).toContain("source:beta");
    expect(delegation.pending()).toBe(false);
    await delegation.tool("spawn_agent", '{"task":"alpha"}', "a");
    expect(executions).toBe(2);
    expect(journal.pending()).toEqual([]);
  } finally {
    await delegation.close();
    await tools.close();
    await mcp.close();
    await server.stop(true);
    journal.close();
    await rm(dir, { recursive: true });
  }
});

test("steering arriving during child inference replaces stale final and is consumed exactly once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "child-steer-")),
    journal = new Journal(":memory:"),
    tools = new ToolExecutor(),
    entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let calls = 0;
  const provider: Provider = {
    respond: async (input) => {
      if (calls++ === 0) {
        entered.resolve();
        await release.promise;
        return final("obsolete");
      }
      const count = input.filter(
        (item) =>
          "role" in item &&
          item.role === "user" &&
          "content" in item &&
          item.content === "new direction",
      ).length;
      return final(`updated:${count}`);
    },
  };
  const delegation = new Delegation(
    { runId: "parent", directory: dir, instructions: [] },
    {
      provider,
      journal: journal.children,
      scheduler: new ToolScheduler(),
      shared: tools,
      signal: AbortSignal.timeout(5000),
      beforeAction: async () => {},
    },
  );
  try {
    const child = status.parse(
      JSON.parse(await delegation.tool("spawn_agent", '{"task":"old"}', "a")),
    );
    await entered.promise;
    delegation.steer({ id: "steer", text: "new direction" });
    delegation.steer({ id: "steer", text: "new direction" });
    release.resolve();
    const result = status.parse(
      JSON.parse(
        await delegation.tool(
          "wait_agent",
          JSON.stringify({ agent_id: child.agent_id, timeout_ms: 1000 }),
          "wait",
        ),
      ),
    );
    expect(result.result).toBe("updated:1");
    expect(calls).toBe(2);
    expect(journal.pending()).toEqual([]);
  } finally {
    release.resolve();
    await delegation.close();
    await tools.close();
    journal.close();
    await rm(dir, { recursive: true });
  }
});
