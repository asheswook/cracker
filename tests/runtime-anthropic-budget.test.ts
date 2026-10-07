import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture, message, wire, summaryBlock } from "./anthropic-context-fixture.ts";
import { DaemonEvent, type Assignment, type Message } from "../packages/protocol/index.ts";
import { Runtime } from "../services/daemon/runtime.ts";
import { Journal } from "../services/daemon/journal.ts";
import { ToolExecutor } from "../services/daemon/tools.ts";

class BudgetJournal extends Journal {
  readonly done = Promise.withResolvers<void>();
  override finish(run: string): void {
    super.finish(run);
    this.done.resolve();
  }
}
class LargeOutput extends ToolExecutor {
  calls = 0;
  override async run() {
    this.calls++;
    return { text: "x".repeat(300000) };
  }
}
for (const mode of [
  "fresh",
  "count_steering",
  "count_overflow",
  "large_tool",
  "compact_steering",
] as const)
  test(`native wire budget protects ${mode} input before inference`, async () => {
    // Given runtime transport whose token-count endpoint measures the current wire payload.
    const root = await mkdtemp(join(tmpdir(), "native-budget-"));
    const now = new Date().toISOString();
    const assignment: Assignment = {
      run_id: crypto.randomUUID(),
      task: {
        id: crypto.randomUUID(),
        conversation_id: crypto.randomUUID(),
        objective: "fixture",
        state: "running",
        reason: null,
        created_at: now,
        updated_at: now,
      },
      messages: [],
      instructions: "",
      memory: [],
    };
    const steering: Message = {
      id: crypto.randomUUID(),
      conversation_id: assignment.task.conversation_id,
      role: "user",
      content: "budget steering",
      sequence: 1,
      created_at: now,
      client_message_id: null,
    };
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const events: DaemonEvent[] = [],
      failures: string[] = [];
    let assigned = false,
      queued = false,
      inferences = 0,
      summaries = 0;
    const control = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/v1/daemon/extensions")
          return Response.json({ skills: [], servers: [] });
        if (url.pathname === "/v1/daemon/poll") {
          const next = assigned ? null : assignment;
          assigned = true;
          return Response.json({ assignment: next, commands: [], messages: [] });
        }
        if (url.pathname === "/v1/daemon/events") {
          events.push(DaemonEvent.parse(await request.json()));
          return Response.json({ accepted: true });
        }
        if (url.pathname === "/v1/daemon/composing") return Response.json({ generation: 1 });
        return Response.json({
          messages: queued && Number(url.searchParams.get("after")) < 1 ? [steering] : [],
        });
      },
    });
    const f = fixture({
      count: async (body, index) => {
        if ((mode === "count_steering" || mode === "count_overflow") && index === 1) {
          entered.resolve();
          await release.promise;
        }
        if (mode === "fresh" || (mode === "large_tool" && index > 1)) return 250000;
        if (
          (mode === "count_overflow" || mode === "compact_steering") &&
          JSON.stringify(body.messages).includes(steering.content)
        )
          return 250000;
        return 100;
      },
      respond: async (body) => {
        if (body.compaction) {
          summaries++;
          if (mode === "compact_steering") {
            entered.resolve();
            await release.promise;
          }
          return new Response(wire(message([summaryBlock], "compaction")), {
            headers: { "content-type": "text/event-stream" },
          });
        }
        inferences++;
        const tool = mode === "large_tool" || mode === "compact_steering";
        return new Response(
          wire(
            message(
              tool
                ? [
                    {
                      type: "tool_use",
                      id: "capture",
                      name: "computer_exec",
                      input: { code: "await desktop.screenshot()", timeout_ms: 1000 },
                      caller: { type: "direct" },
                    },
                  ]
                : [{ type: "text", text: "done" }],
              tool ? "tool_use" : "end_turn",
            ),
          ),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const journal = new BudgetJournal(join(root, "journal.sqlite")),
      tools = new LargeOutput();
    const runtime = new Runtime({
      controlUrl: control.url.href,
      token: "fixture",
      provider: f.provider,
      journal,
      tools,
      artifactRoot: root,
      onFailure: (event) => failures.push(event.code),
    });
    try {
      await runtime.tick();
      // When input exceeds the budget, including input arriving during an awaited remote operation.
      if (mode === "count_steering" || mode === "count_overflow" || mode === "compact_steering") {
        await entered.promise;
        queued = true;
        release.resolve();
      }
      await journal.done.promise;
      await runtime.flush();
      // Then no unmeasured or over-budget inference is sent, and the original action is not repeated.
      expect(inferences).toBe(mode === "fresh" || mode === "count_overflow" ? 0 : 1);
      expect(failures).toEqual(
        mode === "count_steering" ? [] : ["native_context_input_budget_exceeded"],
      );
      expect(tools.calls).toBe(mode === "large_tool" || mode === "compact_steering" ? 1 : 0);
      expect(summaries).toBe(mode === "large_tool" || mode === "compact_steering" ? 1 : 0);
      if (mode === "count_steering") {
        expect(f.counts).toHaveLength(2);
        expect(f.requests[0]?.messages).toEqual(f.counts[1]?.messages);
        expect(JSON.stringify(f.requests[0]?.messages)).toContain(steering.content);
      }
      if (mode === "count_steering" || mode === "count_overflow" || mode === "compact_steering") {
        expect(journal.recoverable(assignment.run_id)?.cursor).toBe(1);
        expect(
          events.filter(
            (event) => event.kind === "input_applied" && event.message_id === steering.id,
          ),
        ).toHaveLength(1);
      }
      await Bun.write(
        `.omo/evidence/claude-native-context/budget-${mode}.json`,
        JSON.stringify(
          {
            mode,
            inferences,
            summaries,
            failures,
            countRequests: f.counts,
            requests: f.requests,
            events,
            checkpoint: journal.recoverable(assignment.run_id),
          },
          null,
          2,
        ),
      );
    } finally {
      release.resolve();
      await runtime.stop();
      journal.close();
      f.provider.close();
      await f.close();
      await control.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  }, 15000);
