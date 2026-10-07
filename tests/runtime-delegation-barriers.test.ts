import { test, expect, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DaemonEvent, type Assignment } from "../packages/protocol/index.ts";
import type { Provider } from "../packages/provider/index.ts";
import { Runtime } from "../services/daemon/runtime.ts";
import { Journal } from "../services/daemon/journal.ts";
import { ToolExecutor } from "../services/daemon/tools.ts";
import { response, final } from "./delegation-fixture.ts";
class FinishedJournal extends Journal {
  readonly finished = Promise.withResolvers<void>();
  override finish(run: string) {
    super.finish(run);
    this.finished.resolve();
  }
}
for (const failed of [false, true])
  test(`full runtime withholds final until child cleanup settles; failure=${failed}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "child-publication-")),
      journal = new FinishedJournal(":memory:"),
      shared = new ToolExecutor();
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>(),
      boundary = Promise.withResolvers<void>();
    const original = ToolExecutor.prototype.close;
    const closing = spyOn(ToolExecutor.prototype, "close").mockImplementation(async function (
      this: ToolExecutor,
    ) {
      if (this === shared) return original.call(this);
      entered.resolve();
      await release.promise;
      if (failed) throw new TypeError("cleanup failed");
      return original.call(this);
    });
    const assignment: Assignment = {
      run_id: crypto.randomUUID(),
      task: {
        id: crypto.randomUUID(),
        conversation_id: crypto.randomUUID(),
        objective: "fixture",
        state: "running",
        reason: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      messages: [],
      instructions: "",
      memory: [],
    };
    const events: DaemonEvent[] = [];
    let assigned = false,
      turn = 0;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/v1/daemon/extensions") return Response.json({ skills: [], servers: [] });
        if (path === "/v1/daemon/poll") {
          const value = assigned ? null : assignment;
          assigned = true;
          return Response.json({ assignment: value, commands: [], messages: [] });
        }
        if (path === "/v1/daemon/events") {
          const event = DaemonEvent.parse(await request.json());
          events.push(event);
          if (event.kind === "message" && event.content === "UNSAFE_FINAL") boundary.resolve();
          return Response.json({ accepted: true });
        }
        return Response.json({ messages: [] });
      },
    });
    const provider: Provider = {
      respond: async (_input, tools) => {
        if (!tools.some((tool) => tool.type === "function" && tool.name === "spawn_agent"))
          return final("child result");
        turn++;
        const id = `${assignment.run_id}:spawn`;
        if (turn === 1)
          return response([
            {
              type: "function_call",
              call_id: "spawn",
              name: "spawn_agent",
              arguments: '{"task":"work"}',
            },
          ]);
        if (turn === 2) {
          await entered.promise;
          return response([
            {
              type: "function_call",
              call_id: "status-before",
              name: "agent_status",
              arguments: JSON.stringify({ agent_id: id }),
            },
          ]);
        }
        if (turn === 3) return final("UNSAFE_FINAL");
        if (turn === 4) {
          boundary.resolve();
          await release.promise;
          return response([
            {
              type: "function_call",
              call_id: "status-after",
              name: "agent_status",
              arguments: JSON.stringify({ agent_id: id }),
            },
          ]);
        }
        return final("FINAL_OK");
      },
    };
    const runtime = new Runtime({
      controlUrl: server.url.href,
      token: "fixture",
      provider,
      journal,
      tools: shared,
      artifactRoot: directory,
      onFailure: () => {},
    });
    try {
      await runtime.tick();
      await boundary.promise;
      expect(events.filter((event) => event.kind === "message")).toEqual([]);
      expect(events.some((event) => event.kind === "state" && event.state === "succeeded")).toBe(
        false,
      );
      release.resolve();
      await journal.finished.promise;
      await runtime.flush();
      expect(events.flatMap((event) => (event.kind === "message" ? [event.content] : []))).toEqual(
        failed ? [] : ["FINAL_OK"],
      );
      expect(events.some((event) => event.kind === "state" && event.state === "succeeded")).toBe(
        !failed,
      );
      if (failed)
        expect(events.some((event) => event.kind === "state" && event.state === "unknown")).toBe(
          true,
        );
    } finally {
      release.resolve();
      try {
        await runtime.stop();
      } finally {
        closing.mockRestore();
        journal.close();
        await server.stop(true);
        await rm(directory, { recursive: true });
      }
    }
  }, 5000);
