import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fixture, message, wire, summaryBlock } from "./anthropic-context-fixture.ts";
import { Runtime } from "../services/daemon/runtime.ts";
import { Journal } from "../services/daemon/journal.ts";
import { ToolExecutor } from "../services/daemon/tools.ts";
import { DaemonEvent, type Assignment } from "../packages/protocol/index.ts";
import { nativeHash } from "../packages/provider/anthropic-context-frames.ts";
import { CLAUDE_REQUEST_BYTES } from "../packages/provider/anthropic-context-wire.ts";

class DoneJournal extends Journal {
  readonly done = Promise.withResolvers<void>();
  override finish(run: string) {
    super.finish(run);
    this.done.resolve();
  }
}
class LargeCaptures extends ToolExecutor {
  calls = 0;
  constructor(private readonly mode: "history" | "current") {
    super();
  }
  override async run() {
    this.calls++;
    return this.mode === "current"
      ? { text: "x".repeat(32_000_000) }
      : {
          text: "captured",
          images: [
            `data:image/png;base64,${Buffer.alloc(8_000_000, this.calls).toString("base64")}`,
          ],
        };
  }
}
for (const mode of ["history", "current"] as const)
  test(`oversized ${mode} body is compacted or refused before count without losing content`, async () => {
    // Given three individually admissible captures would exceed the wire limit together.
    const root = await mkdtemp(join(tmpdir(), "native-wire-")),
      now = new Date().toISOString();
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
    const events: DaemonEvent[] = [],
      failures: string[] = [];
    let assigned = false,
      round = 0;
    const control = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/v1/daemon/extensions") return Response.json({ skills: [], servers: [] });
        if (path === "/v1/daemon/poll") {
          const next = assigned ? null : assignment;
          assigned = true;
          return Response.json({ assignment: next, commands: [], messages: [] });
        }
        if (path === "/v1/daemon/events") {
          events.push(DaemonEvent.parse(await request.json()));
          return Response.json({ accepted: true });
        }
        if (path === "/v1/daemon/composing") return Response.json({ generation: 1 });
        return Response.json({ messages: [] });
      },
    });
    const f = fixture({
      count: () => 100,
      respond: (body) => {
        const result = body.compaction
          ? message([summaryBlock], "compaction")
          : ++round <= 3
            ? message(
                [
                  { type: "thinking", thinking: "", signature: `thinking-${round}` },
                  {
                    type: "tool_use",
                    id: `capture-${round}`,
                    name: "computer_exec",
                    input: { code: "await desktop.screenshot()", timeout_ms: 1000 },
                    caller: { type: "direct" },
                  },
                ],
                "tool_use",
              )
            : message([{ type: "text", text: "done" }]);
        return new Response(
          wire({ ...result, usage: { ...result.usage, input_tokens: 100, output_tokens: 5 } }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const journal = new DoneJournal(join(root, "journal.sqlite")),
      tools = new LargeCaptures(mode);
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
      // When runtime reaches the fourth inference with three large captures.
      await runtime.tick();
      await journal.done.promise;
      await runtime.flush();
      // Then only a valid earlier prefix is summarized; every HTTP body is admissible and originals survive.
      expect(failures).toEqual(mode === "history" ? [] : ["native_context_request_body_too_large"]);
      expect(tools.calls).toBe(mode === "history" ? 3 : 1);
      expect(round).toBe(mode === "history" ? 4 : 1);
      expect(f.requests.filter((body) => body.compaction)).toHaveLength(1);
      expect(f.requests.find((body) => body.compaction)?.messages).toEqual(
        f.requests[mode === "history" ? 1 : 0]?.messages,
      );
      expect(f.bodyBytes.every((body) => body.bytes <= CLAUDE_REQUEST_BYTES)).toBe(true);
      expect(f.counts).toHaveLength(mode === "history" ? 4 : 1);
      const original = journal.originalInput(assignment.run_id),
        active = journal.recoverable(assignment.run_id);
      if (mode === "history") {
        expect(
          original.flatMap((item) =>
            "content" in item && Array.isArray(item.content)
              ? item.content.filter((part) => part.type === "input_image")
              : [],
          ),
        ).toHaveLength(3);
        expect(Buffer.byteLength(JSON.stringify(active))).toBeLessThan(CLAUDE_REQUEST_BYTES);
      } else {
        expect(
          original.filter(
            (item) =>
              item.type === "function_call_output" &&
              typeof item.output === "string" &&
              item.output.length === 32_000_000,
          ),
        ).toHaveLength(1);
        expect(active?.seenCallIds).toEqual(["capture-1"]);
      }
      expect(events.some((event) => event.kind === "state" && event.state === "succeeded")).toBe(
        mode === "history",
      );
      await Bun.write(
        `.omo/evidence/claude-bounded-context/runtime-body-${mode}.json`,
        JSON.stringify(
          {
            round,
            captures: tools.calls,
            failures,
            bodies: f.bodyBytes,
            requestHashes: f.requests.map((body) => nativeHash(body)),
            countHashes: f.counts.map((body) => nativeHash(body)),
            activeBytes: Buffer.byteLength(JSON.stringify(active)),
            originalHash: nativeHash(original),
            archive: active?.nativeContext?.archive,
          },
          null,
          2,
        ),
      );
    } finally {
      await runtime.stop();
      journal.close();
      f.provider.close();
      await f.close();
      await control.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);
