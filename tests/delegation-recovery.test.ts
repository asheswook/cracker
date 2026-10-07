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

test("restart resumes checkpointed child and reports uncertain sibling without replay", async () => {
  const dir = await mkdtemp(join(tmpdir(), "child-recovery-")),
    path = join(dir, "journal.sqlite"),
    first = new Journal(path);
  const base = {
    parent: "parent",
    task: "recover",
    directory: dir,
    state: "running",
    input: [{ role: "user", content: "recover" }],
    calls: [],
    result: null,
    consumed: false,
    turns: 0,
    mailbox: [],
    appliedMessages: [],
  } as const;
  first.children.create({
    ...base,
    id: "safe",
    input: [...base.input],
    calls: [],
    mailbox: [],
    appliedMessages: [],
  });
  first.children.create({
    ...base,
    id: "uncertain",
    input: [...base.input],
    calls: [],
    mailbox: [],
    appliedMessages: [],
  });
  first.children.begin("uncertain", "effect");
  first.close();
  const journal = new Journal(path),
    tools = new ToolExecutor();
  let calls = 0;
  const provider: Provider = {
    respond: async () => {
      calls++;
      return final("recovered");
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
    const safe = status.parse(
        JSON.parse(
          await delegation.tool("wait_agent", '{"agent_id":"safe","timeout_ms":1000}', "w"),
        ),
      ),
      uncertain = status.parse(
        JSON.parse(await delegation.tool("agent_status", '{"agent_id":"uncertain"}', "s")),
      );
    expect(safe.result).toBe("recovered");
    expect(uncertain.state).toBe("unknown");
    expect(calls).toBe(1);
    expect(delegation.pending()).toBe(false);
  } finally {
    await delegation.close();
    await tools.close();
    journal.close();
    await rm(dir, { recursive: true });
  }
});

test("one child provider failure does not erase a successful sibling and both outcomes can be consumed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "child-failure-")),
    journal = new Journal(":memory:"),
    tools = new ToolExecutor();
  const provider: Provider = {
    respond: async (input) => {
      if (
        input.some(
          (item) =>
            "role" in item && item.role === "user" && "content" in item && item.content === "fail",
        )
      )
        throw new TypeError("fixture failure");
      return final("success");
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
    const children = await Promise.all(
      ["fail", "pass"].map((task) =>
        delegation.tool("spawn_agent", JSON.stringify({ task }), task),
      ),
    );
    const outcomes = await Promise.all(
      children.map((raw) =>
        delegation.tool(
          "wait_agent",
          JSON.stringify({ agent_id: status.parse(JSON.parse(raw)).agent_id, timeout_ms: 1000 }),
          "wait",
        ),
      ),
    );
    expect(outcomes.map((raw) => status.parse(JSON.parse(raw)).state)).toEqual([
      "failed",
      "succeeded",
    ]);
    expect(delegation.pending()).toBe(false);
  } finally {
    await delegation.close();
    await tools.close();
    journal.close();
    await rm(dir, { recursive: true });
  }
});
