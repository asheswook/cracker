import { expect, test } from "bun:test";
import ky from "ky";
import { WorkSearchPage } from "../packages/protocol/work-search.ts";
import { runWorkSearch } from "../services/daemon/work-search.ts";
import { TaskArtifacts } from "../services/daemon/artifacts.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("legacy search responses default document coverage to zero without changing text coverage", () => {
  expect(WorkSearchPage.parse({ hits: [], next_cursor: null, unindexed_text_files: 3 })).toEqual({
    hits: [], next_cursor: null, unindexed_text_files: 3, pending_document_files: 0, failed_document_files: 0,
  });
});

test("coverage counts accept independent zero/positive counts and reject malformed counts", () => {
  for (const field of ["pending_document_files", "failed_document_files"]) {
    for (const count of [0, 2]) {
      expect(WorkSearchPage.safeParse({ hits: [], next_cursor: null, unindexed_text_files: 0, [field]: count }).success).toBe(true);
    }
    for (const count of [-1, 1.5, null, "2"]) {
      expect(WorkSearchPage.safeParse({ hits: [], next_cursor: null, unindexed_text_files: 0, [field]: count }).success).toBe(false);
    }
  }
});

test("actual daemon search tool preserves parsed coverage counts and scoped request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "work-search-coverage-"));
  const requests: unknown[] = [];
  const response = { hits: [], next_cursor: null, unindexed_text_files: 3, pending_document_files: 2, failed_document_files: 1 };
  const server = Bun.serve({ port: 0, async fetch(request) {
    requests.push({ path: new URL(request.url).pathname, body: await request.json() });
    return Response.json(response);
  } });
  try {
    const http = ky.create({ prefixUrl: server.url.href, retry: 0 });
    const runId = crypto.randomUUID(), conversationId = crypto.randomUUID();
    const artifacts = await TaskArtifacts.create({ http, runId, conversationId, root: directory });
    const request = { query: "prior needle", cursor: null, conversation_id: conversationId, state: "finished", limit: 10 };
    const result = await runWorkSearch(http, { runId, artifacts }, { name: "search_prior_work", args: JSON.stringify(request), signal: AbortSignal.timeout(5000) });
    expect(JSON.parse(result)).toEqual(response);
    expect(requests).toEqual([{ path: `/v1/daemon/context/${runId}/search`, body: request }]);
  } finally {
    server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});
