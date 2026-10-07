import { test, expect } from "bun:test";
import { Runtime, type RuntimeTiming } from "../services/daemon/runtime.ts";
import { Journal } from "../services/daemon/journal.ts";
import { ToolExecutor } from "../services/daemon/tools.ts";
import { DaemonEvent, type Assignment, type Command } from "../packages/protocol/index.ts";
import type { Provider } from "../packages/provider/index.ts";

test("takeover ACK follows provider abort and persists ownership", async () => {
  // Given: real HTTP control seam, a pending provider operation, and real SQLite.
  const timings:RuntimeTiming[]=[];
  const polls:URL[]=[];
  const events: Array<ReturnType<typeof DaemonEvent.parse>> = [];
  const providerStarted = Promise.withResolvers<void>();
  let providerStopped = false;
  let assigned = false;
  let command: Command | undefined;
  const assignment: Assignment = { run_id: crypto.randomUUID(), task: { id: crypto.randomUUID(), conversation_id: crypto.randomUUID(), objective: "fixture", state: "running", reason: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }, messages: [], instructions: "", memory: [] };
  const provider: Provider = { respond: async (_input, _tools, signal) => {
    providerStarted.resolve();
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => { providerStopped = true; reject(new DOMException("aborted", "AbortError")); }, { once: true }));
  } };
  const server = Bun.serve({ port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/v1/daemon/poll") {
      polls.push(url);
      const next = assigned ? null : assignment; assigned = true;
      return Response.json({ assignment: next, commands: command ? [command] : [], messages: [] });
    }
    if (url.pathname === "/v1/daemon/events") { events.push(DaemonEvent.parse(await request.json())); return Response.json({ ok: true }); }
    return Response.json({ messages: [], instructions: "", memory: [] });
  } });
  const journal = new Journal(":memory:");
  const runtime = new Runtime({ controlUrl: server.url.href, token: "fixture", journal, provider, tools: new ToolExecutor(), onTiming:event=>timings.push(event) });
  await runtime.tick(); await providerStarted.promise;
  command = { id: crypto.randomUUID(), task_id: null, kind: "takeover", created_at: new Date().toISOString() };
  // When
  await runtime.tick();
  // Then
  try {
    expect(providerStopped).toBe(true);
    expect(polls.map(url=>[url.searchParams.get("run_id"),url.searchParams.get("view")])).toEqual([[null,"work"],[assignment.run_id,"commands"]]);
    expect(timings).toHaveLength(1);
    expect(timings[0]).toMatchObject({kind:"provider",run_id:assignment.run_id,outcome:"failed"});
    expect(timings[0]?.duration_ms).toBeGreaterThanOrEqual(0);
    expect(Object.keys(timings[0]??{}).sort()).toEqual(["duration_ms","input_image_count","kind","outcome","run_id"]);
    expect(journal.control()).toBe("user");
    expect(events.filter(e => e.kind === "command_ack").map(e => [e.status, "resume_safe" in e ? e.resume_safe : undefined])).toEqual([["applied", true]]);
    expect(events.filter(e => e.kind === "state").map(e => e.state)).toEqual([]);
  } finally { await runtime.stop(); journal.close(); await server.stop(true); }
});

test("own persisted assistant reply does not trigger another model turn", async () => {
  // Given an actual HTTP mailbox that contains the assistant message emitted by this run.
  const completed = Promise.withResolvers<void>();
  const events: Array<ReturnType<typeof DaemonEvent.parse>> = [];
  const messages: Array<{ id: string; conversation_id: string; role: "assistant"; content: string; sequence: number; created_at: string; client_message_id: null }> = [];
  const assignment: Assignment = { run_id: crypto.randomUUID(), task: { id: crypto.randomUUID(), conversation_id: crypto.randomUUID(), objective: "fixture", state: "running", reason: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }, messages: [], instructions: "", memory: [] };
  let calls = 0, assigned = false;
  const provider: Provider = { respond: async () => {
    calls++;
    return { id: "fixture", created_at: 0, output_text: "Done", error: null, incomplete_details: null, instructions: null, metadata: null, model: "fixture", object: "response", output: [{ id: "message", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Done", annotations: [] }] }], parallel_tool_calls: false, temperature: null, tool_choice: "auto", tools: [], top_p: null, status: "completed" };
  } };
  const server = Bun.serve({ port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/v1/daemon/poll") { const value = assigned ? null : assignment; assigned = true; return Response.json({ assignment: value, commands: [], messages: [] }); }
    if (url.pathname === "/v1/daemon/events") {
      const event = DaemonEvent.parse(await request.json()); events.push(event);
      if (event.kind === "message") messages.push({ id: crypto.randomUUID(), conversation_id: assignment.task.conversation_id, role: "assistant", content: event.content, sequence: messages.length + 1, created_at: new Date().toISOString(), client_message_id: null });
      if (event.kind === "state" && event.state === "succeeded") completed.resolve();
      return Response.json({ accepted: true });
    }
    return Response.json({ messages: messages.filter(m => m.sequence > Number(url.searchParams.get("after") ?? 0)), memory: [], instructions: "" });
  } });
  const journal = new Journal(":memory:");
  const runtime = new Runtime({ controlUrl: server.url.href, token: "fixture", journal, provider, tools: new ToolExecutor() });
  // When
  await runtime.tick(); await completed.promise;
  // Then
  try { expect(calls).toBe(1); expect(events.some(e => e.kind === "state" && e.state === "succeeded")).toBe(true); }
  finally { await runtime.stop(); journal.close(); await server.stop(true); }
});

test("control disconnection quarantines active work and reconnects without replay", async () => {
  // Given a running provider operation on a real HTTP control connection.
  const started = Promise.withResolvers<void>();
  let assigned = false, unavailable = false, calls = 0;
  const events: Array<ReturnType<typeof DaemonEvent.parse>> = [];
  const assignment: Assignment = { run_id: crypto.randomUUID(), task: { id: crypto.randomUUID(), conversation_id: crypto.randomUUID(), objective: "fixture", state: "running", reason: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }, messages: [], instructions: "", memory: [] };
  const provider: Provider = { respond: async (_input, _tools, signal) => { calls++; started.resolve(); return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })); } };
  const server = Bun.serve({ port: 0, async fetch(request) {
    if (unavailable) return new Response("unavailable", { status: 503 });
    if (new URL(request.url).pathname === "/v1/daemon/poll") { const next = assigned ? null : assignment; assigned = true; return Response.json({ assignment: next, commands: [], messages: [] }); }
    if (new URL(request.url).pathname === "/v1/daemon/events" && request.method === "POST") { events.push(DaemonEvent.parse(await request.json())); return Response.json({ accepted: true }); }
    if (request.method === "POST") return new Response("Not found", { status: 404 });
    return Response.json({ messages: [], memory: [], instructions: "" });
  } });
  const journal = new Journal(":memory:");
  const runtime = new Runtime({ controlUrl: server.url.href, token: "fixture", journal, provider, tools: new ToolExecutor() });
  await runtime.tick(); await started.promise; unavailable = true;
  // When the connection fails, active work is interrupted; reconnect flushes its uncertainty.
  await expect(runtime.tick()).rejects.toThrow(); await runtime.disconnect(); unavailable = false; await runtime.tick();
  // Then
  try { expect(calls).toBe(1); expect(events.filter(e => e.kind === "state").map(e => e.state)).toEqual(["unknown"]); }
  finally { await runtime.stop(); journal.close(); await server.stop(true); }
});

for(const fail of [false,true])test(`recovery input barrier precedes event delivery and fails closed; failure=${fail}`,async()=>{
 let delivered=0;const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
 const server=Bun.serve({port:0,fetch(){delivered++;return Response.json({accepted:true});}}),journal=new Journal(':memory:');
 journal.setControl('user');journal.start(crypto.randomUUID());
 const runtime=new Runtime({controlUrl:server.url.href,token:'fixture',journal,tools:new ToolExecutor(),provider:{respond:async()=>{throw new TypeError('No provider during recovery');}},inputBarrier:async()=>{entered.resolve();await release.promise;if(fail)throw new TypeError('fixture input release failed');}});
 try{
  const recovering=runtime.recover();await entered.promise;expect(delivered).toBe(0);release.resolve();
  if(fail){await expect(recovering).rejects.toThrow('fixture input release failed');expect(journal.control()).toBe('agent');expect(delivered).toBe(0);}
  else{await recovering;expect(delivered).toBe(1);expect(journal.control()).toBe('user');}
 }finally{release.resolve();await runtime.stop();journal.close();await server.stop(true);}
});
