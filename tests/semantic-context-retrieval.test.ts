import { expect, test } from "bun:test";
import ky from "ky";
import { LinkRequest, PrepareResult, SemanticContext } from "../packages/context/schema.ts";
import { SemanticContexts } from "../services/daemon/semantic-context.ts";

test("existing context linkage forwards validated older note IDs and source windows", async () => {
  // Given retrieval selected an older note and a non-prefix source window.
  const contextId = crypto.randomUUID(), sourceId = crypto.randomUUID(), oldId = crypto.randomUUID(), noteId = crypto.randomUUID();
  const retrieval = { note_ids: [noteId], source_windows: [{ message_id: oldId, start: 12000, end: 14000 }] };
  const context = SemanticContext.parse({ context_id: contextId, title: "Prior research", scope: "Subject-specific evidence", revision: 9, source_sequence: 4, notes: [], recent_messages: [], files: [], retrieval });
  const prepared = PrepareResult.parse({ source: { message_id: sourceId, task_id: crypto.randomUUID(), sequence: 8, role: "user", content: "Return to that research", truncated: false, sha256: "a".repeat(64), attachments: [], retention_allowed: true }, retention_context: { sources: [], decisions: [] }, neighbors: [], candidates: [context], linked: null, history: { messages: [], next_after_sequence: null, has_more: false }, decision: { context_id: contextId, outcome: "existing", scores: [], model: "classifier" } });
  let linked: ReturnType<typeof LinkRequest.parse> | undefined;
  const server = Bun.serve({ port: 0, fetch: async request => {
    if (new URL(request.url).pathname.endsWith("/prepare")) return Response.json(prepared);
    linked = LinkRequest.parse(await request.json());
    return Response.json({ link: { message_id: sourceId, context_id: contextId, revision: 1, status: "confirmed", source_sequence: 8, source_sha256: "a".repeat(64), evidence: [{ message_id: sourceId, quote: "Return to that research" }] }, context: { ...context, revision: 10, source_sequence: 8 } });
  } });
  const coordinator = new SemanticContexts({ http: ky.create({ prefixUrl: server.url.href, retry: 0 }), runId: crypto.randomUUID(), taskId: crypto.randomUUID(), provider: { respond: async () => { throw new TypeError("Existing classifier selection must not require fallback generation"); } } });
  try {
    // When the current source is linked to its existing context.
    const result = await coordinator.index(sourceId, new AbortController().signal);
    // Then the backend receives the retrieval selection while advancing context revision.
    expect(linked?.note_ids).toEqual([noteId]);
    expect(linked?.source_windows).toEqual([{ message_id: oldId, start: 12000, end: 14000 }]);
    expect(result?.revision).toBe(10);
    expect(result?.retrieval).toEqual(retrieval);
  } finally { await server.stop(true); }
});
