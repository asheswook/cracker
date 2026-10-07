import { extractMemory } from "../packages/memory/extract";
import { memoryProviderFixture } from "./memory-provider-fixture";
import { createApp } from "../services/control/app";
import { hashToken } from "../services/control/auth";
import { retentionContext } from "../packages/memory/retention-store";
import { taskSources } from "../services/control/repository/task-context";
import { afterAll, expect, test } from "bun:test";
import { z } from "zod";
import { createDatabase } from "../services/control/db";
import { persistExtraction } from "../packages/memory/persist";
import { inputHash, type Claim } from "../packages/memory/schema";
const sql = createDatabase(z.string().min(1).parse(process.env["TEST_DATABASE_URL"]));
afterAll(async () => { await sql.end(); });
async function fixture(action: "inherit" | "allow" | "deny_task" | "deny_turn") {
  const workspace = crypto.randomUUID(), vm = crypto.randomUUID(), conversation = crypto.randomUUID(), task = crypto.randomUUID(), run = crypto.randomUUID();
  await sql`INSERT INTO workspaces(id,name) VALUES(${workspace},'retention')`;
  await sql`INSERT INTO vms(id,workspace_id,name) VALUES(${vm},${workspace},'retention')`;
  await sql`INSERT INTO conversations(id,workspace_id,title) VALUES(${conversation},${workspace},'retention')`;
  await sql`INSERT INTO tasks(id,workspace_id,conversation_id,objective) VALUES(${task},${workspace},${conversation},'retention')`;
  await sql`INSERT INTO runs(id,workspace_id,task_id,vm_id) VALUES(${run},${workspace},${task},${vm})`;
  const content = action === "deny_task" ? "나는 Rust를 사용한다. 파일·설정·메모리·예약은 변경하지 마." : "Remember that I use Rust.";
  const source = z.object({id:z.uuid(),role:z.literal("user"),content:z.string(),created_at:z.string(),sequence:z.coerce.number()}).parse((await sql`INSERT INTO messages(workspace_id,conversation_id,task_id,role,content) VALUES(${workspace},${conversation},${task},'user',${content}) RETURNING id,role,content,created_at,sequence`)[0]);
  const claim: Claim = {kind:"assertion",context:"task",entity:"user",predicate:"preference",text:"User uses Rust",epistemic_status:"reported",value:"Rust",unit:null,valid_from:null,valid_to:null,time_precision:"unknown",evidence:{source_message_id:source.id,quote:content},supersedes_id:null,correction:false,due_at:null,due_timezone:null};
  const request = {run_id:run,derivation_id:crypto.randomUUID(),input_hash:await inputHash([source]),source_ids:[source.id],extraction:{schema_version:1 as const,claims:[claim]},retention:{input_hash:await inputHash([source]),decisions:[{source_message_id:source.id,action,quote:action === "inherit" ? null : content}]}};
  return {workspace,task,run,source,claim,request,principal:{workspace_id:workspace,vm_id:vm,role:"vm" as const}};
}
test("explicit task denial excludes tempting user facts from persistence", async () => {
  // Given a real task source and a classifier decision denying retention.
  const f = await fixture("deny_task");
  // When the actual PostgreSQL persistence pipeline receives a valid tempting claim.
  const result = await persistExtraction(sql,f.principal,f.request);
  // Then no memory claim is created.
  expect(result.count).toBe(0);
});
test("explicit remember keeps ordinary source-bound facts", async () => {
  // Given an explicit user allow decision.
  const f = await fixture("allow");
  // When persisted through the same database pipeline.
  const result = await persistExtraction(sql,f.principal,f.request);
  // Then the fact remains eligible.
  expect(result.count).toBe(1);
});
async function append(f: Awaited<ReturnType<typeof fixture>>, role: "user" | "assistant", content: string) {
  return z.object({id:z.uuid(),role:z.enum(["user","assistant"]),content:z.string(),created_at:z.string(),sequence:z.coerce.number()}).parse((await sql`INSERT INTO messages(workspace_id,conversation_id,task_id,role,content) SELECT ${f.workspace},conversation_id,${f.task},${role},${content} FROM tasks WHERE id=${f.task} RETURNING id,role,content,created_at,sequence`)[0]);
}
async function candidate(f: Awaited<ReturnType<typeof fixture>>, source: Awaited<ReturnType<typeof append>>) {
  return { ...f.request, derivation_id:crypto.randomUUID(), input_hash:await inputHash([source]), source_ids:[source.id], extraction:{schema_version:1 as const,claims:[{...f.claim,text:source.content,value:source.content,epistemic_status: source.role === "user" ? "reported" as const : "inferred" as const,evidence:{source_message_id:source.id,quote:source.content}}]} };
}
test("late assistant page retains authoritative task denial and creates no memory entities", async () => {
  // Given a persisted denial and more than one source page of assistant results.
  const f = await fixture("deny_task"); await persistExtraction(sql,f.principal,f.request);
  await sql`INSERT INTO messages(workspace_id,conversation_id,task_id,role,content) SELECT ${f.workspace},t.conversation_id,t.id,'assistant','I recommend Rust for durable services.' FROM tasks t CROSS JOIN generate_series(1,101) WHERE t.id=${f.task}`;
  const first = await taskSources(sql,f.principal,f.run,0);
  const late = await taskSources(sql,f.principal,f.run,first.next_after_sequence ?? 0);
  const source = late.messages.at(-1); if (!source || !late.retention_context) throw new TypeError("Missing late page fixture");
  const request = await candidate(f,{...source,role:"assistant"});
  // When valid assistant claims arrive from a page with no user text.
  const result = await persistExtraction(sql,f.principal,request);
  // Then policy context survives pagination and no entity, memory, or correction is created.
  expect(late.messages.every(s => s.role === "assistant")).toBe(true);
  expect(late.retention_context.decisions[0]?.action).toBe("deny_task");
  expect(result.count).toBe(0);
  expect((await sql`SELECT id FROM memory_entities WHERE workspace_id=${f.workspace}`)).toHaveLength(0);
  expect((await sql`SELECT id FROM memories WHERE workspace_id=${f.workspace}`)).toHaveLength(0);
  expect((await sql`SELECT id FROM memory_corrections WHERE workspace_id=${f.workspace}`)).toHaveLength(0);
});
test("cached reclassification cannot flip a previously denied user source", async () => {
  // Given an immutable task denial and a later assistant source.
  const f = await fixture("deny_task"); await persistExtraction(sql,f.principal,f.request);
  const source = await append(f,"assistant","Persist this recommendation"), request = await candidate(f,source);
  request.retention.decisions[0] = {source_message_id:f.source.id,action:"allow",quote:f.source.content};
  // When a retry tries replacing the original policy.
  await expect(persistExtraction(sql,f.principal,request)).rejects.toThrow("retention_decision_conflict");
  // Then no claim from the conflicting retry exists.
  expect((await sql`SELECT id FROM memories WHERE workspace_id=${f.workspace}`)).toHaveLength(0);
});
test("old daemon requests fail closed before retention has been assessed", async () => {
  // Given a fresh task and legacy wire request with no retention assessment.
  const f = await fixture("deny_task"), {retention: _retention,...legacy} = f.request;
  // When a legacy client tries persisting useful facts.
  await expect(persistExtraction(sql,f.principal,legacy)).rejects.toThrow("Memory retention assessment required");
  // Then no automatic memory is written.
  expect((await sql`SELECT id FROM memories WHERE workspace_id=${f.workspace}`)).toHaveLength(0);
});
test("new user input makes an extracted assessment stale before claim persistence", async () => {
  // Given a cached allowed request followed by an unassessed user denial.
  const f = await fixture("allow"); await append(f,"user","Do not save memories for this task.");
  // When the stale request arrives.
  await expect(persistExtraction(sql,f.principal,f.request)).rejects.toThrow("retention_snapshot_stale");
  // Then neither claims nor partial policy records are written.
  expect((await sql`SELECT id FROM memories WHERE workspace_id=${f.workspace}`)).toHaveLength(0);
  expect((await sql`SELECT source_message_id FROM memory_retention_decisions WHERE workspace_id=${f.workspace}`)).toHaveLength(0);
});
test("later explicit allow is prospective and does not release earlier denied facts", async () => {
  // Given a denied turn then an explicit later permission within the same task.
  const f = await fixture("deny_task"); await persistExtraction(sql,f.principal,f.request);
  const earlier = await append(f,"assistant","Earlier private recommendation"), later = await append(f,"user","Now remember that I prefer Rust.");
  const context = await retentionContext(sql,{workspace:f.workspace,task:f.task});
  const retention = {input_hash:await inputHash(context.sources),decisions:[...context.decisions,{source_message_id:later.id,action:"allow" as const,quote:later.content}]};
  const old = await candidate(f,earlier), current = await candidate(f,later);
  const request = {...current,input_hash:await inputHash([earlier,later]),source_ids:[earlier.id,later.id],extraction:{schema_version:1 as const,claims:[...old.extraction.claims,...current.extraction.claims]},retention};
  // When both earlier and later claims appear in one extraction.
  const result = await persistExtraction(sql,f.principal,request);
  // Then only the later allowed source survives.
  expect(result.count).toBe(1);
  expect((await sql`SELECT source_message_id FROM memories WHERE workspace_id=${f.workspace}`).map(r => r["source_message_id"])).toEqual([later.id]);
});
test("turn-only denial ends at the next user message without explicit permission", async () => {
  // Given a one-turn denial followed by an ordinary user fact.
  const f = await fixture("deny_turn"); await persistExtraction(sql,f.principal,f.request);
  const later = await append(f,"user","I use PostgreSQL for my database."), request = await candidate(f,later);
  const context = await retentionContext(sql,{workspace:f.workspace,task:f.task});
  const retention = {input_hash:await inputHash(context.sources),decisions:[...context.decisions,{source_message_id:later.id,action:"inherit" as const,quote:null}]};
  // When extracting the later turn.
  const result = await persistExtraction(sql,f.principal,{...request,retention});
  // Then the one-turn restriction has expired.
  expect(result.count).toBe(1);
});
test("malformed or incomplete policy cannot silently discard or persist facts", async () => {
  // Given an extraction missing a user-source decision.
  const f = await fixture("allow");
  // When the incomplete structured policy reaches persistence.
  await expect(persistExtraction(sql,f.principal,{...f.request,retention:{...f.request.retention,decisions:[]}})).rejects.toThrow("retention_decisions_incomplete");
  // Then the failed assessment is retriable and no derivation consumes the source hash.
  expect((await sql`SELECT id FROM memory_derivations WHERE workspace_id=${f.workspace}`)).toHaveLength(0);
});
test("denied correction does not close or replace an existing allowed memory", async () => {
  // Given a prior allowed memory followed by a task denial carrying a correction.
  const f = await fixture("allow"); await persistExtraction(sql,f.principal,f.request);
  const older = z.object({id:z.uuid()}).parse((await sql`SELECT id FROM memories WHERE workspace_id=${f.workspace}`)[0]);
  const denial = await append(f,"user","Do not save memories in this task. Correction: I prefer Go."), request = await candidate(f,denial);
  const context = await retentionContext(sql,{workspace:f.workspace,task:f.task});
  const first = request.extraction.claims[0]; if (!first) throw new TypeError("Missing correction fixture");
  const extraction = {...request.extraction,claims:[{...first,supersedes_id:older.id,correction:true}]};
  const retention = {input_hash:await inputHash(context.sources),decisions:[...context.decisions,{source_message_id:denial.id,action:"deny_task" as const,quote:"Do not save memories in this task."}]};
  // When a valid correction is extracted from the denied turn.
  const result = await persistExtraction(sql,f.principal,{...request,extraction,retention});
  // Then the earlier memory remains unchanged and no replacement is inserted.
  expect(result.count).toBe(0);
  expect(z.object({known_to:z.string().nullable()}).parse((await sql`SELECT known_to FROM memory_assertions WHERE id=${older.id}`)[0]).known_to).toBeNull();
  expect((await sql`SELECT id FROM memories WHERE workspace_id=${f.workspace}`)).toHaveLength(1);
});
test("old daemon wire payload receives an explicit retention upgrade error", async () => {
  // Given the real authenticated control API and an old wire payload.
  const f = await fixture("deny_task"), token = crypto.randomUUID();
  await sql`INSERT INTO credentials(token_hash,workspace_id,role,vm_id) VALUES(${await hashToken(token)},${f.workspace},'vm',${f.principal.vm_id})`;
  const {retention:_retention,...legacy} = f.request;
  // When the legacy daemon posts through the HTTP route.
  const response = await createApp(sql).request("http://localhost/v1/daemon/memory",{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify(legacy)});
  // Then the wire error identifies the required upgrade without creating memories.
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({error:{code:"retention_assessment_required"}});
});
test("new user input arriving during extraction prevents the completed stale model result from persisting", async () => {
  // Given a model call paused at its external boundary after reading authoritative context.
  const f = await fixture("allow"), context = await retentionContext(sql,{workspace:f.workspace,task:f.task});
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const fixtureProvider = memoryProviderFixture({schema_version:1,claims:[f.claim],retention_decisions:f.request.retention.decisions});
  const pending = extractMemory({respond:async(...args)=>{started.resolve();await release.promise;return fixtureProvider.respond(...args);}},{sources:[f.source],known:[],retention_context:context},AbortSignal.timeout(1000));
  await started.promise; await append(f,"user","Do not save memories for this task."); release.resolve();
  // When the model returns the old snapshot and it reaches the real persistence transaction.
  const extracted = await pending;
  await expect(persistExtraction(sql,f.principal,{...f.request,...extracted})).rejects.toThrow("retention_snapshot_stale");
  // Then the in-flight race has created no claim.
  expect((await sql`SELECT id FROM memories WHERE workspace_id=${f.workspace}`)).toHaveLength(0);
});
test("concurrent conflicting policy assessments serialize without overwriting the winning decision", async () => {
  // Given simultaneous opposite assessments for the same source.
  const f = await fixture("deny_task");
  const assistant = await append(f,"assistant","Later recommendation"), second = await candidate(f,assistant);
  const opposite = {...second,derivation_id:crypto.randomUUID(),retention:{...f.request.retention,decisions:[{source_message_id:f.source.id,action:"allow" as const,quote:f.source.content}]}};
  // When both transactions contend for workspace/conversation locks.
  const outcomes = await Promise.allSettled([persistExtraction(sql,f.principal,f.request),persistExtraction(sql,f.principal,opposite)]);
  // Then at most one derivation consumes the same input and there is one immutable policy row.
  expect(outcomes.filter(o=>o.status === "fulfilled")).toHaveLength(1);
  const rejected = outcomes.find(o=>o.status === "rejected");
  expect(rejected?.status === "rejected" && rejected.reason instanceof Error ? rejected.reason.message : "missing conflict").toBe("retention_decision_conflict");
  expect((await sql`SELECT source_message_id FROM memory_retention_decisions WHERE workspace_id=${f.workspace}`)).toHaveLength(1);
  expect((await sql`SELECT id FROM memory_derivations WHERE workspace_id=${f.workspace}`)).toHaveLength(1);
});
test("already-derived source still records a new retention assessment before idempotent return", async () => {
  // Given a historical derivation from before retention policy existed, without fabricating historical intent.
  const f = await fixture("deny_task");
  await sql`INSERT INTO memory_derivations(id,workspace_id,run_id,input_hash) VALUES(${crypto.randomUUID()},${f.workspace},${f.run},${f.request.input_hash})`;
  // When a new daemon assesses that exact source snapshot.
  const result = await persistExtraction(sql,f.principal,f.request);
  // Then the no-op derivation still commits the authoritative denial for later assistant pages.
  expect(result.count).toBe(0);
  expect((await sql`SELECT action FROM memory_retention_decisions WHERE workspace_id=${f.workspace}`).map(r=>r["action"])).toEqual(["deny_task"]);
});
