import { expect, spyOn, test } from "bun:test";
import ky from "ky";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Journal } from "../services/daemon/journal";
import { MemoryQueue } from "../services/daemon/memory";
import { inputHash, ExtractionRequest } from "../packages/memory/schema";
import { memoryProviderFixture } from "./memory-provider-fixture";
class ObservedJournal extends Journal {
  readonly settled = Promise.withResolvers<"finished"|"retry">();
  readonly payloads: string[] = [];
  override queueMemory(run:string,payload:string) { super.queueMemory(run,payload); this.payloads.push(payload); }
  override finishMemory(run:string) { super.finishMemory(run); this.settled.resolve("finished"); }
  override retryMemory(run:string) { super.retryMemory(run); this.settled.resolve("retry"); }
}
async function scenario(mode:"old_server"|"legacy_cache"|"denied_cache"|"stale_cache") {
  const directory = await mkdtemp(join(tmpdir(),"retention-queue-"));
  const run = crypto.randomUUID(), task = crypto.randomUUID(), conversation = crypto.randomUUID();
  const user = {id:crypto.randomUUID(),role:"user" as const,task_id:task,conversation_id:conversation,content:"Do not remember this task. I prefer Rust.",created_at:"2026-10-04T00:00:00Z",sequence:1,client_message_id:null};
  const decision = {source_message_id:user.id,action:"deny_task" as const,quote:"Do not remember this task."};
  const request = {run_id:run,derivation_id:crypto.randomUUID(),input_hash:await inputHash([user]),source_ids:[user.id],extraction:{schema_version:1 as const,claims:[{kind:"assertion" as const,context:"task",entity:"user",predicate:"preference" as const,text:"User prefers Rust",epistemic_status:"reported" as const,value:"Rust",unit:null,valid_from:null,valid_to:null,time_precision:"unknown" as const,evidence:{source_message_id:user.id,quote:"I prefer Rust."},supersedes_id:null,correction:false,due_at:null,due_timezone:null}]}};
  const posts: ExtractionRequest[] = []; let providerCalls = 0;
  const server = Bun.serve({port:0,fetch:async request => {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/memory")) { posts.push(ExtractionRequest.parse(await request.json())); return Response.json({accepted:true,count:0}); }
    const added = {...user,id:crypto.randomUUID(),sequence:2,content:"Now remember only this later preference."};
    return Response.json({messages:[user],memory:[],next_after_sequence:null,...(mode === "old_server" ? {} : {retention_context:{sources:mode === "stale_cache" ? [user,added] : [user],decisions:[decision]}})});
  }});
  const journal = new ObservedJournal(join(directory,"journal.sqlite"));
  const provider = memoryProviderFixture({schema_version:1,claims:[],retention_decisions:[decision]},()=>{providerCalls++;});
  const queue = new MemoryQueue({journal,provider,http:ky.create({prefixUrl:server.url.href,retry:0})});
  try {
    const retention = {input_hash:await inputHash([user]),decisions:[decision]};
    journal.queueMemory(run,JSON.stringify(mode === "old_server" ? {kind:"pending",derivation_id:request.derivation_id} : {kind:"extracted",request:mode === "legacy_cache" ? request : {...request,retention},next_after_sequence:null}));
    journal.payloads.length=0;
    queue.tick(); const outcome = await journal.settled.promise; await queue.stop();
    return {outcome,posts,providerCalls,checkpoint:journal.payloads.at(-1) ? z.object({kind:z.string()}).parse(JSON.parse(journal.payloads.at(-1) ?? "null")).kind : null};
  } finally { await queue.stop(); journal.close(); await server.stop(true); await rm(directory,{recursive:true,force:true}); }
}
test("new daemon leaves memory pending against an old server without authoritative policy context", async () => {
  // Given an old context wire contract. When the real SQLite queue ticks through HTTP.
  const log = spyOn(console,"warn").mockImplementation(()=>undefined);
  try {
    const result = await scenario("old_server");
    // Then it retries without model calls or posts, emitting only allowlisted redacted diagnostics.
    expect(result).toEqual({outcome:"retry",posts:[],providerCalls:0,checkpoint:null});
    expect(log).toHaveBeenCalledTimes(1);
    const record = z.object({event:z.literal("daemon.memory.retention_retry"),run_id:z.uuid(),code:z.literal("retention_context_unsupported")}).strict().parse(JSON.parse(String(log.mock.calls[0]?.[0])));
    expect(record.code).toBe("retention_context_unsupported");
  } finally { log.mockRestore(); }
});
test("legacy extracted jobs are reclassified instead of posting cached unprotected facts", async () => {
  // Given a cached pre-upgrade payload. When recovered by the actual queue.
  const result = await scenario("legacy_cache");
  // Then the durable job resets to pending before any write.
  expect(result).toEqual({outcome:"retry",posts:[],providerCalls:0,checkpoint:"pending"});
});
test("cached denied claims are removed without another model call", async () => {
  // Given a cached policy and tempting claim. When recovered through HTTP.
  const result = await scenario("denied_cache");
  // Then the posted request contains policy but no claim.
  expect(result.outcome).toBe("finished"); expect(result.providerCalls).toBe(0);
  expect(result.posts).toHaveLength(1); expect(result.posts[0]?.extraction.claims).toEqual([]);
});
test("a stale cached policy restarts extraction without posting its prior claims", async () => {
  // Given a cached policy whose authoritative user snapshot has changed. When the queue resumes.
  const result = await scenario("stale_cache");
  // Then fresh classification is pending and the stale request never reaches persistence.
  expect(result).toEqual({outcome:"retry",posts:[],providerCalls:0,checkpoint:"pending"});
});
