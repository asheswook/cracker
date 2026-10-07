import { expect, test } from "bun:test";
import ky from "ky";
import { z } from "zod";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Journal } from "../services/daemon/journal";
import { MemoryQueue } from "../services/daemon/memory";
import type { Provider } from "../packages/provider";
import { ExtractionRequest } from "../packages/memory/schema";
class PageJournal extends Journal {
  readonly saved = Promise.withResolvers<void>();
  readonly finished = Promise.withResolvers<void>();
  override queueMemory(run: string, payload: string) {
    super.queueMemory(run, payload);
    const job = z
      .object({ kind: z.string(), after_sequence: z.number().optional() })
      .parse(JSON.parse(payload));
    if (job.kind === "pending" && job.after_sequence) this.saved.resolve();
  }
  override finishMemory(run: string) {
    super.finishMemory(run);
    this.finished.resolve();
  }
}
test("memory pagination checkpoint survives restart and excludes unrelated sources", async () => {
  // Given real SQLite restart and HTTP pages; provider fixtures test transport/provenance only, not semantic extraction quality.
  const directory = await mkdtemp(join(tmpdir(), "memory-pages-")),
    path = join(directory, "journal.sqlite"),
    run = crypto.randomUUID(),
    task = crypto.randomUUID(),
    conversation = crypto.randomUUID();
  const sources = [1, 2].map((sequence) => ({
    id: crypto.randomUUID(),
    task_id: task,
    conversation_id: conversation,
    role: "user",
    content: "source-" + sequence,
    sequence,
    created_at: new Date().toISOString(),
    client_message_id: null,
  }));
  const snapshots: string[][] = [],
    persisted: string[][] = [],
    derivations: string[] = [];
  const provider: Provider = {
    respond: async (input) => {
      const message = input[1];
      if (!message || !("content" in message) || typeof message.content !== "string")
        throw new TypeError("Expected source payload");
      snapshots.push(
        z
          .object({ sources: z.array(z.object({ id: z.string() })) })
          .parse(JSON.parse(message.content))
          .sources.map((s) => s.id),
      );
      return {
        id: crypto.randomUUID(),
        created_at: 0,
        output_text: "",
        error: null,
        incomplete_details: null,
        instructions: null,
        metadata: null,
        model: "fixture",
        object: "response",
        output: [
          {
            type: "message",
            id: crypto.randomUUID(),
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: JSON.stringify({ schema_version: 1, claims: [], retention_decisions: sources.map(s => ({source_message_id:s.id,action:"inherit",quote:null})) }),
                annotations: [],
              },
            ],
          },
        ],
        parallel_tool_calls: false,
        temperature: null,
        tool_choice: "auto",
        tools: [],
        top_p: null,
        status: "completed",
      };
    },
  };
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/responsibilities")) return Response.json({ evaluations: [] });
      if (url.pathname.endsWith("/memory")) {
        const body = ExtractionRequest.parse(await request.json());
        persisted.push(body.source_ids);
        derivations.push(body.derivation_id);
        return Response.json({ accepted: true });
      }
      if (url.searchParams.get("view") !== "task_sources")
        return new Response(null, { status: 400 });
      const next = url.searchParams.get("after") === "1";
      return Response.json({
        messages: [sources[next ? 1 : 0]],
        retention_context: { sources, decisions: [] },
        memory: [],
        next_after_sequence: next ? null : 1,
      });
    },
  });
  const http = ky.create({ prefixUrl: server.url.href, retry: 0 });
  const initial = new PageJournal(path),
    first = new MemoryQueue({ journal: initial, http, provider });
  let second: MemoryQueue | undefined, reopened: PageJournal | undefined;
  try {
    initial.queueMemory(
      run,
      JSON.stringify({ kind: "pending", derivation_id: crypto.randomUUID() }),
    );
    first.tick();
    await initial.saved.promise;
    await first.stop();
    initial.close();
    // When a new queue opens the committed next-page checkpoint.
    reopened = new PageJournal(path);
    second = new MemoryQueue({ journal: reopened, http, provider });
    second.tick();
    await reopened.finished.promise;
    await second.stop();
    // Then each source appears once; no whole-feed snapshot and no page is silently discarded.
    expect(snapshots).toEqual(sources.map((s) => [s.id]));
    expect(persisted).toEqual(snapshots);
    expect(new Set(derivations).size).toBe(2);
    expect(reopened.memoryJob()).toBeNull();
  } finally {
    await first.stop();
    await second?.stop();
    reopened?.close();
    await server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});
