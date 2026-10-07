import { test, expect, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Journal } from "../services/daemon/journal.ts";
import { ToolExecutor } from "../services/daemon/tools.ts";
import { ToolScheduler } from "../services/daemon/tool-scheduler.ts";
import { Delegation } from "../services/daemon/delegation.ts";
import { final, status } from "./delegation-fixture.ts";
test("acknowledged startup follow-up and user steering reach the first child inference", async () => {
  const directory = await mkdtemp(join(tmpdir(), "child-startup-")),
    journal = new Journal(":memory:"),
    shared = new ToolExecutor();
  const d = new Delegation(
    { runId: "parent", directory, instructions: [] },
    {
      provider: {
        respond: async (input) =>
          final(JSON.stringify(input.filter((item) => "role" in item && item.role === "user"))),
      },
      journal: journal.children,
      scheduler: new ToolScheduler(),
      shared,
      signal: AbortSignal.timeout(2000),
      beforeAction: async () => {},
    },
  );
  try {
    const child = status.parse(
      JSON.parse(await d.tool("spawn_agent", '{"task":"original"}', "spawn")),
    );
    await d.tool(
      "message_agent",
      JSON.stringify({ agent_id: child.agent_id, message: "new scope" }),
      "follow-up",
    );
    d.steer({ id: "user-steering", text: "new constraint" });
    const result = status.parse(
      JSON.parse(
        await d.tool(
          "wait_agent",
          JSON.stringify({ agent_id: child.agent_id, timeout_ms: 1000 }),
          "wait",
        ),
      ),
    );
    expect(result.result).toContain("new scope");
    expect(result.result).toContain("new constraint");
    expect(journal.children.get(child.agent_id)?.mailbox.map((message) => message.id)).toEqual([
      "follow-up",
      "user-steering",
    ]);
    expect(journal.children.get(child.agent_id)?.appliedMessages).toEqual([
      "follow-up",
      "user-steering",
    ]);
  } finally {
    await d.close();
    await shared.close();
    journal.close();
    await rm(directory, { recursive: true });
  }
});

test("stale state and checkpoint writers preserve acknowledged mailbox entries", () => {
  const journal = new Journal(":memory:");
  try {
    const child = journal.children.create({
      id: "child",
      parent: "parent",
      task: "scope",
      directory: "/tmp/unused",
      state: "queued",
      input: [],
      calls: [],
      result: null,
      consumed: false,
      turns: 0,
      mailbox: [],
      appliedMessages: [],
    });
    journal.children.message(child.id, { id: "fresh", text: "new scope" });
    for (const state of ["running", "finishing", "succeeded", "failed", "unknown"] as const) {
      journal.children.save({ ...child, state });
      expect(journal.children.get(child.id)?.mailbox).toEqual([{ id: "fresh", text: "new scope" }]);
    }
    journal.children.checkpoint(child);
    expect(journal.children.get(child.id)?.mailbox).toEqual([{ id: "fresh", text: "new scope" }]);
  } finally {
    journal.close();
  }
});

test("restart treats interrupted cleanup as unknown instead of publishing the candidate success", () => {
  const journal = new Journal(":memory:");
  try {
    journal.children.create({
      id: "child",
      parent: "parent",
      task: "scope",
      directory: "/tmp/unused",
      state: "finishing",
      input: [],
      calls: [],
      result: "candidate success",
      consumed: false,
      turns: 0,
      mailbox: [],
      appliedMessages: [],
    });
    journal.children.recover("parent");
    expect(journal.children.get("child")?.state).toBe("unknown");
    expect(journal.children.get("child")?.result).not.toBe("candidate success");
  } finally {
    journal.close();
  }
});

test("follow-up accepted during cleanup runs after cleanup without exposing the obsolete result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "child-finishing-message-")),
    journal = new Journal(":memory:"),
    shared = new ToolExecutor(),
    entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const original = ToolExecutor.prototype.close;
  let closes = 0;
  const closing = spyOn(ToolExecutor.prototype, "close").mockImplementation(async function (
    this: ToolExecutor,
  ) {
    if (this !== shared && closes++ === 0) {
      entered.resolve();
      await release.promise;
    }
    return original.call(this);
  });
  const d = new Delegation(
    { runId: "parent", directory, instructions: [] },
    {
      provider: {
        respond: async (input) =>
          final(JSON.stringify(input.filter((item) => "role" in item && item.role === "user"))),
      },
      journal: journal.children,
      scheduler: new ToolScheduler(),
      shared,
      signal: AbortSignal.timeout(2000),
      beforeAction: async () => {},
    },
  );
  try {
    const child = status.parse(
      JSON.parse(await d.tool("spawn_agent", '{"task":"original"}', "spawn")),
    );
    await entered.promise;
    await d.tool(
      "message_agent",
      JSON.stringify({ agent_id: child.agent_id, message: "updated during cleanup" }),
      "follow-up",
    );
    const pending = status.parse(
      JSON.parse(
        await d.tool("agent_status", JSON.stringify({ agent_id: child.agent_id }), "status"),
      ),
    );
    expect(pending.result).toBeNull();
    expect(d.pending()).toBe(true);
    release.resolve();
    await d.tool(
      "wait_agent",
      JSON.stringify({ agent_id: child.agent_id, timeout_ms: 1000 }),
      "first-wait",
    );
    const result = status.parse(
      JSON.parse(
        await d.tool(
          "wait_agent",
          JSON.stringify({ agent_id: child.agent_id, timeout_ms: 1000 }),
          "second-wait",
        ),
      ),
    );
    expect(result.state).toBe("succeeded");
    expect(result.result).toContain("updated during cleanup");
    expect(d.pending()).toBe(false);
  } finally {
    release.resolve();
    try {
      await d.close();
    } finally {
      closing.mockRestore();
      await shared.close();
      journal.close();
      await rm(directory, { recursive: true });
    }
  }
});
