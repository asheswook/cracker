import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import ky, { HTTPError } from "ky";
import type { Response, ResponseOutputItem } from "openai/resources/responses/responses";
import { SemanticContext } from "../packages/context/schema.ts";
import { RetentionContext } from "../packages/memory/retention.ts";
import type { Provider, ResponseInputItem } from "../packages/provider/index.ts";
import { createApp } from "../services/control/app.ts";
import { hashToken } from "../services/control/auth.ts";
import { createDatabase } from "../services/control/db.ts";
import { Journal } from "../services/daemon/journal.ts";
import { Runtime } from "../services/daemon/runtime.ts";
import { ToolExecutor } from "../services/daemon/tools.ts";
import { SemanticContexts } from "../services/daemon/semantic-context.ts";
import type { SemanticCheckpoint } from "../services/daemon/semantic-context-state.ts";
import { SemanticMetadataQueue } from "../services/daemon/semantic-context-queue.ts";
import { SemanticStructure } from '../services/daemon/semantic-structure.ts';

class CompletionJournal extends Journal {
  next = Promise.withResolvers<void>();
  override finish(run: string): void { super.finish(run); this.next.resolve(); }
}
function response(output: ResponseOutputItem[]): Response {
  return { id: crypto.randomUUID(), created_at: 0, output_text: "", error: null, incomplete_details: null, instructions: null, metadata: null, model: "fixture", object: "response", output, parallel_tool_calls: false, temperature: null, tool_choice: "auto", tools: [], top_p: null, status: "completed" };
}
function answer(text: string): Extract<ResponseOutputItem, { type: "message" }> {
  return { type: "message", id: crypto.randomUUID(), role: "assistant", status: "completed", phase: "final_answer", content: [{ type: "output_text", text, annotations: [] }] };
}
function metadata(name: string, value: unknown): Response {
  return response([{ type: "function_call", call_id: crypto.randomUUID(), name, arguments: JSON.stringify(value) }]);
}
function lastJSON(input: ResponseInputItem[]): unknown {
  const item = input.at(-1);
  if (!item || !("content" in item) || typeof item.content !== "string") throw new TypeError("Missing metadata input");
  return JSON.parse(item.content);
}
const Packet = z.object({ kind: z.literal("semantic_context_reference"), context: SemanticContext.nullable() });
test('on appends one structure frame per mailbox turn without changing the provider prefix',async()=>{
 const snapshots:ResponseInputItem[][]=[];
 const f=await fixture({structureMode:'on',main:async(input,db)=>{
  snapshots.push(structuredClone(input.slice(0,-1))); // Non-native per-call clock is not a persisted frame.
  if(snapshots.length===1)await db.message('Second independent mailbox question');
  return response([answer('Fixture response')]);
 }});
 try{
  await f.message('First independent mailbox question');await f.runtime.tick();await f.journal.next.promise;
  expect(snapshots).toHaveLength(2);
  const frames=(input:ResponseInputItem[])=>input.filter(item=>'content'in item&&typeof item.content==='string'&&item.content.startsWith('{"kind":"semantic_structure_reference"'));
  expect(frames(snapshots[0]!)).toHaveLength(1);expect(frames(snapshots[1]!)).toHaveLength(2);
  expect(snapshots[1]!.slice(0,snapshots[0]!.length)).toEqual(snapshots[0]!);
 }finally{await f.close();}
});
for(const structureMode of ['shadow','on'] as const)test(`structure ${structureMode} preserves reference and appends only in on mode`,async()=>{
 const inputs:ResponseInputItem[][]=[],packets:string[]=[];
 const f=await fixture({structureMode,main:async input=>{inputs.push(input);for(const item of input)if('content'in item&&typeof item.content==='string'&&item.content.includes('"kind":"semantic_context_reference"'))packets.push(item.content);return response([answer('구조 검증 비공개 답변')]);}});
 try{
  const user=await f.message('구조 검증 비공개 질문');await f.runtime.tick();await f.journal.next.promise;await f.runtime.flush();
  const before=JSON.stringify(inputs),queue=f.structureQueue();
  for(let i=0;i<5;i++)await queue.process();
    expect(JSON.stringify(inputs)).toBe(before);expect(packets).toHaveLength(1);expect(JSON.stringify(inputs)).not.toContain('semantic_structure_shadow');expect(JSON.stringify(inputs)).not.toContain('judge_w1b_structure');
   const delivered=inputs.flat().filter(item=>'content'in item&&typeof item.content==='string'&&item.content.includes('"kind":"semantic_structure_reference"'));
   expect(delivered).toHaveLength(structureMode==='on'?1:0);
  expect(f.structureLogs).toHaveLength(1);expect(JSON.stringify(f.structureLogs)).not.toContain('비공개');
  const messages=await f.sql`SELECT id,response_to_message_id,applied_user_ids FROM assistant.messages WHERE workspace_id=${f.workspace} AND conversation_id=${f.conversation} AND role='assistant'`;
  expect(messages[0]?.['response_to_message_id']).toBe(user);expect(messages[0]?.['applied_user_ids']).toEqual([user]);
  const members=await f.sql`SELECT message_id FROM assistant.semantic_exchange_members WHERE workspace_id=${f.workspace}`;expect(members.map(m=>m['message_id'])).toContain(messages[0]?.['id']);
  const edges=await f.sql`SELECT status,method FROM assistant.semantic_exchange_edges WHERE workspace_id=${f.workspace}`;expect(edges).toHaveLength(1);expect(edges[0]?.['status']).toBe('provisional');expect(edges[0]?.['method']).toBe('llm');
 }finally{await f.close();}
});
function activePacket(input: ResponseInputItem[]) {
  for (const item of input.toReversed()) {
    if (!("content" in item) || typeof item.content !== "string" || !item.content.startsWith("{")) continue;
    const parsed = Packet.safeParse(JSON.parse(item.content));
    if (parsed.success) return parsed.data.context;
  }
  throw new TypeError("Missing context packet");
}
async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new TypeError("Metadata transition did not complete");
    await Bun.sleep(10);
  }
}
async function fixture(options: { readonly structureMode?: 'shadow'|'on'; readonly main: (input: ResponseInputItem[], fixture: Awaited<ReturnType<typeof databaseFixture>>) => Promise<Response>; readonly malformedRoute?: boolean; readonly beforeNotes?: (signal: AbortSignal) => Promise<void>; readonly dropNotesOnce?: boolean; readonly failPrepareOnce?: boolean; readonly staleLinkOnce?: boolean }) {
  const data = await databaseFixture();
  const directory = await mkdtemp(join(tmpdir(), "semantic-runtime-"));
  const journal = new CompletionJournal(":memory:");
  let routes = 0;
  const noteInputs: z.infer<typeof SemanticContext>[] = [];
  const provider: Provider = { respond: async (input, tools, signal) => {
    const name = tools.length === 1 && tools[0]?.type === "function" ? tools[0].name : undefined;
      if(name==='judge_w1b_structure')return metadata(name,{anchor_exchange_id:null,relation:'new_topic',target:null,anchor_confidence:1,relation_confidence:1,subject_action:'new_root',subject_confidence:1,subject_name:'구조 검증',branch_from:null,return_region_id:null,return_evidence:null,references:[]});
    if (name === "assess_semantic_retention") {
      const context = RetentionContext.parse(lastJSON(input));
      return metadata(name, { decisions: context.sources.map(source => context.decisions.find(item => item.source_message_id === source.id) ?? { source_message_id: source.id, action: "inherit", quote: null }) });
    }
    if (name === "select_semantic_context") {
      routes++;
      if (options.malformedRoute) return response([answer("malformed route")]);
      const prepared = z.object({ incoming: z.object({ text: z.string() }) }).parse(lastJSON(input));
      return metadata(name, { context_id: null, title: prepared.incoming.text.startsWith("Calendar") ? "Calendar MCP" : "Library research", scope: prepared.incoming.text.slice(0, 1200), confirmed: true });
    }
    if (name === "record_semantic_notes") {
      await options.beforeNotes?.(signal);
      const context = SemanticContext.parse(lastJSON(input)); noteInputs.push(context);
      const source = context.recent_messages.filter(item => item.role === "user" && !context.notes.some(note => note.evidence.some(evidence => evidence.message_id === item.message_id))).at(-1);
      return metadata(name, { notes: source ? [{ kind: "fact", text: source.content, evidence: [{ message_id: source.message_id, quote: source.content }], supersedes: null, valid_from: null, valid_to: null }] : [] });
    }
    if (tools.length === 0) return response([answer(JSON.stringify({ schema_version: 1, claims: [] }))]);
    return options.main(input, data);
  } };
  const app = createApp(data.sql, { ...(options.structureMode?{semanticStructureMode:options.structureMode}:{}), semanticContexts: { classify: async prepared => {
    const title = prepared.source.content.startsWith("Calendar") ? "Calendar MCP" : "Library research";
    const context = prepared.candidates.find(item => item.title === title);
    return { context_id: context?.context_id ?? null, outcome: context ? "existing" : "new", scores: [], model: "wire-classifier" };
  } } });
  let dropped = false, prepareFailed = false, staleLink = false;
  const server = Bun.serve({ port: 0, fetch: async request => {
    if (options.failPrepareOnce && !prepareFailed && new URL(request.url).pathname.endsWith("/semantic/prepare")) { prepareFailed = true; return globalThis.Response.json({ error: { code: "unavailable" } }, { status: 503 }); }
    if (options.staleLinkOnce && !staleLink && new URL(request.url).pathname.endsWith("/semantic/link")) { staleLink = true; return globalThis.Response.json({ error: { code: "stale_revision" } }, { status: 409 }); }
    const result = await app.fetch(request);
    if (options.dropNotesOnce && !dropped && new URL(request.url).pathname.endsWith("/semantic/notes") && result.ok) { dropped = true; return new globalThis.Response("lost commit response", { status: 503 }); }
    return result;
  } });
  const createRuntime = () => new Runtime({ controlUrl: server.url.href, token: data.token, journal, provider, tools: new ToolExecutor(), artifactRoot: directory });
  const contexts = (runId: string, checkpoint?: SemanticCheckpoint) => new SemanticContexts({ http: ky.create({ prefixUrl: server.url.href, headers: { authorization: `Bearer ${data.token}` }, retry: 0 }), runId, taskId: data.task, provider }, checkpoint);
  const metadataQueue = () => new SemanticMetadataQueue({ jobs: journal.semantic, http: ky.create({ prefixUrl: server.url.href, headers: { authorization: `Bearer ${data.token}` }, retry: 0 }), provider });
  const structureLogs:unknown[]=[];
  const structureQueue=()=>new SemanticStructure({jobs:journal.structure,http:ky.create({prefixUrl:server.url.href,headers:{authorization:`Bearer ${data.token}`},retry:0}),provider,log:record=>structureLogs.push(record)});
  const runtime = createRuntime();
  return { ...data, noteInputs, runtime, createRuntime, contexts, metadataQueue, structureQueue, structureLogs, journal, routes: () => routes, close: async () => { await runtime.stop(); journal.close(); await server.stop(true); await data.sql`UPDATE assistant.credentials SET revoked_at=now() WHERE workspace_id=${data.workspace}`; await data.sql.end(); await rm(directory, { recursive: true, force: true }); } };
}
async function databaseFixture() {
  const sql = createDatabase(process.env["TEST_DATABASE_URL"] ?? "postgres://assistant:assistant@127.0.0.1:55439/semantic_context_1006");
  const workspace = crypto.randomUUID(), vm = crypto.randomUUID(), conversation = crypto.randomUUID(), task = crypto.randomUUID(), token = crypto.randomUUID() + crypto.randomUUID();
  await sql`INSERT INTO assistant.workspaces(id,name) VALUES(${workspace},'semantic-runtime')`;
  await sql`INSERT INTO assistant.vms(id,workspace_id,name) VALUES(${vm},${workspace},'fixture')`;
  await sql`INSERT INTO assistant.credentials(token_hash,workspace_id,role,vm_id) VALUES(${await hashToken(token)},${workspace},'vm',${vm})`;
  await sql`INSERT INTO assistant.conversations(id,workspace_id,title) VALUES(${conversation},${workspace},'feed')`;
  await sql`INSERT INTO assistant.tasks(id,workspace_id,conversation_id,objective,state) VALUES(${task},${workspace},${conversation},'semantic test','queued')`;
  const message = async (content: string, taskId = task) => { const id = crypto.randomUUID(); await sql`INSERT INTO assistant.messages(id,workspace_id,conversation_id,task_id,role,content) VALUES(${id},${workspace},${conversation},${taskId},'user',${content})`; return id; };
  return { sql, workspace, vm, conversation, task, token, message };
}

test("A to B to A preserves generating context and originals across a later run", async () => {
  // Given actual HTTP routes, PostgreSQL, SQLite checkpoints and a deterministic model wire.
  const packets: Array<ReturnType<typeof activePacket>> = [];
  const f = await fixture({ main: async (input, db) => {
    packets.push(activePacket(input));
    if (packets.length === 1) await db.message("Calendar MCP tool implementation");
    if (packets.length === 2) await db.message("Return to library membership and loan eligibility");
    return response([answer(`answer-${packets.length}`)]);
  } });
  try {
    await f.message("Compare library membership and borrowing exceptions");
    // When new subjects arrive during inference and an earlier topic returns in another run.
    await f.runtime.tick(); await f.journal.next.promise; await f.runtime.flush();
    expect(packets).toHaveLength(3);
    for (let pass = 0; pass < 100 && f.journal.semantic.next(Number.MAX_SAFE_INTEGER); pass++) { await f.runtime.tick(); await Bun.sleep(10); }
    expect(f.journal.semantic.next(Number.MAX_SAFE_INTEGER)).toBeNull();
    const originalSourceIds=z.array(z.object({id:z.uuid()})).parse(await f.sql`SELECT id FROM assistant.messages WHERE workspace_id=${f.workspace}`).map(item=>item.id).sort();
    expect([...new Set(f.noteInputs.flatMap(context=>context.recent_messages.map(source=>source.message_id)))].sort()).toEqual(originalSourceIds);
    const next = crypto.randomUUID();
    f.journal.next = Promise.withResolvers<void>();
    await f.sql`INSERT INTO assistant.tasks(id,workspace_id,conversation_id,objective,state) VALUES(${next},${f.workspace},${f.conversation},'return to library research','queued')`;
    await f.message("Explain library borrowing eligibility again", next);
    await f.runtime.tick(); await f.journal.next.promise; await f.runtime.flush();
    // Then replies keep their generating topic and later turns retrieve original evidence.
    expect(packets).toHaveLength(4);
    expect(packets[0]?.context_id).toBe(packets[2]?.context_id);
    expect(packets[0]?.context_id).toBe(packets[3]?.context_id);
    expect(packets[1]?.context_id).not.toBe(packets[0]?.context_id);
    expect(packets[3]?.recent_messages.some(source => source.content === "Compare library membership and borrowing exceptions")).toBe(true);
    expect(packets[3]?.notes.some(note => note.text === "Compare library membership and borrowing exceptions")).toBe(true);
    const replies = await f.sql`SELECT m.content,l.context_id FROM assistant.messages m JOIN assistant.semantic_context_links l ON l.message_id=m.id WHERE m.workspace_id=${f.workspace} AND m.role='assistant' ORDER BY m.sequence`;
    expect(replies.map(row => row["context_id"])).toEqual(packets.map(packet => packet?.context_id));
    expect(f.routes()).toBe(2);
  } finally { await f.close(); }
}, 20000);

test("optional context outage preserves normal inference and indexes its source after completion", async () => {
  // Given context preparation is unavailable when a new user message arrives.
  const packets: Array<ReturnType<typeof activePacket>> = [];
  const f = await fixture({ failPrepareOnce: true, main: async input => { packets.push(activePacket(input)); return response([answer("User request completed")]); } });
  const queue = f.metadataQueue();
  try {
    const source = await f.message("Payment research unavailable context");
    await f.runtime.tick(); await f.journal.next.promise; await f.runtime.flush();
    expect((await f.sql`SELECT state FROM assistant.tasks WHERE id=${f.task}`)[0]?.["state"]).toBe("succeeded");
    expect(packets).toEqual([null]);
    // When the context service becomes available and the durable metadata queue retries.
    await queue.process();
    // Then the original user source is indexed without replaying the completed main inference.
    expect(await f.sql`SELECT context_id FROM assistant.semantic_context_links WHERE message_id=${source}`).toHaveLength(1);
    expect(packets).toHaveLength(1);
    expect(f.journal.semantic.next(Number.MAX_SAFE_INTEGER)).toBeNull();
  } finally { await queue.stop(); await f.close(); }
}, 20000);

test("held background notes do not block the next tool turn or final completion", async () => {
  // Given notes stay unresolved after a flushed commentary and completed tool call.
  const extracting = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let calls = 0;
  const f = await fixture({ main: async () => {
    if (++calls === 1) return response([{ ...answer("Checking the local fixture"), phase: "commentary" }, { type: "function_call", call_id: crypto.randomUUID(), name: "shell", arguments: JSON.stringify({ command: "printf verified" }) }]);
    await extracting.promise;
    return response([answer("Completed while metadata waits")]);
  }, beforeNotes: async () => { extracting.resolve(); await release.promise; } });
  try {
    await f.message("Payment research background notes");
    // When the main tool loop continues while the metadata provider is held.
    await f.runtime.tick(); await extracting.promise;
    const finished = await Promise.race([f.journal.next.promise.then(() => true), Bun.sleep(1000).then(() => false)]);
    // Then the task and two visible replies finish without resolving the metadata call.
    expect(finished).toBe(true);
    expect(calls).toBe(2);
    expect((await f.sql`SELECT state FROM assistant.tasks WHERE id=${f.task}`)[0]?.["state"]).toBe("succeeded");
    expect(await f.sql`SELECT id FROM assistant.messages WHERE workspace_id=${f.workspace} AND role='assistant'`).toHaveLength(2);
  } finally { release.resolve(); await f.close(); }
}, 20000);

test("a transient context revision conflict refreshes before the current foreground answer", async () => {
  // Given a concurrent context update rejects the first source linkage attempt.
  const packets: Array<ReturnType<typeof activePacket>> = [];
  const f = await fixture({ staleLinkOnce: true, main: async input => { packets.push(activePacket(input)); return response([answer("Context-aware answer")]); } });
  try {
    const source = await f.message("Payment research concurrent context");
    // When the current input is prepared for the foreground inference.
    await f.runtime.tick(); await f.journal.next.promise;
    // Then a fresh prepare/link succeeds before the answer instead of deferring its context.
    expect(packets).toHaveLength(1);
    expect(packets[0]).not.toBeNull();
    expect(await f.sql`SELECT context_id FROM assistant.semantic_context_links WHERE message_id=${source}`).toHaveLength(1);
    expect(f.routes()).toBe(2);
  } finally { await f.close(); }
}, 20000);

for (const outage of ["extraction", "commit-response"] as const) test(`metadata ${outage} failure finishes user work and retries notes against the terminal run`, async () => {
  // Given extraction is unavailable when the main answer has already completed.
  let notes = 0, replies = 0;
  const f = await fixture({ main: async () => { replies++; return response([answer("Completed user work")]); }, dropNotesOnce: outage === "commit-response", beforeNotes: async () => { if (++notes === 1 && outage === "extraction") throw new TypeError("fixture metadata unavailable"); } });
  const queue = f.metadataQueue();
  try {
    await f.message("Payment research queue source");
    await f.runtime.tick(); await f.journal.next.promise; await f.runtime.flush();
    expect((await f.sql`SELECT state FROM assistant.tasks WHERE id=${f.task}`)[0]?.["state"]).toBe("succeeded");
    await waitUntil(() => f.journal.semantic.next() === null && f.journal.semantic.next(Number.MAX_SAFE_INTEGER) !== null);
    // When the durable metadata queue retries independently of the finished task.
    await queue.process(Number.MAX_SAFE_INTEGER);
    // Then notes appear without running the assistant again or reopening its task.
    expect(replies).toBe(1);
    expect(notes).toBe(outage === "extraction" ? 2 : 1);
    expect(await f.sql`SELECT id FROM assistant.semantic_context_notes WHERE workspace_id=${f.workspace}`).toHaveLength(1);
    expect(f.journal.semantic.next(Number.MAX_SAFE_INTEGER)).toBeNull();
  } finally { await queue.stop(); await f.close(); }
}, 20000);

test("a lost note commit response retries its durable mutation without a duplicate note", async () => {
  // Given PostgreSQL commits the first notes request but the HTTP response is lost.
  let extractions = 0;
  const f = await fixture({ main: async () => response([answer("unused")]), dropNotesOnce: true, beforeNotes: async () => { extractions++; } });
  try {
    const run = crypto.randomUUID(), id = await f.message("Payment research durable evidence");
    await f.sql`UPDATE assistant.tasks SET state='running' WHERE id=${f.task}`;
    await f.sql`INSERT INTO assistant.runs(id,workspace_id,task_id,vm_id) VALUES(${run},${f.workspace},${f.task},${f.vm})`;
    const controller = f.contexts(run), signal = new AbortController().signal;
    await controller.select(id, signal); controller.delivered(controller.contextId);
    let checkpoint = controller.checkpoint();
    await expect(controller.drain(signal, () => { checkpoint = structuredClone(controller.checkpoint()); })).rejects.toBeInstanceOf(HTTPError);
    // When another coordinator restores the request saved before the first POST.
    const restored = f.contexts(run, checkpoint);
    await restored.drain(signal, () => undefined);
    // Then the same operation receipt is replayed with one extraction and one persisted note.
    expect(extractions).toBe(1);
    expect(await f.sql`SELECT id FROM assistant.semantic_context_notes WHERE workspace_id=${f.workspace}`).toHaveLength(1);
    expect(restored.checkpoint().pending).toEqual([]);
  } finally { await f.close(); }
}, 20000);

test("retention refusal clears prior context and stores neither link nor notes", async () => {
  // Given an established context followed by explicitly non-retained input.
  const packets: Array<ReturnType<typeof activePacket>> = [];
  const f = await fixture({ main: async (input, db) => {
    packets.push(activePacket(input));
    if (packets.length === 1) {
      const id = await db.message("Do not remember this: private temporary detail");
      await db.sql`INSERT INTO assistant.memory_retention_decisions(workspace_id,task_id,source_message_id,action,quote) VALUES(${db.workspace},${db.task},${id},'deny_turn','Do not remember this')`;
    }
    return response([answer(`answer-${packets.length}`)]);
  } });
  try {
    await f.message("Payment research initial");
    // When the non-retained message is applied within the active run.
    await f.runtime.tick(); await f.journal.next.promise; await f.runtime.flush();
    // Then the following answer has no inherited semantic association.
    expect(packets).toHaveLength(2);
    expect(packets[1]).toBeNull();
    const links = await f.sql`SELECT m.content FROM assistant.semantic_context_links l JOIN assistant.messages m ON m.id=l.message_id WHERE l.workspace_id=${f.workspace}`;
    expect(links.some(row => row["content"] === "Do not remember this: private temporary detail" || row["content"] === "answer-2")).toBe(false);
  } finally { await f.close(); }
}, 20000);

test("restart during background note extraction completes metadata without replaying a delivered final reply", async () => {
  // Given a final reply has been flushed and its note extraction is interrupted.
  const extracting = Promise.withResolvers<void>();
  let mainCalls = 0, noteCalls = 0;
  const f = await fixture({ main: async () => { mainCalls++; return response([answer("One delivered final")]); }, beforeNotes: async signal => {
    if (++noteCalls !== 1) return;
    extracting.resolve();
    await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  } });
  let resumed: Runtime | undefined;
  try {
    await f.message("Payment research checkpoint source");
    await f.runtime.tick(); await extracting.promise; await f.runtime.stop();
    // When the durable checkpoint is recovered in a fresh runtime instance.
    resumed = f.createRuntime(); await resumed.recover(); await f.journal.next.promise; await resumed.flush();
    const queue = f.metadataQueue();
    try { await queue.process(Number.MAX_SAFE_INTEGER); } finally { await queue.stop(); }
    // Then metadata is stored, the task succeeds and the original reply is not generated again.
    expect(mainCalls).toBe(1);
    const replies = await f.sql`SELECT content FROM assistant.messages WHERE workspace_id=${f.workspace} AND role='assistant'`;
    expect(replies.map(row => row["content"])).toEqual(["One delivered final"]);
    expect(await f.sql`SELECT id FROM assistant.semantic_context_notes WHERE workspace_id=${f.workspace}`).toHaveLength(1);
    expect((await f.sql`SELECT state FROM assistant.tasks WHERE id=${f.task}`)[0]?.["state"]).toBe("succeeded");
  } finally { await resumed?.stop(); await f.close(); }
}, 20000);

test("malformed routing creates a provisional context instead of silently choosing a topic", async () => {
  // Given a metadata response that cannot be parsed as a routing decision.
  const f = await fixture({ malformedRoute: true, main: async () => response([answer("done")]) });
  try {
    await f.message("Uncertain new subject");
    // When the runtime prepares this source.
    await f.runtime.tick(); await f.journal.next.promise; await f.runtime.flush();
    // Then durable source linkage explicitly remains provisional.
    const rows = await f.sql`SELECT l.status FROM assistant.semantic_context_links l JOIN assistant.messages m ON m.id=l.message_id WHERE l.workspace_id=${f.workspace} AND m.role='user'`;
    expect(rows.map(row => row["status"])).toEqual(["provisional"]);
  } finally { await f.close(); }
}, 20000);
test('fresh extraction receives the persisted user and assistant IDs once, including after later replies',async()=>{
 const f=await fixture({main:async()=>response([answer('Fresh persisted assistant outcome')])});
 try{
  const user=await f.message('Payment research fresh user decision');await f.runtime.tick();await f.journal.next.promise;await f.runtime.flush();
  await waitUntil(()=>f.noteInputs.length>0&&f.journal.semantic.next(Number.MAX_SAFE_INTEGER)===null);
  const rows=z.array(z.object({id:z.uuid(),role:z.string()})).parse(await f.sql`SELECT id,role FROM assistant.messages WHERE workspace_id=${f.workspace} ORDER BY sequence`);
  expect(rows).toHaveLength(2);expect(rows[0]?.id).toBe(user);expect(f.noteInputs.flatMap(context=>context.recent_messages.map(source=>source.message_id))).toEqual(rows.map(row=>row.id));
  const events=z.array(z.object({payload:z.object({message_id:z.uuid()})})).parse(await f.sql`SELECT payload FROM assistant.events WHERE workspace_id=${f.workspace} AND kind='message'`);
  expect(events[0]?.payload.message_id).toBe(rows[1]?.id);
 }finally{await f.close();}
});
test('an old nonsemantic execution checkpoint replays deterministic commentary without adding a new message ID',async()=>{
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let calls=0;
 const text='Legacy deterministic commentary';
 const f=await fixture({main:async()=>{if(++calls===1){entered.resolve();await release.promise;throw new TypeError('fixture interrupted provider');}return response([{...answer(text),phase:'commentary'},answer('Recovered final')]);}});let resumed:Runtime|undefined;
 try{
  await f.message('Payment research old checkpoint');await f.runtime.tick();await entered.promise;
  const run=f.journal.interrupted()[0];if(!run)throw new TypeError('No running fixture');const saved=f.journal.recoverable(run);if(!saved)throw new TypeError('No recoverable fixture checkpoint');
  const stopping=f.runtime.stop();release.resolve();await stopping;
   const {semanticContext:_semantic,appliedUserIds:_attribution,...legacy}=saved;f.journal.checkpoint(legacy);f.journal.suspend(run);
  const digest=new Bun.CryptoHasher('sha256').update(JSON.stringify([run,'commentary',text])).digest('hex'),event_id=`${digest.slice(0,8)}-${digest.slice(8,12)}-8${digest.slice(13,16)}-a${digest.slice(17,20)}-${digest.slice(20,32)}`;
  const {DaemonEvent}=await import('../packages/protocol/index.ts'),{applyEvent}=await import('../services/control/repository/daemon-events.ts');
  const prior=DaemonEvent.parse({kind:'message',event_id,run_id:run,content:text,phase:'commentary'});
  await f.sql.begin(tx=>applyEvent(tx,{workspace_id:f.workspace,vm_id:f.vm,role:'vm'},prior));
  resumed=f.createRuntime();await resumed.recover();await f.journal.next.promise;await resumed.flush();
  const stored=z.object({payload:z.unknown()}).parse((await f.sql`SELECT payload FROM assistant.events WHERE event_id=${event_id}`)[0]);expect(stored.payload).toEqual(prior);
  expect(await f.sql`SELECT id FROM assistant.messages WHERE workspace_id=${f.workspace} AND content=${text}`).toHaveLength(1);
  expect((await f.sql`SELECT state FROM assistant.tasks WHERE id=${f.task}`)[0]?.['state']).toBe('succeeded');expect(calls).toBe(2);
 }finally{release.resolve();await resumed?.stop();await f.close();}
},20000);
test('runtime recovery appends revalidated authority after saved reference packets without rewriting prior input',async()=>{
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let calls=0;const observed:ResponseInputItem[][]=[];
 const f=await fixture({main:async input=>{observed.push(structuredClone(input));if(++calls===1){entered.resolve();await release.promise;throw new TypeError('fixture interrupted before reply');}return response([answer('Recovered without revoked reference')]);}});let resumed:Runtime|undefined;
 try{
  const id=await f.message('Payment research reference to revoke');await f.runtime.tick();await entered.promise;
  const run=f.journal.interrupted()[0];if(!run)throw new TypeError('Missing running fixture');const saved=f.journal.recoverable(run);if(!saved?.semanticContext?.reference)throw new TypeError('Missing durable reference');
  const prior=saved.input.filter(item=>'content'in item&&typeof item.content==='string'&&item.content.startsWith('{"kind":"semantic_context_reference"'));
  expect(prior).toHaveLength(1);expect(activePacket(observed[0]??[])?.context_id??null).toBe(saved.semanticContext.reference.primary_context_id);
  const stopping=f.runtime.stop();release.resolve();await stopping;
  await f.sql`UPDATE assistant.memory_retention_decisions SET action='deny_turn',quote='Payment research reference to revoke' WHERE workspace_id=${f.workspace} AND source_message_id=${id}`;
  f.journal.checkpoint(saved);f.journal.suspend(run);resumed=f.createRuntime();await resumed.recover();await f.journal.next.promise;await resumed.flush();
  const resumedInput=observed[1];if(!resumedInput)throw new TypeError('Missing resumed provider input');
  expect(activePacket(resumedInput)).toBeNull();
  const references=resumedInput.filter(item=>'content'in item&&typeof item.content==='string'&&item.content.startsWith('{"kind":"semantic_context_reference"'));
  expect(references.slice(0,1)).toEqual(prior);expect(references.length).toBe(2);expect(calls).toBe(2);
 }finally{release.resolve();await resumed?.stop();await f.close();}
},20000);
