import { afterAll, beforeAll, expect, test } from "bun:test";
import { z } from "zod";
import { createDatabase } from "../services/control/db";
import { hashToken } from "../services/control/auth";
import { SemanticNote } from "../packages/context/schema";
import { rawSource, referenceSource } from "../packages/context/store-source";
import { allowsRetention } from "../packages/context/store-retention";
import { sourceList, sourceView, retainedContextSources } from "../packages/context/store-read";
import { retainedContextNotes, snapshotContextNotes } from "../packages/context/store-notes-read";
import { sourceBatch, requireSource } from "../packages/context/source-batch";

const url = process.env["TEST_DATABASE_URL"] ?? "postgres://assistant:assistant@127.0.0.1:55439/semantic_context_batch_1007";
const sql = createDatabase(url);
let queries = 0;
sql.options.debug = () => { queries++; };
beforeAll(async () => {
  const process = Bun.spawn(["bun", "scripts/migrate.ts"], { env: { ...Bun.env, DATABASE_URL: url }, stdout: "pipe", stderr: "pipe" });
  expect(await process.exited).toBe(0);
});
afterAll(() => sql.end());
type Action = "allow" | "inherit" | "deny_turn" | "deny_task";
async function fixture() {
  const workspace = crypto.randomUUID(), conversation = crypto.randomUUID(), task = crypto.randomUUID();
  await sql`INSERT INTO assistant.workspaces(id,name) VALUES(${workspace},'batch fixture')`;
  await sql`INSERT INTO assistant.conversations(id,workspace_id,title) VALUES(${conversation},${workspace},'batch fixture')`;
  await sql`INSERT INTO assistant.tasks(id,workspace_id,conversation_id,objective,state) VALUES(${task},${workspace},${conversation},'batch fixture','running')`;
  const scope = { workspace, conversation };
  async function message(input: Readonly<{ role?: "user" | "assistant" | "system"; action?: Action; task?: string | null }> = {}) {
    const id = crypto.randomUUID(), taskId = input.task === undefined ? task : input.task;
    await sql`INSERT INTO assistant.messages(id,workspace_id,conversation_id,task_id,role,content) VALUES(${id},${workspace},${conversation},${taskId},${input.role ?? "user"},'Exact batch evidence')`;
    if (input.action) {
      if (taskId) await sql`INSERT INTO assistant.memory_retention_decisions(workspace_id,task_id,source_message_id,action) VALUES(${workspace},${taskId},${id},${input.action})`;
      else await sql`INSERT INTO assistant.semantic_source_retention(workspace_id,conversation_id,source_message_id,action) VALUES(${workspace},${conversation},${id},${input.action})`;
    }
    return rawSource(sql, scope, id);
  }
  async function link(source: Awaited<ReturnType<typeof message>>, origin: string | null = null, existing?: string) {
    const context = existing ?? crypto.randomUUID(), sha = await hashToken(JSON.stringify(source));
    if (!existing) await sql`INSERT INTO assistant.semantic_contexts(id,workspace_id,conversation_id,title,scope,revision,source_sequence,initiating_message_id) VALUES(${context},${workspace},${conversation},'Batch','Batch context',1,${source.sequence},${source.message_id})`;
    await sql`INSERT INTO assistant.semantic_context_sources(workspace_id,conversation_id,message_id,sha256,snapshot) VALUES(${workspace},${conversation},${source.message_id},${sha},${JSON.stringify(source)}::text::jsonb)`;
    await sql`INSERT INTO assistant.semantic_context_links(workspace_id,conversation_id,message_id,context_id,revision,status,source_sequence,source_sha256,evidence,originating_message_id) VALUES(${workspace},${conversation},${source.message_id},${context},1,'confirmed',${source.sequence},${sha},'[]',${origin})`;
    return context;
  }
  return { ...scope, scope, task, message, link };
}

test("bounds repeated-source hydration queries and preserves full source and 40-note outputs", async () => {
  // Given: forty notes share two sources and ordered attachment evidence.
  const f = await fixture(), source = await f.message({ action: "inherit" }), second = await f.message({ action: "allow" });
  const files = [crypto.randomUUID(), crypto.randomUUID()];
  for (const [position, id] of [...files.entries()].reverse()) {
    await sql`INSERT INTO assistant.artifacts(id,workspace_id,conversation_id,name,media_type,bytes,sha256,object_key,state,lease_id) VALUES(${id},${f.workspace},${f.conversation},${`file-${position}.txt`},'text/plain',42,${"a".repeat(64)},${id},'ready',${crypto.randomUUID()})`;
    await sql`INSERT INTO assistant.message_artifacts(workspace_id,conversation_id,message_id,artifact_id,position) VALUES(${f.workspace},${f.conversation},${source.message_id},${id},${position})`;
  }
  const original = await rawSource(sql, f.scope, source.message_id), context = await f.link(original);
  await f.link(second, null, context);
  const sha = await hashToken(JSON.stringify(original));
  const evidence = JSON.stringify([{ message_id: original.message_id, quote: "file-0.txt" }, { message_id: second.message_id, quote: second.content }]);
  const expected = z.array(SemanticNote.extend({ superseded_by: z.null() })).parse(await sql`INSERT INTO assistant.semantic_context_notes(id,workspace_id,conversation_id,context_id,context_revision,kind,text,evidence,basis,source_message_id,source_sha256,source_sequence) SELECT gen_random_uuid(),${f.workspace},${f.conversation},${context},n,'fact','Batch note '||n,${evidence}::text::jsonb,'user_statement',${original.message_id},${sha},${original.sequence} FROM generate_series(1,40) n RETURNING id,context_revision,kind,text,evidence,basis,source_message_id,source_sha256,source_sequence,supersedes,superseded_by,valid_from,valid_to,recorded_at`).sort((a,b) => a.id.localeCompare(b.id));
  const baseline = await Promise.all([original, second, original].map(raw => sourceView(sql, f.scope, raw)));
  // When: hydrate full pages and repeated source IDs through the production readers.
  queries = 0;
  const page = await retainedContextNotes(sql, f.scope, { context_id: context, limit: 64 });
  const noteQueries = queries;
  queries = 0;
  const sources = await sourceList(sql, f.scope, [original.message_id, second.message_id, original.message_id]);
  const sourceQueries = queries;
  queries = 0;
  const snapshot = await snapshotContextNotes(sql, f.scope, { context_id: context, through: Number.MAX_SAFE_INTEGER, note_ids: expected.map(note => note.id) });
  const snapshotQueries = queries;
  const sourcePage = await retainedContextSources(sql, f.scope, { context_id: context });
  // Then: exact source/hash/notes stay identical while the query count is independent of repeated notes.
  expect(page.notes).toEqual(expected); expect(page.next_after_id).toBeNull();
  expect(sources).toEqual(baseline); expect(sources[0]?.attachments.map(file => file.id)).toEqual(files);
  expect(snapshot).toEqual([...expected].sort((a,b) => b.context_revision-a.context_revision || a.id.localeCompare(b.id)));
  expect(sourcePage.sources).toEqual(baseline.slice(0,2));
  console.log(JSON.stringify({ scenario: "40 repeated-source notes", noteQueries, sourceQueries, snapshotQueries, notes: page.notes.length, sourceHash: sha }));
  expect(noteQueries).toBeLessThanOrEqual(3); expect(sourceQueries).toBeLessThanOrEqual(2); expect(snapshotQueries).toBeLessThanOrEqual(3);
});

test("matches authoritative retention for pending, denial, inheritance, origins, suppression and null tasks", async () => {
  // Given: independent conversations exercise every branch of the existing retention reader.
  const cases: { name: string; scope: { workspace: string; conversation: string }; id: string; expected: boolean }[] = [];
  for (const taskless of [false, true]) {
    for (const action of [undefined, "allow", "inherit", "deny_turn", "deny_task"] as const) {
      const f = await fixture(), source = await f.message({ ...(action ? { action } : {}), ...(taskless ? { task: null } : {}) });
      cases.push({ name: `${taskless ? "null-task" : "task"}-${action ?? "pending"}`, scope: f.scope, id: source.message_id, expected: action === "allow" || action === "inherit" });
    }
  }
  for (const persistent of ["allow", "deny_task"] as const) {
    const f = await fixture(); await f.message({ action: persistent });
    const source = await f.message({ action: "inherit" });
    cases.push({ name: `inherit-${persistent}`, scope: f.scope, id: source.message_id, expected: persistent === "allow" });
  }
  for (const kind of ["earlier-pending", "non-user-persistent", "deny-turn-then-inherit"] as const) {
    const f = await fixture();
    if (kind === "earlier-pending") await f.message();
    if (kind === "non-user-persistent") await f.message({ role: "system", action: "deny_task" });
    if (kind === "deny-turn-then-inherit") await f.message({ action: "deny_turn" });
    const source = await f.message({ action: kind === "earlier-pending" ? "allow" : "inherit" });
    cases.push({ name: kind, scope: f.scope, id: source.message_id, expected: kind === "deny-turn-then-inherit" });
  }
  for (const kind of ["no-users", "pending", "no-origin", "valid-origin", "suppressed-origin", "suppressed-assistant", "wrong-role", "future-origin", "wrong-task"] as const) {
    const f = await fixture();
    if (kind === "no-users") { const s = await f.message({ role: "system" }); cases.push({ name: kind, scope: f.scope, id: s.message_id, expected: true }); continue; }
    const origin = await f.message({ role: kind === "wrong-role" ? "system" : "user", ...(kind === "pending" ? {} : { action: "allow" }) });
    const assistant = await f.message({ role: "assistant", ...(kind === "wrong-task" ? { task: null } : {}) });
    const later = await f.message();
    if (kind !== "no-origin") await f.link(assistant, kind === "future-origin" ? later.message_id : origin.message_id);
    if (kind === "suppressed-origin" || kind === "suppressed-assistant") await sql`INSERT INTO assistant.memory_suppressions(workspace_id,source_message_id) VALUES(${f.workspace},${kind === "suppressed-origin" ? origin.message_id : assistant.message_id})`;
    cases.push({ name: kind, scope: f.scope, id: assistant.message_id, expected: kind === "valid-origin" || kind === "no-origin" });
  }
  // When/Then: compare each batched decision with the unchanged authoritative reader and the expected outcome.
  for (const c of cases) {
    const source = await referenceSource(sql, c.scope, c.id), authoritative = await allowsRetention(sql, c.scope, source);
    const batch = requireSource(await sourceBatch(sql, c.scope, [c.id]), c.id);
    expect({ name: c.name, retained: batch.retentionAllowed }).toEqual({ name: c.name, retained: c.expected });
    expect(batch.retentionAllowed).toBe(authoritative); expect(batch.raw).toEqual(source); expect(batch.sha256).toBe(await hashToken(JSON.stringify(source)));
  }
  console.log(JSON.stringify({ scenario: "retention differential", cases: cases.length, matched: true }));
});

test("chunks unique IDs, rejects foreign sources, and observes fresh retention on each read", async () => {
  // Given: 129 unique system messages and one foreign workspace source.
  const f = await fixture(), foreign = await fixture(), outsider = await foreign.message({ action: "allow" });
  const ids = z.array(z.object({ id: z.uuid() })).parse(await sql`INSERT INTO assistant.messages(workspace_id,conversation_id,task_id,role,content) SELECT ${f.workspace},${f.conversation},${f.task},'system','Bounded source' FROM generate_series(1,129) RETURNING id`).map(row => row.id);
  const first = ids[0]; if (!first) throw new TypeError("missing fixture source");
  // When: a source set crosses the chunk boundary, then a later read follows suppression.
  queries = 0;
  const sources = await sourceList(sql, f.scope, ids), count = queries;
  await sql`INSERT INTO assistant.memory_suppressions(workspace_id,source_message_id) VALUES(${f.workspace},${first})`;
  const refreshed = await sourceList(sql, f.scope, [first]);
  // Then: bounded reads preserve order, workspace isolation, and current retention.
  expect(sources.map(source => source.message_id)).toEqual(ids); expect(count).toBe(4);
  expect(sources[0]?.retention_allowed).toBe(true); expect(refreshed[0]?.retention_allowed).toBe(false);
  await expect(sourceList(sql, f.scope, [outsider.message_id])).rejects.toMatchObject({ code: "invalid_source" });
  console.log(JSON.stringify({ scenario: "129-source chunk boundary", count, freshSuppression: true, foreignRejected: true }));
});
