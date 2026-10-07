import { test, expect, spyOn } from "bun:test";
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

test("child cleanup failure remains visible to the parent shutdown barrier", async () => {
  const dir = await mkdtemp(join(tmpdir(), "child-cleanup-"));
  const journal = new Journal(":memory:");
  const tools = new ToolExecutor();
  const cleanup = spyOn(ToolExecutor.prototype, "close").mockImplementationOnce(async () => {
    throw new TypeError("fixture cleanup failure");
  });
  const delegation = new Delegation(
    { runId: "parent", directory: dir, instructions: [] },
    {
      provider: { respond: async () => final("done") },
      journal: journal.children,
      scheduler: new ToolScheduler(),
      shared: tools,
      signal: AbortSignal.timeout(5000),
      beforeAction: async () => {},
    },
  );
  try {
    const child = status.parse(
      JSON.parse(await delegation.tool("spawn_agent", '{"task":"first"}', "a")),
    );
    await expect(
      delegation.tool(
        "wait_agent",
        JSON.stringify({ agent_id: child.agent_id, timeout_ms: 1000 }),
        "wait",
      ),
    ).rejects.toThrow("fixture cleanup failure");
    await expect(delegation.close()).rejects.toThrow("Child execution cleanup failed");
    expect(journal.children.get(child.agent_id)?.state).toBe("unknown");
  } finally {
    cleanup.mockRestore();
    await tools.close();
    journal.close();
    await rm(dir, { recursive: true });
  }
});

test("replaying an already applied child message preserves its completed result without another inference", async () => {
  const dir = await mkdtemp(join(tmpdir(), "child-message-replay-")),
    journal = new Journal(":memory:"),
    tools = new ToolExecutor();
  let calls = 0;
  const provider: Provider = { respond: async () => final(`result:${++calls}`) };
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
        JSON.parse(await delegation.tool("spawn_agent", '{"task":"first"}', "a")),
      ),
      wait = JSON.stringify({ agent_id: child.agent_id, timeout_ms: 1000 }),
      message = JSON.stringify({ agent_id: child.agent_id, message: "follow-up" });
    await delegation.tool("wait_agent", wait, "w1");
    await delegation.tool("message_agent", message, "followup");
    const before = await delegation.tool("wait_agent", wait, "w2");
    expect(journal.children.get(child.agent_id)?.appliedMessages).toEqual(["followup"]);
    await delegation.tool("message_agent", message, "followup");
    const after = await delegation.tool(
      "agent_status",
      JSON.stringify({ agent_id: child.agent_id }),
      "s",
    );
    expect(after).toBe(before);
    expect(calls).toBe(2);
    expect(delegation.pending()).toBe(false);
  } finally {
    await delegation.close();
    await tools.close();
    journal.close();
    await rm(dir, { recursive: true });
  }
});

test("cancellation drains a live MCP child and restart never replays its uncertain effect", async () => {
  const dir = await mkdtemp(join(tmpdir(), "child-abort-")),
    path = join(dir, "journal.sqlite"),
    journal = new Journal(path),
    tools = new ToolExecutor(),
    abort = new AbortController();
  const mcp = new McpServer({ name: "effect", version: "1" }),
    entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let effects = 0;
  mcp.registerTool("effect", { inputSchema: {} }, async () => {
    effects++;
    entered.resolve();
    await release.promise;
    return { content: [{ type: "text", text: "done" }] };
  });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    enableJsonResponse: true,
  });
  await mcp.connect(transport);
  const server = Bun.serve({ port: 0, fetch: (request) => transport.handleRequest(request) });
  await tools.addMcp("effect", { transport: "http", url: server.url.href }, {});
  const provider: Provider = {
    respond: async (_input, offered) => {
      const tool = offered.find(
        (item) => item.type === "function" && item.name.includes("_effect_"),
      );
      if (!tool || tool.type !== "function") throw new TypeError("Missing effect");
      return response([
        { type: "function_call", call_id: "effect", name: tool.name, arguments: "{}" },
      ]);
    },
  };
  const delegation = new Delegation(
    { runId: "parent", directory: dir, instructions: [] },
    {
      provider,
      journal: journal.children,
      scheduler: new ToolScheduler(),
      shared: tools,
      signal: abort.signal,
      beforeAction: async () => {},
    },
  );
  try {
    const child = status.parse(
      JSON.parse(await delegation.tool("spawn_agent", '{"task":"effect"}', "a")),
    );
    await entered.promise;
    abort.abort();
    await delegation.close();
    release.resolve();
    expect(journal.children.get(child.agent_id)?.state).toBe("unknown");
    journal.children.recover("parent");
    expect(journal.children.get(child.agent_id)?.state).toBe("unknown");
    expect(effects).toBe(1);
  } finally {
    release.resolve();
    await delegation.close();
    await tools.close();
    await mcp.close();
    await server.stop(true);
    journal.close();
    await rm(dir, { recursive: true });
  }
});
