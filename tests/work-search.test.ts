import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import ky from "ky";
import { controlFixture } from "./control-fixture.ts";
import { createApp } from "../services/control/app.ts";
import { LocalArtifactStore } from "../packages/artifacts/local-store.ts";
import { Artifact } from "../packages/protocol/index.ts";
import { WorkSearchPage } from "../packages/protocol/work-search.ts";
import { TaskArtifacts } from "../services/daemon/artifacts.ts";
import { runWorkSearch } from "../services/daemon/work-search.ts";

const f=controlFixture(),dir=await mkdtemp(join(tmpdir(),"work-search-"));
const app=createApp(f.sql,{artifactStore:new LocalArtifactStore(join(dir,"store"))});
const server=Bun.serve({port:0,fetch:app.fetch});
afterAll(async()=>{server.stop(true);await rm(dir,{recursive:true,force:true});});
async function search(query:string,extra:Record<string,unknown>={},token=f.client){
  const response=await app.request('/v1/search',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({query,cursor:null,conversation_id:null,state:'all',limit:10,...extra})});
  expect(response.status).toBe(200);return WorkSearchPage.parse(await response.json());
}
async function uploadedSource(content:string | Uint8Array,name='prior-report.txt',mediaType='text/plain'){
  const prior=await f.newTask();await f.finishActive();
  const response=await app.request(`/v1/conversations/${prior.task.conversation_id}/artifacts`,{method:'POST',headers:{Authorization:`Bearer ${f.client}`,'X-Artifact-Id':crypto.randomUUID(),'X-Artifact-Name':name,'Content-Type':mediaType},body:typeof content==='string'?content:new Blob([new Uint8Array(content)])});
  expect(response.status).toBe(201);const artifact=Artifact.parse((await response.json()).artifact);
  await f.sql`INSERT INTO assistant.message_artifacts(workspace_id,conversation_id,message_id,artifact_id,position) VALUES(${f.workspace},${prior.task.conversation_id},${prior.message.id},${artifact.id},0)`;
  return {...prior,artifact};
}
async function activeRun(){
  const current=await f.newTask(),run=crypto.randomUUID();
  await f.sql`UPDATE assistant.tasks SET state='running' WHERE id=${current.task.id}`;
  await f.sql`INSERT INTO assistant.runs(id,workspace_id,task_id,vm_id,state) VALUES(${run},${f.workspace},${current.task.id},${f.vm},'running')`;
  return {run,current};
}

test('body and file-content search returns original source anchors and excludes another workspace',async()=>{
  // Given phrase only in a file body and a separate source message body, with an alien duplicate.
  const file=await uploadedSource('source-only-orchid evidence bytes');
  await f.sql`UPDATE assistant.messages SET content='body-only-cobalt with verified source' WHERE id=${file.message.id}`;
  const alienConversation=crypto.randomUUID();
  await f.sql`INSERT INTO assistant.conversations(id,workspace_id,title) VALUES(${alienConversation},${f.alien},'alien')`;
  await f.sql`INSERT INTO assistant.messages(workspace_id,conversation_id,role,content) VALUES(${f.alien},${alienConversation},'user','source-only-orchid body-only-cobalt')`;
  // When actual API searches match contents absent from the task objective.
  const body=await search('body-only-cobalt'),files=await search('source-only-orchid');
  // Then anchored original IDs and plain snippets identify only owned records.
  expect(body.hits.map(hit=>hit.source_message_id)).toEqual([file.message.id]);
  expect(files.hits).toHaveLength(1);expect(files.hits[0]?.artifact?.id).toBe(file.artifact.id);
  expect(files.hits[0]?.snippet).toContain('source-only-orchid');
  expect((await search('source-only-orchid',{},f.alienToken)).hits).toHaveLength(1);
});

test('PNG and PDF prior reuse returns bounded paths without encoded binary in tool text',async()=>{
  // Given real raster and PDF byte streams in owned historical attachments.
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5XcAAAAASUVORK5CYII=','base64');
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] >>'];
  let pdf='%PDF-1.4\n';const offsets=[0];
  for(const [index,object] of objects.entries()){offsets.push(Buffer.byteLength(pdf));pdf+=`${index+1} 0 obj\n${object}\nendobj\n`;}
  const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 4\n0000000000 65535 f \n${offsets.slice(1).map(offset=>String(offset).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const sources=[await uploadedSource(png,'prior.png','image/png'),await uploadedSource(pdf,'prior.pdf','application/pdf')];
  const {run,current}=await activeRun(),http=ky.create({prefixUrl:server.url.href,headers:{Authorization:`Bearer ${f.machine}`},retry:0});
  const artifacts=await TaskArtifacts.create({http,runId:run,conversationId:current.task.conversation_id,root:join(dir,'runs')});
  // When the actual model tool retrieves each source into this separate run.
  for(const source of sources){
    const result=await runWorkSearch(http,{runId:run,artifacts},{name:'read_prior_source',args:JSON.stringify({source_message_id:source.message.id}),signal:AbortSignal.timeout(5000)});
    // Then only source text, metadata and a usable path cross the tool boundary.
    expect(result.length).toBeLessThan(3000);expect(result).not.toContain('base64');expect(result).not.toContain('file_data');expect(result).not.toContain('input_image');
    const extension=source.artifact.media_type==='image/png'?'.png':'.pdf';
    const local=join(artifacts.directory,'inputs',source.artifact.id+extension);expect(result).toContain(local);
    const bytes=await Bun.file(local).arrayBuffer();expect(new Bun.CryptoHasher('sha256').update(bytes).digest('hex')).toBe(source.artifact.sha256);
  }
});

test('literal metacharacters do not expand and keyset pagination retains submillisecond records',async()=>{
  // Given records separated by microseconds within one millisecond.
  const prior=await f.newTask();await f.finishActive();
  for(let i=0;i<5;i++)await f.sql`INSERT INTO assistant.messages(workspace_id,conversation_id,task_id,role,content,created_at) VALUES(${f.workspace},${prior.task.conversation_id},${prior.task.id},'assistant',${'paging%_needle '+i},'2026-01-01T00:00:00Z'::timestamptz+${i}*interval '1 microsecond')`;
  // When cursor pages use the literal search substring.
  const found:string[]=[];let cursor=null;
  do{const page=await search('paging%_needle',{limit:2,cursor});found.push(...page.hits.map(hit=>hit.id));cursor=page.next_cursor;}while(cursor);
  // Then all distinct records appear exactly once and SQL wildcard spelling is literal.
  expect(found).toHaveLength(5);expect(new Set(found).size).toBe(5);
  expect((await search('paging%%needle')).hits).toHaveLength(0);
});

test('existing text artifacts are backfilled and deleted files leave search results',async()=>{
  // Given a pre-index artifact with original bytes still in object storage.
  const file=await uploadedSource('backfill-lilac historic report');
  await f.sql`UPDATE assistant.artifacts SET search_text=NULL,search_indexed=false WHERE id=${file.artifact.id}`;
  // When search indexes it on demand and the user subsequently deletes it.
  const before=await search('backfill-lilac');
  const removed=await app.request(`/v1/artifacts/${file.artifact.id}`,{method:'DELETE',headers:{Authorization:`Bearer ${f.client}`}});
  const after=await search('backfill-lilac');
  // Then original content was searchable and its deleted artifact cannot be discovered.
  expect(before.hits[0]?.artifact?.id).toBe(file.artifact.id);expect(removed.status).toBe(200);expect(after.hits).toHaveLength(0);
  expect((await f.sql`SELECT search_text,search_text_truncated FROM assistant.artifacts WHERE id=${file.artifact.id}`)[0]).toMatchObject({search_text:null,search_text_truncated:false});
});

test('model reuses exact prior-conversation file bytes without reupload and rejects unlinked or stale access',async()=>{
  // Given an owned historical attachment and an active current run in another conversation.
  const file=await uploadedSource('reusable-magnolia exact historical bytes'),{run,current}=await activeRun();
  const http=ky.create({prefixUrl:server.url.href,headers:{Authorization:`Bearer ${f.machine}`},retry:0});
  const artifacts=await TaskArtifacts.create({http,runId:run,conversationId:current.task.conversation_id,root:join(dir,'runs')});
  const signal=AbortSignal.timeout(5000);
  // When the real model-tool adapter searches then reads its original source.
  const page=WorkSearchPage.parse(JSON.parse(await runWorkSearch(http,{runId:run,artifacts},{name:'search_prior_work',args:JSON.stringify({query:'reusable-magnolia',cursor:null,conversation_id:null,state:'all',limit:10}),signal})));
  expect(page.hits[0]?.source_message_id).toBe(file.message.id);
  await runWorkSearch(http,{runId:run,artifacts},{name:'read_prior_source',args:JSON.stringify({source_message_id:file.message.id}),signal});
  // Then downloaded bytes match the original and no new artifact was published.
  expect(await Bun.file(join(artifacts.directory,'inputs',`${file.artifact.id}.txt`)).text()).toBe('reusable-magnolia exact historical bytes');
  expect((await f.sql`SELECT id FROM assistant.artifacts WHERE workspace_id=${f.workspace} AND sha256=${file.artifact.sha256}`)).toHaveLength(1);
  const wrong=await app.request(`/v1/daemon/artifacts/${file.artifact.id}/content?run_id=${run}&prior_source_message_id=${crypto.randomUUID()}`,{headers:{Authorization:`Bearer ${f.machine}`}});expect(wrong.status).toBe(404);
  const otherVm=crypto.randomUUID();await f.sql`INSERT INTO assistant.vms(id,workspace_id,name) VALUES(${otherVm},${f.workspace},'other-vm')`;
  await f.sql`UPDATE assistant.runs SET vm_id=${otherVm} WHERE id=${run}`;
  const wrongVm=await app.request(`/v1/daemon/artifacts/${file.artifact.id}/content?run_id=${run}&prior_source_message_id=${file.message.id}`,{headers:{Authorization:`Bearer ${f.machine}`}});expect(wrongVm.status).toBe(404);
  await f.sql`UPDATE assistant.runs SET vm_id=${f.vm} WHERE id=${run}`;
  await f.sql`UPDATE assistant.runs SET state='succeeded' WHERE id=${run}`;
  const stale=await app.request(`/v1/daemon/artifacts/${file.artifact.id}/content?run_id=${run}&prior_source_message_id=${file.message.id}`,{headers:{Authorization:`Bearer ${f.machine}`}});expect(stale.status).toBe(404);
});
