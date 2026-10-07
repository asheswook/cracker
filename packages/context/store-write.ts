import { z } from "zod";
import { hashToken, type Principal } from "../../services/control/auth";
import type { Database, Query, Transaction } from "../../services/control/db";
import { DomainError } from "../protocol";
import { LinkRequest, LinkResult, NotesRequest, NotesResult, SemanticLink } from "./schema";
import { lockContexts } from "./store-source";
import { contextSnapshot, exactEvidence, linked, ownedScope, rawSource, referenceSource, sourceScope, retentionAllowed, type ContextScope, type RawSource } from "./store-read";

async function lockScope(tx: Transaction, principal: Principal, run: string, mode: "live" | "backfill") {
  const owned=await ownedScope(tx,principal,run,true,mode);
  await tx`SELECT id FROM assistant.conversations WHERE workspace_id=${principal.workspace_id} AND id=${owned.conversation_id} FOR UPDATE`;
  return {...owned,workspace:principal.workspace_id,conversation:owned.conversation_id};
}
async function receipt(sql: Query, principal: Principal, operation: string, request: unknown) {
  const hash=await hashToken(JSON.stringify(request));
  const row=(await sql`SELECT vm_id,request_hash,result FROM assistant.semantic_context_mutations WHERE workspace_id=${principal.workspace_id} AND operation_id=${operation}`)[0];
  if(!row)return {hash,result:null};
  const saved=z.object({vm_id:z.uuid(),request_hash:z.string(),result:z.unknown()}).parse(row);
  if(saved.vm_id!==principal.vm_id||saved.request_hash!==hash)throw new DomainError('idempotency_conflict','Operation ID reused with different payload',409);
  return {hash,result:saved.result};
}
async function saveReceipt(sql:Query,principal:Principal,operation:string,hash:string,request:unknown,result:unknown) {
  await sql`INSERT INTO assistant.semantic_context_mutations(workspace_id,operation_id,vm_id,request_hash,request,result) VALUES(${principal.workspace_id},${operation},${principal.vm_id},${hash},${JSON.stringify(request)}::text::jsonb,${JSON.stringify(result)}::text::jsonb)`;
}
async function recordSource(sql:Query,requestedScope:ContextScope,source:z.infer<typeof RawSource>) {
  const scope=await sourceScope(sql,requestedScope.workspace,source.message_id);
  const hash=await hashToken(JSON.stringify(source));
  await sql`INSERT INTO assistant.semantic_context_sources(workspace_id,conversation_id,message_id,sha256,snapshot) VALUES(${scope.workspace},${scope.conversation},${source.message_id},${hash},${JSON.stringify(source)}::text::jsonb) ON CONFLICT DO NOTHING`;
  return hash;
}
export async function commitLink(sql:Query,requestedScope:ContextScope,input:z.infer<typeof SemanticLink>,request:unknown) {
  const scope=await sourceScope(sql,requestedScope.workspace,input.message_id);
  await sql`INSERT INTO assistant.semantic_context_links(workspace_id,conversation_id,message_id,context_id,revision,status,source_sequence,source_sha256,evidence,originating_message_id) VALUES(${scope.workspace},${scope.conversation},${input.message_id},${input.context_id},${input.revision},${input.status},${input.source_sequence},${input.source_sha256},${JSON.stringify(input.evidence)}::text::jsonb,${input.originating_message_id}) ON CONFLICT(workspace_id,message_id) DO UPDATE SET context_id=excluded.context_id,revision=excluded.revision,status=excluded.status,source_sequence=excluded.source_sequence,source_sha256=excluded.source_sha256,evidence=excluded.evidence,originating_message_id=excluded.originating_message_id,recorded_at=now()`;
  await sql`INSERT INTO assistant.semantic_context_link_revisions(workspace_id,message_id,revision,context_id,source_sha256,payload) VALUES(${scope.workspace},${input.message_id},${input.revision},${input.context_id},${input.source_sha256},${JSON.stringify({link:input,request})}::text::jsonb)`;
  await sql`UPDATE assistant.semantic_contexts SET revision=revision+1,source_sequence=greatest(source_sequence,${input.source_sequence}),updated_at=now() WHERE workspace_id=${scope.workspace} AND id=${input.context_id}`;
}
export async function linkContext(sql:Database,principal:Principal,run:string,input:z.input<typeof LinkRequest>) {
  const request=LinkRequest.parse(input);
  if(principal.role!=='vm'||!principal.vm_id)throw new DomainError('forbidden','VM credentials required',403);
  const completed=await receipt(sql,principal,request.operation_id,{kind:'link',run,request});
  if(completed.result)return LinkResult.parse(completed.result);
  return sql.begin(async tx=>{
    const scope=await lockScope(tx,principal,run,request.mode);
    const replay=await receipt(tx,principal,request.operation_id,{kind:'link',run,request});
    if(replay.result)return LinkResult.parse(replay.result);
    const membership=await linked(tx,scope,request.message_id);
    await lockContexts(tx,scope.workspace,[...(membership?[membership.context_id]:[]),...(request.choice.kind==='existing'?[request.choice.context_id]:[])]);
    const source=await rawSource(tx,scope,request.message_id);
    if(request.mode==='live'&&(source.task_id!==scope.task_id||source.role!=='user'))throw new DomainError('invalid_source','Live linking requires this run task user input',409);
    const hash=await hashToken(JSON.stringify(source));
    if(hash!==request.source_sha256)throw new DomainError('stale_source','Source changed since preparation',409);
    if(!await retentionAllowed(tx,scope,source))throw new DomainError('retention_denied','Source may not be retained as semantic context',409);
    const prior=await linked(tx,scope,source.message_id);
    if(prior?.context_id!==membership?.context_id||prior?.revision!==membership?.revision)throw new DomainError('stale_revision','Membership changed while locking contexts',409);
    if((prior?.revision??0)!==request.expected_link_revision)throw new DomainError('stale_revision','Message link changed',409);
    if(prior?.status==='confirmed'&&(request.status!=='confirmed'||request.choice.kind==='new'||request.choice.context_id!==prior.context_id))throw new DomainError('reorganization_required','Confirmed membership changes require client-approved reorganization',409);
    const evidence=await exactEvidence(tx,scope,request.evidence,source.sequence);
    for(const item of evidence)if(!await retentionAllowed(tx,scope,item))throw new DomainError('retention_denied','Evidence may not be retained as context',409);
    if(!request.evidence.some(item=>item.message_id===source.message_id))throw new DomainError('invalid_evidence','Link must cite its own message or attached file',409);
    let contextId:string;
    if(request.choice.kind==='new') {
      contextId=crypto.randomUUID();
      await tx`INSERT INTO assistant.semantic_contexts(id,workspace_id,conversation_id,title,scope,source_sequence,initiating_message_id) VALUES(${contextId},${scope.workspace},${scope.conversation},${request.choice.title},${request.choice.scope},${source.sequence},${source.message_id})`;
    } else {
      contextId=request.choice.context_id;
      const target=await contextSnapshot(tx,scope,contextId);
      if(target.revision!==request.choice.expected_context_revision)throw new DomainError('stale_revision','Context changed since preparation',409);
    }
    for(const item of [source,...evidence])await recordSource(tx,scope,item);
    const link=SemanticLink.parse({message_id:source.message_id,context_id:contextId,revision:(prior?.revision??0)+1,status:request.status,originating_message_id:prior?.originating_message_id??null,source_sequence:source.sequence,source_sha256:hash,evidence:request.evidence});
    await commitLink(tx,scope,link,request);
    if(prior&&prior.context_id!==contextId)await tx`UPDATE assistant.semantic_contexts SET revision=revision+1,updated_at=now() WHERE workspace_id=${scope.workspace} AND id=${prior.context_id}`;
    const result=LinkResult.parse({link,context:await contextSnapshot(tx,scope,contextId,Number.MAX_SAFE_INTEGER,request.note_ids,[],request.source_windows)});
    await saveReceipt(tx,principal,request.operation_id,replay.hash,{kind:'link',run,request},result);
    return result;
  });
}
export async function writeContextNotes(sql:Database,principal:Principal,run:string,input:z.input<typeof NotesRequest>) {
  const request=NotesRequest.parse(input);
  if(principal.role!=='vm'||!principal.vm_id)throw new DomainError('forbidden','VM credentials required',403);
  const completed=await receipt(sql,principal,request.operation_id,{kind:'notes',run,request});
  if(completed.result)return NotesResult.parse(completed.result);
  return sql.begin(async tx=>{
    const scope=await lockScope(tx,principal,run,request.mode);
    const replay=await receipt(tx,principal,request.operation_id,{kind:'notes',run,request});
    if(replay.result)return NotesResult.parse(replay.result);
    await lockContexts(tx,scope.workspace,[request.context_id]);
    const actual=await sourceScope(tx,scope.workspace,request.source_message_id);
    const source=await referenceSource(tx,scope,request.source_message_id);
    if(request.mode==='live'&&(source.task_id!==scope.task_id||actual.conversation!==scope.conversation))throw new DomainError('invalid_source','Live notes require this run task source',409);
    if(await hashToken(JSON.stringify(source))!==request.source_sha256)throw new DomainError('stale_source','Source changed since preparation',409);
    if(!await retentionAllowed(tx,scope,source))throw new DomainError('retention_denied','Source may not be retained as semantic notes',409);
    const target=await contextSnapshot(tx,scope,request.context_id);
    if(target.revision!==request.expected_revision)throw new DomainError('stale_revision','Context changed since preparation',409);
    if((await linked(tx,scope,source.message_id))?.context_id!==request.context_id)throw new DomainError('invalid_source','Note source must belong to this context',409);
    const revision=target.revision+1;
    if(new Set(request.notes.map(note=>note.id)).size!==request.notes.length)throw new DomainError('invalid_notes','Duplicate note identifiers',409);
    for(const note of request.notes) {
      if(note.valid_from&&note.valid_to&&Date.parse(note.valid_from)>Date.parse(note.valid_to))throw new DomainError('invalid_notes','Valid time range is reversed',409);
      const evidence=await exactEvidence(tx,scope,note.evidence,source.sequence,request.context_id);
      for(const item of evidence)if(!await retentionAllowed(tx,scope,item))throw new DomainError('retention_denied','Evidence may not be retained as semantic notes',409);
      const basis=evidence.some(item=>item.role==='assistant')?'assistant_report':evidence.every(item=>item.role==='user')?'user_statement':'system_record';
      if((note.kind==='decision'||note.kind==='constraint')&&basis!=='user_statement')throw new DomainError('unsupported_fact','Decisions and constraints require user-only evidence',409);
      if(basis==='assistant_report'&&note.kind!=='outcome')throw new DomainError('unsupported_fact','Assistant output is a report, not proof',409);
      if((await tx`SELECT 1 FROM assistant.semantic_context_notes WHERE id=${note.id}`)[0])throw new DomainError('note_conflict','Note identifier already used',409);
      if(note.supersedes) {
        const prior=(await tx`SELECT source_sequence,basis FROM assistant.semantic_context_notes WHERE id=${note.supersedes} AND workspace_id=${scope.workspace} AND context_id=${request.context_id} AND superseded_by IS NULL`)[0];
        if(!prior)throw new DomainError('stale_revision','Superseded note is missing or already replaced',409);
        const previous=z.object({source_sequence:z.coerce.number(),basis:z.enum(['user_statement','assistant_report','system_record'])}).parse(prior);
        if(source.sequence<=previous.source_sequence||!evidence.some(item=>item.sequence>previous.source_sequence)||(basis!=='user_statement'&&basis!==previous.basis))throw new DomainError('invalid_supersession','Correction requires newer evidence with sufficient authority',409);
      }
      for(const item of [source,...evidence])await recordSource(tx,scope,item);
      await tx`INSERT INTO assistant.semantic_context_notes(id,workspace_id,conversation_id,context_id,context_revision,kind,text,evidence,basis,source_message_id,source_sha256,source_sequence,supersedes,valid_from,valid_to) VALUES(${note.id},${scope.workspace},${actual.conversation},${request.context_id},${revision},${note.kind},${note.text},${JSON.stringify(note.evidence)}::text::jsonb,${basis},${source.message_id},${request.source_sha256},${source.sequence},${note.supersedes},${note.valid_from},${note.valid_to})`;
      if(note.supersedes)await tx`UPDATE assistant.semantic_context_notes SET superseded_by=${note.id} WHERE id=${note.supersedes}`;
    }
    await tx`UPDATE assistant.semantic_contexts SET revision=${revision},source_sequence=greatest(source_sequence,${source.sequence}),updated_at=now() WHERE workspace_id=${scope.workspace} AND id=${request.context_id}`;
    const result=NotesResult.parse({context:await contextSnapshot(tx,scope,request.context_id)});
    await saveReceipt(tx,principal,request.operation_id,replay.hash,{kind:'notes',run,request},result);
    return result;
  });
}

export async function linkAssistantContext(sql:Query,scope:Readonly<{workspace:string;conversation:string;run_id:string;context_id:string;message_id:string;source_message_id?:string}>) {
  const run=(await sql`SELECT r.vm_id,r.task_id FROM assistant.runs r JOIN assistant.tasks t ON t.id=r.task_id AND t.workspace_id=r.workspace_id WHERE r.id=${scope.run_id} AND r.workspace_id=${scope.workspace} AND t.conversation_id=${scope.conversation}`)[0];
  if(!run)throw new DomainError('invalid_context','Assistant run is outside this conversation',409);
  const owner=z.object({vm_id:z.uuid(),task_id:z.uuid()}).parse(run);
  await sql`SELECT id FROM assistant.conversations WHERE workspace_id=${scope.workspace} AND id=${scope.conversation} FOR UPDATE`;
  await lockContexts(sql,scope.workspace,[scope.context_id]);
  const source=await rawSource(sql,scope,scope.message_id);
  if(source.role!=='assistant'||source.task_id!==owner.task_id)throw new DomainError('invalid_context','Assistant source must belong to this run task',409);
  const referenced=await sql`SELECT 1 FROM assistant.semantic_context_links l JOIN assistant.messages m ON m.id=l.message_id AND m.workspace_id=l.workspace_id WHERE l.workspace_id=${scope.workspace} AND l.conversation_id=${scope.conversation} AND l.context_id=${scope.context_id} AND m.role='user' AND m.task_id=${owner.task_id} LIMIT 1`;
  if(!referenced[0])throw new DomainError('invalid_context','Context was not referenced by this run user input',409);
  const origin=scope.source_message_id?await rawSource(sql,scope,scope.source_message_id):source;
  if(scope.source_message_id&&(origin.role!=='user'||origin.task_id!==owner.task_id||origin.sequence>=source.sequence||(await linked(sql,scope,origin.message_id))?.context_id!==scope.context_id))throw new DomainError('invalid_context','Assistant origin must be an earlier user input in the same run context',409);
  if((await sql`SELECT 1 FROM assistant.memory_suppressions WHERE workspace_id=${scope.workspace} AND source_message_id=${source.message_id}`)[0]||!await retentionAllowed(sql,scope,origin))return null;
  const principal:Principal={workspace_id:scope.workspace,role:'vm',vm_id:owner.vm_id};
  const replay=await receipt(sql,principal,scope.message_id,{kind:'assistant',scope,source});
  if(replay.result)return SemanticLink.parse(replay.result);
  if(await linked(sql,scope,source.message_id))throw new DomainError('link_conflict','Assistant message already has a primary context',409);
  const hash=await recordSource(sql,scope,source);
  const link=SemanticLink.parse({message_id:source.message_id,context_id:scope.context_id,revision:1,status:'confirmed',originating_message_id:scope.source_message_id??null,source_sequence:source.sequence,source_sha256:hash,evidence:[]});
  await commitLink(sql,scope,link,{kind:'assistant',run:scope.run_id});
  await saveReceipt(sql,principal,scope.message_id,replay.hash,{kind:'assistant',scope,source},link);
  return link;
}
