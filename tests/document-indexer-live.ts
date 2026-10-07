import assert from "node:assert/strict";
import { chmod, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import ky from "ky";
import { z } from "zod";
import { LocalArtifactStore } from "../packages/artifacts/local-store.ts";
import { WorkSearchPage } from "../packages/protocol/work-search.ts";
import { createApp } from "../services/control/app.ts";
import { hashToken } from "../services/control/auth.ts";
import { createDatabase } from "../services/control/db.ts";

const directory = resolve(z.string().min(1).parse(process.argv[2]));
const database = process.env["TEST_DATABASE_URL"] ?? "postgres://assistant:assistant@127.0.0.1:55439/assistant_dev";
if (!["localhost","127.0.0.1"].includes(new URL(database).hostname)) throw new Error("Disposable local database required");
await mkdir(directory,{recursive:true,mode:0o700});
const sql = createDatabase(database);
const workspace = crypto.randomUUID(), conversation = crypto.randomUUID(), vm = crypto.randomUUID();
const client = crypto.randomUUID()+crypto.randomUUID(), token = crypto.randomUUID()+crypto.randomUUID();
const app = createApp(sql,{artifactStore:new LocalArtifactStore(join(directory,"objects"))});
let busyObserved = false;
const exercisePreemption = process.env["DOCUMENT_LIVE_PREEMPT"] === "1";
let delayedDownload = false, preemptionObserved = false, downloadCancelled = false;
const observations: {readonly path:string;readonly status:number}[] = [];
await sql`INSERT INTO assistant.workspaces(id,name) VALUES(${workspace},'document-live-synthetic')`;
await sql`INSERT INTO assistant.conversations(id,workspace_id,title) VALUES(${conversation},${workspace},'synthetic-documents')`;
await sql`INSERT INTO assistant.vms(id,workspace_id,name,control_state,last_seen_at) VALUES(${vm},${workspace},'synthetic-document-vm','user',now())`;
await sql`INSERT INTO assistant.credentials(token_hash,workspace_id,role,vm_id) VALUES(${await hashToken(client)},${workspace},'client',NULL),(${await hashToken(token)},${workspace},'vm',${vm})`;
const server = Bun.serve({hostname:"127.0.0.1",port:0,fetch:async request => {
  const response = await app.fetch(request);
  const path = new URL(request.url).pathname;
  if (path.includes("/artifact-index/")) observations.push({path,status:response.status});
  if (path.endsWith("/artifact-index/claim") && !busyObserved) {
    assert.deepEqual(await response.clone().json(),{job:null});
    busyObserved = true;
    await sql`UPDATE assistant.vms SET control_state='agent' WHERE id=${vm}`;
  }
  if (exercisePreemption && path.includes("/artifact-index/") && path.endsWith("/content") && response.ok && !delayedDownload) {
    delayedDownload = true;
    await sql`UPDATE assistant.vms SET control_state='user' WHERE id=${vm}`;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(Uint8Array.of(37)); },
      async cancel() { downloadCancelled = true; await response.body?.cancel(); },
    }),{headers:response.headers});
  }
  if (exercisePreemption && path.endsWith("/lease") && response.ok && !preemptionObserved) {
    const renewal = z.object({continue:z.boolean()}).parse(await response.clone().json());
    assert.equal(renewal.continue,false);
    const job = z.object({status:z.string(),failures:z.number()}).parse((await sql`SELECT status,failures FROM assistant.artifact_search_jobs WHERE workspace_id=${workspace} AND outcome='foreground'`)[0]);
    assert.deepEqual(job,{status:"pending",failures:0});
    preemptionObserved = true;
    await sql`UPDATE assistant.vms SET control_state='agent' WHERE id=${vm}`;
  }
  return response;
}});
const http = ky.create({prefixUrl:`http://127.0.0.1:${server.port}`,headers:{Authorization:`Bearer ${client}`},retry:0});
const good = crypto.randomUUID(), bad = crypto.randomUUID();
const goodBytes = new Uint8Array(await Bun.file("tests/fixtures/documents/ordinary.pdf").arrayBuffer());
const badBytes = new TextEncoder().encode("%PDF-1.7\nsynthetic malformed");
const stop = new AbortController();
process.once("SIGTERM",()=>stop.abort());
process.once("SIGINT",()=>stop.abort());
const heartbeat = setInterval(() => {
  void sql`UPDATE assistant.vms SET last_seen_at=now() WHERE id=${vm}`.catch(error => { stop.abort(); if (!(error instanceof Error)) throw error; });
},5000);
try {
  for (const [id,bytes] of [[good,goodBytes],[bad,badBytes]] as const) {
    await http.post(`v1/conversations/${conversation}/artifacts`,{body:new Blob([bytes]),headers:{"X-Artifact-Id":id,"X-Artifact-Name":"document.pdf","Content-Type":"application/pdf"}});
    await http.post(`v1/conversations/${conversation}/messages`,{json:{client_message_id:crypto.randomUUID(),content:"",attachment_ids:[id]}});
    await sql`UPDATE assistant.tasks SET state='succeeded' WHERE workspace_id=${workspace}`;
  }
  const search = {query:"BODYONLYPDFTOKEN",cursor:null,conversation_id:null,state:"all",limit:10};
  const before = WorkSearchPage.parse(await http.post("v1/search",{json:search}).json());
  assert.equal(before.pending_document_files,2); assert.equal(before.hits.length,0);
  const receipt = join(directory,"connection.json");
  await Bun.write(receipt,JSON.stringify({control_url:`http://127.0.0.1:${server.port}`,vm_token:token,workspace_id:workspace,vm_id:vm}));
  await chmod(receipt,0o600);
  console.log(JSON.stringify({event:"document_live.ready",port:server.port,credential_file:receipt}));
  const deadline = Date.now()+180000;
  while (!stop.signal.aborted && Date.now()<deadline) {
    const count = z.object({count:z.coerce.number()}).parse((await sql`SELECT count(*) FROM assistant.artifact_search_jobs WHERE workspace_id=${workspace} AND status='done'`)[0]).count;
    if (count===2) break;
    await delay(250);
  }
  const after = WorkSearchPage.parse(await http.post("v1/search",{json:search}).json());
  assert.equal(busyObserved,true); assert.equal(after.pending_document_files,0); assert.equal(after.failed_document_files,1);
  if (exercisePreemption) { assert.equal(preemptionObserved,true); assert.equal(downloadCancelled,true); }
  assert.equal(after.hits.length,1); assert.equal(after.hits[0]?.id,good); assert.match(after.hits[0]?.snippet ?? "",/BODYONLYPDFTOKEN/);
  for (const [id,bytes] of [[good,goodBytes],[bad,badBytes]] as const) {
    assert.deepEqual(new Uint8Array(await http.get(`v1/artifacts/${id}/content`).arrayBuffer()),bytes);
  }
  const jobs = await sql`SELECT artifact_id,status,outcome,failures FROM assistant.artifact_search_jobs WHERE workspace_id=${workspace} ORDER BY artifact_id`;
  await Bun.write(join(directory,"result.json"),JSON.stringify({passed:true,busy_claim_blocked:busyObserved,renewal_preempted:preemptionObserved,download_cancelled:downloadCancelled,before,after,jobs,requests:observations,original_sha256:new Bun.CryptoHasher("sha256").update(goodBytes).digest("hex")},null,2));
  console.log(JSON.stringify({event:"document_live.pass",artifact:join(directory,"result.json")}));
} finally {
  clearInterval(heartbeat); server.stop(true);
  await rm(join(directory,"connection.json"),{force:true});
  await sql.begin(async tx => {
    await tx`DELETE FROM assistant.artifact_search_jobs WHERE workspace_id=${workspace}`;
    await tx`DELETE FROM assistant.message_artifacts WHERE workspace_id=${workspace}`;
    await tx`DELETE FROM assistant.outbox WHERE workspace_id=${workspace}`;
    await tx`DELETE FROM assistant.events WHERE workspace_id=${workspace}`;
    await tx`DELETE FROM assistant.messages WHERE workspace_id=${workspace}`;
    await tx`DELETE FROM assistant.tasks WHERE workspace_id=${workspace}`;
    await tx`DELETE FROM assistant.artifacts WHERE workspace_id=${workspace}`;
    await tx`DELETE FROM assistant.credentials WHERE workspace_id=${workspace}`;
    await tx`DELETE FROM assistant.vms WHERE workspace_id=${workspace}`;
    await tx`DELETE FROM assistant.conversations WHERE workspace_id=${workspace}`;
    await tx`DELETE FROM assistant.workspaces WHERE id=${workspace}`;
  });
  await sql.end();
  await rm(join(directory,"objects"),{recursive:true,force:true});
}
