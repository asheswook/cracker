import { z } from "zod";
import { hashToken, type Principal } from "../../services/control/auth";
import type { Database, Query } from "../../services/control/db";
import { DomainError } from "../protocol";
import { ownedScope, rawSource, referenceSource, retentionAllowed, type ContextScope } from "./store-read";
import { Edge, EdgeRequest, Exchange, Member, MemberRequest, StructureReadRequest, UndoEdgeRequest, StructureEvidence } from "./structure-schema";

export type StructureScope=Readonly<{principal:Principal;run?:string;conversation?:string;backfill?:boolean}>;
function conflict(code:string,message:string):never {throw new DomainError(code,message,409)}
async function scopeFor(sql:Query,actor:StructureScope,lock=false,read=false) {
 const workspace=actor.principal.workspace_id;
  if(actor.run){const owned=await ownedScope(sql,actor.principal,actor.run,lock,read||actor.backfill?'backfill':'live');return {workspace,conversation:owned.conversation_id,task_id:owned.task_id};}
 if(actor.principal.role!=='client'||!actor.conversation)throw new DomainError('forbidden','Owned run or client conversation required',403);
 if(lock)await sql`SELECT id FROM assistant.workspaces WHERE id=${workspace} FOR KEY SHARE`;
 const rows=await sql`SELECT id FROM assistant.conversations WHERE workspace_id=${workspace} AND id=${actor.conversation} ${lock?sql`FOR UPDATE`:sql``}`;
 if(!rows[0])throw new DomainError('not_found','Conversation not found',404);
 return {workspace,conversation:actor.conversation,task_id:null};
}
async function realUser(sql:Query,scope:ContextScope,id:string) {
 const source=await rawSource(sql,scope,id);
 const row=(await sql`SELECT synthetic FROM assistant.messages WHERE workspace_id=${scope.workspace} AND conversation_id=${scope.conversation} AND id=${id}`)[0];
 if(source.role!=='user'||z.object({synthetic:z.boolean()}).parse(row).synthetic)conflict('invalid_source','A real user input is required');
 return source;
}
async function ensure(sql:Query,scope:ContextScope,id:string) {
 const source=await realUser(sql,scope,id);
 return Exchange.parse((await sql`INSERT INTO assistant.semantic_exchanges(workspace_id,conversation_id,user_message_id,sequence) VALUES(${scope.workspace},${scope.conversation},${id},${source.sequence}) ON CONFLICT(workspace_id,user_message_id) DO UPDATE SET user_message_id=excluded.user_message_id RETURNING *`)[0]);
}
export async function ensureExchange(sql:Database,actor:StructureScope,user_message_id:string) {
 const id=z.uuid().parse(user_message_id);
 const exchange=await sql.begin(async tx=>ensure(tx,await scopeFor(tx,actor,true),id));
 await replyEdge(sql,actor,exchange);
 return exchange;
}
// A user-selected reply target is ground truth for the continuation anchor. Record it as a confirmed explicit
// primary edge so asynchronous LLM anchoring (which skips existing primaries) never overrides it.
async function replyEdge(sql:Database,actor:StructureScope,child:z.infer<typeof Exchange>) {
 const row=(await sql`SELECT m.reply_to_message_id,r.conversation_id,r.sequence,r.role,r.content FROM assistant.messages m JOIN assistant.messages r ON r.workspace_id=m.workspace_id AND r.id=m.reply_to_message_id WHERE m.workspace_id=${actor.principal.workspace_id} AND m.id=${child.user_message_id}`)[0];
 if(!row)return;
 const reply=z.object({reply_to_message_id:z.uuid(),conversation_id:z.uuid(),sequence:z.coerce.number(),role:z.string(),content:z.string()}).parse(row);
 if(reply.conversation_id!==child.conversation_id||reply.sequence>=child.sequence||!reply.content)return;
 const owner=reply.role==='user'
  ?(await sql`SELECT id FROM assistant.semantic_exchanges WHERE workspace_id=${actor.principal.workspace_id} AND user_message_id=${reply.reply_to_message_id}`)[0]
  :(await sql`SELECT exchange_id AS id FROM assistant.semantic_exchange_members WHERE workspace_id=${actor.principal.workspace_id} AND message_id=${reply.reply_to_message_id}`)[0];
 if(!owner)return;
 const target=z.object({id:z.uuid()}).parse(owner).id;
 if(target===child.id||(await sql`SELECT 1 FROM assistant.semantic_exchange_edges WHERE workspace_id=${actor.principal.workspace_id} AND child_exchange_id=${child.id} AND role='primary'`)[0])return;
 const h=new Bun.CryptoHasher('sha256').update(JSON.stringify([child.id,'reply-explicit-v1'])).digest('hex');
 const operation=`${h.slice(0,8)}-${h.slice(8,12)}-8${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
 const source=await sql.begin(async tx=>rawSource(tx,await scopeFor(tx,actor,false,true),reply.reply_to_message_id));
 const end=Math.min(source.content.length,2000);
 await mutate(sql,actor,EdgeRequest.parse({operation_id:operation,child_exchange_id:child.id,expected_revision:0,role:'primary',state:'linked',continuation_exchange_id:target,target_exchange_id:target,
  target_message_id:source.message_id,target_source_sha256:await hashToken(JSON.stringify(source)),target_start:0,target_end:end,quote:source.content.slice(0,end),
  relation:'follow_up',anchor_confidence:1,status:'confirmed',method:'explicit',policy_version:'reply-explicit-v1'}),'edge');
}
// Shared by daemon event persistence; this does not create semantic exchanges.
export async function validateResponseAttribution(sql:Query,scope:ContextScope & {task_id:string},response:string|null,applied:readonly string[],before=Number.MAX_SAFE_INTEGER) {
 if(applied.length&&!response)conflict('invalid_attribution','Provenance requires response_to_message_id');
 if(new Set(applied).size!==applied.length)conflict('invalid_attribution','Duplicate applied user IDs');
 if(response&&applied.length&&!applied.includes(response))conflict('invalid_attribution','Response target must be an applied user input');
 for(const id of new Set([...(response?[response]:[]),...applied])) {
  const user=await realUser(sql,scope,id);
  if(user.task_id!==scope.task_id||user.sequence>=before)conflict('invalid_attribution','Applied user must precede the response in the same task');
 }
}
export async function attributeMember(sql:Database,actor:StructureScope,input:z.input<typeof MemberRequest>) {
 const request=MemberRequest.parse(input);
 return sql.begin(async tx=>{
  const scope=await scopeFor(tx,actor,true),message=await rawSource(tx,scope,request.message_id);
  if(message.role!=='assistant'||!message.task_id||(scope.task_id&&message.task_id!==scope.task_id))conflict('invalid_attribution','Assistant must belong to the owned task');
  await validateResponseAttribution(tx,{...scope,task_id:message.task_id},request.response_to_message_id,request.applied_user_ids,message.sequence);
  const recorded=z.object({response_to_message_id:z.uuid().nullable(),applied_user_ids:z.array(z.uuid()),phase:z.string().nullable(),output_kind:z.string().nullable()}).parse((await tx`SELECT response_to_message_id,applied_user_ids,phase,output_kind FROM assistant.messages WHERE workspace_id=${scope.workspace} AND conversation_id=${scope.conversation} AND id=${message.message_id}`)[0]);
  if(recorded.response_to_message_id&&recorded.response_to_message_id!==request.response_to_message_id)conflict('invalid_attribution','Cannot override recorded response target');
  if(request.method==='response_to'&&recorded.response_to_message_id!==request.response_to_message_id)conflict('invalid_attribution','Explicit attribution requires recorded response target');
  if(recorded.applied_user_ids.length&&JSON.stringify(recorded.applied_user_ids)!==JSON.stringify(request.applied_user_ids))conflict('invalid_attribution','Provenance differs from recorded inputs');
  if(recorded.phase==='commentary'&&request.kind!=='progress'||recorded.phase==='final_answer'&&request.kind!=='answer')conflict('invalid_attribution','Member kind contradicts assistant phase');
  if(!recorded.phase&&recorded.output_kind&&(recorded.output_kind==='progress'?'progress':'answer')!==request.kind)conflict('invalid_attribution','Member kind contradicts recorded output kind');
  if(!recorded.phase&&!recorded.output_kind&&!recorded.response_to_message_id&&request.kind!=='unknown')conflict('invalid_attribution','Phase-null legacy output has unknown kind');
  const run=request.run??actor.run??null;
  if(actor.run&&run!==actor.run)conflict('invalid_attribution','Run differs from owned run');
  if(run&&!(await tx`SELECT 1 FROM assistant.runs WHERE workspace_id=${scope.workspace} AND id=${run} AND task_id=${message.task_id}`)[0])conflict('invalid_attribution','Run is outside the response task');
  const exchange=await ensure(tx,scope,request.response_to_message_id);
  const result=Member.parse({message_id:request.message_id,exchange_id:exchange.id,kind:request.kind,method:request.method,method_version:request.method_version,run_id:run,applied_user_ids:request.applied_user_ids});
  const prior=(await tx`SELECT * FROM assistant.semantic_exchange_members WHERE workspace_id=${scope.workspace} AND message_id=${request.message_id}`)[0];
  if(prior){if(JSON.stringify(Member.parse(prior))!==JSON.stringify(result))conflict('attribution_conflict','Message already attributed');return result;}
  await tx`INSERT INTO assistant.semantic_exchange_members(workspace_id,conversation_id,message_id,exchange_id,kind,method,method_version,run_id,applied_user_ids) VALUES(${scope.workspace},${scope.conversation},${result.message_id},${result.exchange_id},${result.kind},${result.method},${result.method_version},${result.run_id},${tx.array(result.applied_user_ids)}::uuid[])`;
  return result;
 });
}
function canonical(value:unknown):unknown {
 if(Array.isArray(value))return value.map(canonical);
 if(value!==null&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)]));
 return value;
}
async function receipt(sql:Query,actor:StructureScope,operation:string,payload:unknown) {
 const hash=await hashToken(JSON.stringify(canonical(payload)));
 const row=(await sql`SELECT actor_role,actor_vm_id,request_hash,result FROM assistant.semantic_structure_operations WHERE workspace_id=${actor.principal.workspace_id} AND operation_id=${operation}`)[0];
 if(!row)return {hash,result:null};
 const saved=z.object({actor_role:z.string(),actor_vm_id:z.uuid().nullable(),request_hash:z.string(),result:Edge}).parse(row);
  if(saved.actor_role!==actor.principal.role||saved.actor_vm_id!==actor.principal.vm_id||saved.request_hash!==hash)conflict('idempotency_conflict','Operation ID reused with different payload or actor');
  // W1b receipts contain exact text. Replaying an operation is not permission to
  // expose a source after its retention or content has changed.
  const spans=[saved.result.branch_from,saved.result.return_evidence,saved.result.reference_evidence].filter(s=>s!==null);
  if(spans.length){
   const scope=await scopeFor(sql,actor,false,true),child=await exchangeSource(sql,scope,saved.result.child_exchange_id);
   if(!await retentionAllowed(sql,scope,await referenceSource(sql,scope,child.user_message_id)))conflict('retention_denied','Receipt source may not be retained');
   for(const span of spans){
    const source=await referenceSource(sql,scope,span.message_id),exchange=await exchangeSource(sql,scope,span.exchange_id);
    if(!await retentionAllowed(sql,scope,source)||!await retentionAllowed(sql,scope,await referenceSource(sql,scope,exchange.user_message_id)))conflict('retention_denied','Receipt evidence may not be retained');
    if(await hashToken(JSON.stringify(source))!==span.source_sha256)conflict('stale_source','Receipt evidence changed');
   }
  }
 return {hash,result:saved.result};
}
function slot(role:string,target:string|null) {if(role==='reference'&&!target)conflict('invalid_edge','Reference requires a target');return role==='primary'?'primary':target!;}
async function head(sql:Query,scope:ContextScope,child:string,key:string) {
 const row=(await sql`SELECT * FROM assistant.semantic_exchange_edges WHERE workspace_id=${scope.workspace} AND child_exchange_id=${child} AND slot=${key}`)[0];
 return row?Edge.parse(row):null;
}
async function exchangeSource(sql:Query,scope:ContextScope,id:string,child=false) {
 const row=(await sql`SELECT * FROM assistant.semantic_exchanges WHERE workspace_id=${scope.workspace} AND id=${id} ${child?sql`AND conversation_id=${scope.conversation} FOR UPDATE`:sql``}`)[0];
 if(!row)conflict('invalid_exchange','Exchange is outside the requested scope');
 return Exchange.parse(row);
}
async function validateEdge(sql:Query,scope:ContextScope,actor:StructureScope,request:z.infer<typeof EdgeRequest>,prior:z.infer<typeof Edge>|null) {
 const child=await exchangeSource(sql,scope,request.child_exchange_id,true);
 if((prior?.revision??0)!==request.expected_revision)conflict('stale_revision','Edge changed');
 if(prior?.method==='user'&&request.method!=='user')conflict('user_edge_protected','Automatic methods cannot overwrite user edges');
 if(request.method==='user'&&actor.principal.role!=='client')throw new DomainError('forbidden','User decisions require client credentials',403);
 if(request.status==='confirmed'&&request.method!=='explicit'&&request.method!=='user')conflict('invalid_edge','Automatic decisions must remain provisional until confirmed by policy');
 const childSource=await realUser(sql,scope,child.user_message_id);
  if(!await retentionAllowed(sql,scope,childSource))conflict('retention_denied','Child source may not be retained');
  if(request.continuation_exchange_id){
   const continuation=await exchangeSource(sql,scope,request.continuation_exchange_id),user=await referenceSource(sql,scope,continuation.user_message_id);
   if(request.role!=='primary'||continuation.sequence>=child.sequence||Date.parse(user.created_at)>Date.parse(childSource.created_at)||request.state==='linked'&&continuation.id!==request.target_exchange_id)conflict('invalid_edge','Continuation must be a prior primary target');
   if(!await retentionAllowed(sql,scope,user))conflict('retention_denied','Continuation source may not be retained');
  }
  const evidence=async(span:z.infer<typeof StructureEvidence>,current=false)=>{
   const exchange=await exchangeSource(sql,scope,span.exchange_id),source=await referenceSource(sql,scope,span.message_id);
   if(current?exchange.id!==child.id||source.message_id!==child.user_message_id:exchange.sequence>=child.sequence||source.sequence>=child.sequence||Date.parse(source.created_at)>Date.parse(childSource.created_at))conflict('invalid_evidence','Evidence must belong to its causal exchange');
   if(source.message_id!==exchange.user_message_id&&!(await sql`SELECT 1 FROM assistant.semantic_exchange_members WHERE workspace_id=${scope.workspace} AND exchange_id=${exchange.id} AND message_id=${source.message_id} AND kind='answer'`)[0])conflict('invalid_evidence','Evidence source is outside exchange');
   if(await hashToken(JSON.stringify(source))!==span.source_sha256)conflict('stale_source','Evidence source hash changed');
   if(span.end<=span.start||span.end>source.content.length||source.content.slice(span.start,span.end)!==span.quote)conflict('invalid_evidence','Quote must exactly match source offsets');
   if(!await retentionAllowed(sql,scope,source)||!await retentionAllowed(sql,scope,await referenceSource(sql,scope,exchange.user_message_id)))conflict('retention_denied','Evidence source may not be retained');
  };
  if(request.branch_from){if(request.role!=='primary'||request.subject_action!=='new_subject_branch')conflict('invalid_edge','Branch requires primary subject action');await evidence(request.branch_from);}
  if(request.return_evidence){if(request.role!=='primary'||request.subject_action!=='return_to_region'||!request.return_region_ref)conflict('invalid_edge','Return requires region');await evidence(request.return_evidence);}
  if(request.return_region_ref){const region=await exchangeSource(sql,scope,request.return_region_ref);if(region.sequence>=child.sequence||!request.return_evidence)conflict('invalid_edge','Return region must precede child');if(!await retentionAllowed(sql,scope,await referenceSource(sql,scope,region.user_message_id)))conflict('retention_denied','Region source may not be retained');}
  if(request.reference_evidence){if(request.role!=='reference')conflict('invalid_edge','Reference evidence requires reference edge');await evidence(request.reference_evidence,true);}
  if(request.state!=='linked') {
   if(request.role==='reference'||request.target_exchange_id||request.target_message_id||request.target_source_sha256||request.target_start!==null||request.target_end!==null||request.quote||request.is_return)conflict('invalid_edge','Root and unresolved edges cannot carry a target');
  return;
 }
 if(!request.target_exchange_id||!request.target_message_id||!request.target_source_sha256||request.target_start===null||request.target_end===null||!request.relation||!request.quote)conflict('invalid_edge','Linked edge requires an exact source window');
 const target=await exchangeSource(sql,scope,request.target_exchange_id),source=await referenceSource(sql,scope,request.target_message_id);
 if(target.id===child.id||target.sequence>=child.sequence||source.sequence>=child.sequence)conflict('invalid_edge','Target must precede child user input');
 if(source.message_id!==target.user_message_id&&!(await sql`SELECT 1 FROM assistant.semantic_exchange_members WHERE workspace_id=${scope.workspace} AND exchange_id=${target.id} AND message_id=${source.message_id}`)[0])conflict('invalid_edge','Target message does not belong to target exchange');
 if(await hashToken(JSON.stringify(source))!==request.target_source_sha256)conflict('stale_source','Target source hash changed');
 if(request.target_end<=request.target_start||request.target_end>source.content.length||source.content.slice(request.target_start,request.target_end)!==request.quote)conflict('invalid_evidence','Quote must exactly match the specified source offsets');
 const targetUser=await referenceSource(sql,scope,target.user_message_id);
 if(!await retentionAllowed(sql,scope,source)||!await retentionAllowed(sql,scope,targetUser))conflict('retention_denied','Target source may not be retained');
}
async function commit(sql:Query,scope:ContextScope,request:z.infer<typeof EdgeRequest>) {
 const r=request;
  const result=Edge.parse((await sql`INSERT INTO assistant.semantic_exchange_edges(workspace_id,child_exchange_id,role,target_exchange_id,state,relation,is_return,target_message_id,target_source_sha256,target_start,target_end,anchor_confidence,relation_confidence,status,method,model,policy_version,revision,subject_action,proposed_subject,subject_confidence,branch_from,return_region_ref,return_evidence,reference_evidence,continuation_exchange_id)
  VALUES(${scope.workspace},${r.child_exchange_id},${r.role},${r.target_exchange_id},${r.state},${r.relation},${r.is_return},${r.target_message_id},${r.target_source_sha256},${r.target_start},${r.target_end},${r.anchor_confidence},${r.relation_confidence},${r.status},${r.method},${r.model},${r.policy_version},${r.expected_revision+1},${r.subject_action},${r.proposed_subject},${r.subject_confidence},${r.branch_from?JSON.stringify(r.branch_from):null}::text::jsonb,${r.return_region_ref},${r.return_evidence?JSON.stringify(r.return_evidence):null}::text::jsonb,${r.reference_evidence?JSON.stringify(r.reference_evidence):null}::text::jsonb,${r.continuation_exchange_id})
  ON CONFLICT(workspace_id,child_exchange_id,slot) DO UPDATE SET target_exchange_id=excluded.target_exchange_id,state=excluded.state,relation=excluded.relation,is_return=excluded.is_return,target_message_id=excluded.target_message_id,target_source_sha256=excluded.target_source_sha256,target_start=excluded.target_start,target_end=excluded.target_end,anchor_confidence=excluded.anchor_confidence,relation_confidence=excluded.relation_confidence,status=excluded.status,method=excluded.method,model=excluded.model,policy_version=excluded.policy_version,revision=excluded.revision,subject_action=excluded.subject_action,proposed_subject=excluded.proposed_subject,subject_confidence=excluded.subject_confidence,branch_from=excluded.branch_from,return_region_ref=excluded.return_region_ref,return_evidence=excluded.return_evidence,reference_evidence=excluded.reference_evidence,continuation_exchange_id=excluded.continuation_exchange_id,needs_revalidation=false,updated_at=now() RETURNING *`)[0]);
 await sql`INSERT INTO assistant.semantic_exchange_edge_revisions(workspace_id,child_exchange_id,role,slot,revision,operation_id,snapshot) VALUES(${scope.workspace},${r.child_exchange_id},${r.role},${slot(r.role,r.target_exchange_id)},${result.revision},${r.operation_id},${JSON.stringify(result)}::text::jsonb)`;
 return result;
}
async function mutate(sql:Database,actor:StructureScope,input:z.infer<typeof EdgeRequest>|z.infer<typeof UndoEdgeRequest>,kind:'edge'|'undo') {
 const payload={kind,run:actor.run??null,conversation:actor.conversation??null,request:input};
 // Authorize even receipt reads, but permit replay after a run has completed.
 await scopeFor(sql,actor,false,true);
 const completed=await receipt(sql,actor,input.operation_id,payload);if(completed.result)return completed.result;
 return sql.begin(async tx=>{
  const scope=await scopeFor(tx,actor,true);
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${scope.workspace+':semantic-structure'},0))`;
  // Same operation can race on different children/conversations. Serialize its identity too.
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${scope.workspace+':'+input.operation_id},0))`;
  const replay=await receipt(tx,actor,input.operation_id,payload);if(replay.result)return replay.result;
  await exchangeSource(tx,scope,input.child_exchange_id,true);
  const key=slot(input.role,input.target_exchange_id),prior=await head(tx,scope,input.child_exchange_id,key);
  let request:z.infer<typeof EdgeRequest>,undoOf:string|null=null;
  if('to_revision' in input) {
   if(input.to_revision>=input.expected_revision)conflict('invalid_undo','Undo requires an earlier revision');
   const row=(await tx`SELECT snapshot,operation_id FROM assistant.semantic_exchange_edge_revisions WHERE workspace_id=${scope.workspace} AND child_exchange_id=${input.child_exchange_id} AND slot=${key} AND revision=${input.to_revision}`)[0];
   if(!row)conflict('invalid_undo','Revision not found');
   const saved=z.object({snapshot:Edge,operation_id:z.uuid()}).parse(row);
   const {revision:_revision,needs_revalidation:_dirty,updated_at:_updated,...fields}=saved.snapshot;
   const source=fields.target_message_id?await referenceSource(tx,scope,fields.target_message_id):null;
   request=EdgeRequest.parse({...fields,operation_id:input.operation_id,expected_revision:input.expected_revision,quote:source&&fields.target_start!==null&&fields.target_end!==null?source.content.slice(fields.target_start,fields.target_end):null});
   if(prior?.method==='user'&&actor.principal.role==='client')request.method='user';
   const current=(await tx`SELECT operation_id FROM assistant.semantic_exchange_edge_revisions WHERE workspace_id=${scope.workspace} AND child_exchange_id=${input.child_exchange_id} AND slot=${key} AND revision=${input.expected_revision}`)[0];
   if(!current)conflict('stale_revision','Current revision not found');
   undoOf=z.object({operation_id:z.uuid()}).parse(current).operation_id;
  } else request=input;
  await validateEdge(tx,scope,actor,request,prior);
  const result=await commit(tx,scope,request);
  await tx`INSERT INTO assistant.semantic_structure_operations(workspace_id,operation_id,kind,actor_role,actor_vm_id,request_hash,request,result,undo_of) VALUES(${scope.workspace},${input.operation_id},${kind},${actor.principal.role},${actor.principal.vm_id},${replay.hash},${JSON.stringify(payload)}::text::jsonb,${JSON.stringify(result)}::text::jsonb,${undoOf})`;
  return result;
 });
}
export async function writeEdge(sql:Database,actor:StructureScope,input:z.input<typeof EdgeRequest>) {return mutate(sql,actor,EdgeRequest.parse(input),'edge');}
export async function undoEdge(sql:Database,actor:StructureScope,input:z.input<typeof UndoEdgeRequest>) {return mutate(sql,actor,UndoEdgeRequest.parse(input),'undo');}

export async function readStructure(sql:Database,actor:StructureScope,input:z.input<typeof StructureReadRequest>) {
 const request=StructureReadRequest.parse(input);
 return sql.begin(async tx=>{
  await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;
  const scope=await scopeFor(tx,actor,false,true);
  const recent=z.array(Exchange).parse(await tx`SELECT * FROM assistant.semantic_exchanges WHERE workspace_id=${scope.workspace} AND conversation_id=${scope.conversation} AND sequence<=${request.through_sequence} ORDER BY sequence DESC LIMIT ${request.limit}`);
  const ancestors:z.infer<typeof Exchange>[]=[],chain:z.infer<typeof Edge>[]=[],seeds:z.infer<typeof Exchange>[]=[];
  let cursor=request.ancestors_of;
  for(let hop=0;cursor&&hop<request.max_hops;hop++) {
   const row=(await tx`SELECT * FROM assistant.semantic_exchanges WHERE workspace_id=${scope.workspace} AND id=${cursor} AND sequence<=${request.through_sequence} ${hop===0?tx`AND conversation_id=${scope.conversation}`:tx``}`)[0];
   if(!row)break;
   const current=Exchange.parse(row),edge=await head(tx,scope,current.id,'primary');
   if(hop===0)seeds.push(current);
   if(!edge||edge.state!=='linked'||edge.needs_revalidation||edge.status==='rejected'||request.stop_at_provisional&&edge.status==='provisional')break;
   const target=(await tx`SELECT * FROM assistant.semantic_exchanges WHERE workspace_id=${scope.workspace} AND id=${edge.target_exchange_id} AND sequence<${current.sequence}`)[0];
   if(!target)break;
   ancestors.push(Exchange.parse(target));chain.push(edge);cursor=edge.target_exchange_id??undefined;
  }
  const selected=[...new Map([...recent,...seeds,...ancestors].map(item=>[item.id,item])).values()],exchanges=[];
  for(const exchange of selected) {
   const user=await referenceSource(tx,scope,exchange.user_message_id);
   if(!await retentionAllowed(tx,scope,user))continue;
   const members=z.array(Member).parse(await tx`SELECT member.* FROM assistant.semantic_exchange_members member JOIN assistant.messages m ON m.workspace_id=member.workspace_id AND m.id=member.message_id WHERE member.workspace_id=${scope.workspace} AND member.exchange_id=${exchange.id} AND member.kind IN ('answer','progress') AND m.sequence<=${request.through_sequence} ORDER BY m.sequence DESC LIMIT 64`);
   const allowed=[];
   for(const member of members)if(await retentionAllowed(tx,scope,await referenceSource(tx,scope,member.message_id)))allowed.push(member);
   exchanges.push({...exchange,members:allowed});
  }
  const ids=exchanges.map(item=>item.id);
  const links=z.array(Edge).parse(await tx`SELECT e.* FROM assistant.semantic_exchange_edges e LEFT JOIN assistant.messages m ON m.workspace_id=e.workspace_id AND m.id=e.target_message_id WHERE e.workspace_id=${scope.workspace} AND e.child_exchange_id=ANY(${tx.array(ids)}::uuid[]) AND NOT e.needs_revalidation AND e.status<>'rejected' AND (m.id IS NULL OR m.sequence<=${request.through_sequence}) ORDER BY e.child_exchange_id,e.role,e.slot LIMIT 256`);
  return {exchanges,ancestors:ancestors.filter(item=>ids.includes(item.id)).map(item=>item.id),primary_chain:chain.filter(item=>ids.includes(item.child_exchange_id)&&ids.includes(item.target_exchange_id??'')),edges:links};
 });
}
