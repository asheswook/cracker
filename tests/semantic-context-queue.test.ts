import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import ky from "ky";
import type { ModelBinding } from "../packages/models/schema.ts";
import type { RunModelResolver } from "../services/daemon/model-resolver.ts";
import { Journal } from "../services/daemon/journal.ts";
import { SemanticMetadataQueue } from "../services/daemon/semantic-context-queue.ts";
import type { SemanticCheckpoint } from "../services/daemon/semantic-context-state.ts";
import type { Assignment } from "../packages/protocol/index.ts";
import { Database } from "bun:sqlite";

for (const failure of ["unavailable", "stale_revision", "invalid_evidence"] as const) test(`metadata ${failure} retries survive SQLite reopen and retain the generating model binding`, async () => {
  // Given a durable job was enqueued with the original run's model selection.
  const directory = await mkdtemp(join(tmpdir(), "semantic-queue-")), path = join(directory, "journal.sqlite");
  const runId = crypto.randomUUID(), contextId = crypto.randomUUID();
  const binding: ModelBinding = { revision_id: crypto.randomUUID(), selection: { provider: "chatgpt", model: "gpt-6-astra", reasoning_effort: "low" } };
  const original = new Journal(path);
  const state: SemanticCheckpoint = { active: null, pending: [contextId], ...(failure !== "unavailable" ? { mutation: {
    operation_id: crypto.randomUUID(), context_id: contextId, expected_revision: 1, source_message_id: crypto.randomUUID(), source_sha256: "a".repeat(64), mode: "live" as const,
    notes: [{ id: crypto.randomUUID(), kind: "fact" as const, text: "Old source", evidence: [{ message_id: crypto.randomUUID(), quote: "Old source" }], supersedes: null, valid_from: null, valid_to: null }],
  } } : {}) };
  const job = { runId, taskId: crypto.randomUUID(), binding, state };
  original.semantic.enqueue(job); original.semantic.enqueue(job); original.close();
  const restored = new Journal(path), bindings: Array<ModelBinding | undefined> = [];
  let requests = 0, available = false, released = 0;
  const server = Bun.serve({ port: 0, fetch: async request => {
    requests++;
    expect(new URL(request.url).pathname).toBe(`/v1/daemon/context/${runId}/semantic/${failure !== "unavailable" && !available ? "notes" : "snapshot"}`);
    expect(await request.json()).toEqual(failure !== "unavailable" && !available ? state.mutation : { context_id: contextId, mode: "backfill" });
    return available ? Response.json({ context: { context_id: contextId, title: "Fixture", scope: "Fixture", revision: 2, source_sequence: 2, notes: [], recent_messages: [], files: [] } }) : Response.json({ error: { code: failure } }, { status: failure === "unavailable" ? 503 : 409 });
  } });
  const provider = { respond: async (): Promise<never> => { throw new TypeError("No model inference expected without sources"); } };
  const models: RunModelResolver = { forRun: async (id, _signal, expected) => { expect(id).toBe(runId); bindings.push(expected); return { provider, release: async () => { released++; } }; }, current: async () => { throw new TypeError("Current model must not replace the pinned run model"); } };
  const queue = new SemanticMetadataQueue({ jobs: restored.semantic, http: ky.create({ prefixUrl: server.url.href, retry: 0 }), provider, models });
  try {
    // When the first retry fails, an immediate tick waits, and a later retry succeeds.
    await queue.process(); await queue.process();
    expect(requests).toBe(1);
    available = true; await queue.process(Number.MAX_SAFE_INTEGER);
    // Then persisted work is drained once, preserving the binding and releasing both leases.
    expect(bindings).toEqual([binding, binding]);
    expect(released).toBe(2);
    expect(restored.semantic.next(Number.MAX_SAFE_INTEGER)).toBeNull();
  } finally { await queue.stop(); restored.close(); await server.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("a later delivery survives an older in-flight job and completed handoffs deduplicate after reopen", async () => {
  // Given two deliveries share the same run, source and semantic context.
  const directory = await mkdtemp(join(tmpdir(), "semantic-deliveries-")), path = join(directory, "journal.sqlite");
  const journal = new Journal(path), contextId = crypto.randomUUID();
  const assignment: Assignment = { run_id: crypto.randomUUID(), task: { id: crypto.randomUUID(), conversation_id: crypto.randomUUID(), objective: "fixture", state: "running", reason: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }, messages: [], instructions: "fixture", memory: [] };
  const state: SemanticCheckpoint = { active: { context_id: contextId, message_id: crypto.randomUUID() }, pending: [contextId] };
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let requests = 0;
  const server = Bun.serve({ port: 0, fetch: async () => {
    if (++requests === 1) { started.resolve(); await release.promise; }
    return Response.json({ context: { context_id: contextId, title: "Fixture", scope: "Fixture", revision: 1, source_sequence: 1, notes: [], recent_messages: [], files: [] } });
  } });
  const provider = { respond: async (): Promise<never> => { throw new TypeError("No metadata model needed without sources"); } };
  const http = ky.create({ prefixUrl: server.url.href, retry: 0 });
  const queue = new SemanticMetadataQueue({ jobs: journal.semantic, http, provider });
  try {
    queue.enqueue(assignment, state, "delivery-1");
    const first = queue.process(); await started.promise;
    // When another reply is delivered before the older metadata request finishes.
    queue.enqueue(assignment, state, "delivery-2");
    queue.enqueue(assignment, state, "delivery-1");
    release.resolve(); await first;
    // Then finishing the old job preserves the new delivery and crash retries stay deduplicated.
    expect(journal.semantic.next()).not.toBeNull();
    await queue.process();
    expect(requests).toBe(2);
    expect(journal.semantic.next()).toBeNull();
    journal.close();
    const reopened = new Journal(path), restored = new SemanticMetadataQueue({ jobs: reopened.semantic, http, provider });
    try {
      restored.enqueue(assignment, state, "delivery-1"); restored.enqueue(assignment, state, "delivery-2");
      expect(reopened.semantic.next()).toBeNull();
    } finally { await restored.stop(); reopened.close(); }
  } finally { release.resolve(); await queue.stop(); journal.close(); await server.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("completed metadata receipts expire after seven days while replayable runs stay protected", async () => {
  // Given an aged receipt for a run that still has an active recovery lifecycle.
  const directory = await mkdtemp(join(tmpdir(), "semantic-receipts-")), path = join(directory, "journal.sqlite");
  const journal = new Journal(path), db = new Database(path), runId = crypto.randomUUID();
  const job = { runId, taskId: crypto.randomUUID(), state: { active: null, pending: [] }, delivery_revision: "one" };
  try {
    journal.start(runId); journal.semantic.enqueue(job);
    const entry = journal.semantic.next();
    if (!entry) throw new TypeError("Expected durable metadata job");
    journal.semantic.finish(entry.id);
    db.query("UPDATE semantic_metadata_receipts SET finished_at=?").run(Date.now() - 8 * 86400000);
    // When enqueue maintenance runs before and after the originating run finishes.
    journal.semantic.enqueue(job);
    expect(journal.semantic.next()).toBeNull();
    journal.finish(runId); journal.semantic.enqueue(job);
    // Then the active run was protected, while the old completed receipt can expire.
    expect(journal.semantic.next()).not.toBeNull();
  } finally { db.close(); journal.close(); await rm(directory, { recursive: true, force: true }); }
});
