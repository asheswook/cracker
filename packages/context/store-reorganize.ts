import { z } from "zod";
import { hashToken } from "../../services/control/auth";
import type { Database } from "../../services/control/db";
import { DomainError } from "../protocol";
import { ReorganizeRequest, OrganizationResult } from "./reorganize-schema";
import { SemanticLink } from "./schema";
import { referenceSource, sourceScope, linked, retentionAllowed, type RawSource } from "./store-read";
import { commitLink } from "./store-write";
import { organizationScope, organizationReceipt, recordOrganization, organizationRevisions, type ContextActor } from "./store-organization-access";
import { sourceBatch, requireSource } from './source-batch';
import { automaticCorrectionAllowed } from './automatic-policy';
export { undoContextReorganization, contextProposals } from "./store-organization-undo";

export async function reorganizeContexts(sql:Database,actor:ContextActor,input:z.input<typeof ReorganizeRequest>) {
 const request=ReorganizeRequest.parse(input),payload={kind:'reorganize',run:actor.run??null,request};
 if(actor.principal.role==='vm'&&request.moves.length>64)throw new DomainError('invalid_reorganization','Automatic review is limited to 64 sources',409);
 const completed=await organizationReceipt(sql,actor,request.operation_id,payload);if(completed.result)return completed.result;
 return sql.begin(async tx=>{
  const scope=await organizationScope(tx,actor,request);
  const replay=await organizationReceipt(tx,actor,request.operation_id,payload);if(replay.result)return replay.result;
  if(new Set(request.moves.map(move=>move.message_id)).size!==request.moves.length||new Set(request.contexts.map(context=>context.context_id)).size!==request.contexts.length)throw new DomainError('invalid_reorganization','Duplicate source or context',409);
  const current=await organizationRevisions(tx,scope,request.contexts.map(context=>context.context_id));
  const affected=new Set<string>(),targets=new Map<string,Readonly<{context_id:string;title:string;scope:string;source:z.infer<typeof RawSource>}>>();
  const moves:Readonly<{before:z.infer<typeof SemanticLink>;after:z.infer<typeof SemanticLink>}>[]=[];
  for(const move of request.moves) {
   const before=await linked(tx,scope,move.message_id);
   if(!before||before.revision!==move.expected_link_revision)throw new DomainError('stale_revision','Message membership changed',409);
   const source=await referenceSource(tx,scope,move.message_id);
   if(await hashToken(JSON.stringify(source))!==before.source_sha256)throw new DomainError('stale_source','Linked source changed',409);
   if(!await retentionAllowed(tx,scope,source))throw new DomainError('retention_denied','Source may not be reorganized as retained context',409);
   affected.add(before.context_id);
   let target:string;
   switch(move.to.kind) {
    case 'existing': target=move.to.context_id;affected.add(target);break;
    case 'new': {
     const previous=targets.get(move.to.key);
     if(previous&&(previous.title!==move.to.title||previous.scope!==move.to.scope))throw new DomainError('invalid_reorganization','New context key has inconsistent metadata',409);
     const value=previous??{context_id:crypto.randomUUID(),title:move.to.title,scope:move.to.scope,source};
     targets.set(move.to.key,source.sequence<value.source.sequence?{...value,source}:value);target=value.context_id;break;
    }
    default: {const unreachable:never=move.to;throw new DomainError('invalid_reorganization',String(unreachable),409);}
   }
   if(target===before.context_id)throw new DomainError('invalid_reorganization','Move must change the primary context',409);
   moves.push({before,after:SemanticLink.parse({...before,context_id:target,revision:before.revision+1,status:actor.principal.role==='client'?'confirmed':before.status})});
  }
  if(affected.size!==request.contexts.length||request.contexts.some(context=>!affected.has(context.context_id)))throw new DomainError('invalid_context_versions','Every affected existing context requires a revision',409);
  if(current.length!==affected.size)throw new DomainError('invalid_context','Context is outside this workspace',409);
  if(current.some(context=>request.contexts.find(expected=>expected.context_id===context.context_id)?.expected_revision!==context.revision))throw new DomainError('stale_revision','Context changed since proposal',409);
  const reviewEvidence=await sourceBatch(tx,scope,request.automatic_review?.evidence.map(item=>item.message_id)??[]);
  for(const item of request.automatic_review?.evidence??[]) {
   const record=requireSource(reviewEvidence,item.message_id);
   if(!record.retentionAllowed)throw new DomainError('retention_denied','Review evidence is no longer retained',409);
   if(!record.raw.content.includes(item.quote)&&!record.raw.attachments.some(file=>file.name===item.quote))throw new DomainError('invalid_evidence','Review evidence must quote its exact source',409);
  }
  const apply=request.intent==='apply'&&(actor.principal.role==='client'||automaticCorrectionAllowed(request,moves.map(move=>move.before),reviewEvidence));
  if(apply&&request.proposal_id) {
   const prior=(await tx`SELECT request,resolved_by FROM assistant.semantic_context_organizations WHERE workspace_id=${scope.workspace} AND conversation_id=${scope.conversation} AND operation_id=${request.proposal_id} AND kind='proposal'`)[0];
   if(!prior)throw new DomainError('invalid_proposal','Proposal not found',409);
   const recorded=z.object({request:z.object({request:ReorganizeRequest}),resolved_by:z.uuid().nullable()}).parse(prior),proposed=recorded.request.request;
   if(recorded.resolved_by||JSON.stringify({contexts:proposed.contexts,moves:proposed.moves,reason:proposed.reason})!==JSON.stringify({contexts:request.contexts,moves:request.moves,reason:request.reason}))throw new DomainError('invalid_proposal','Proposal changed or was already resolved',409);
  }
  if(apply) {
   for(const target of targets.values()) {
    const actual=await sourceScope(tx,scope.workspace,target.source.message_id);
    await tx`INSERT INTO assistant.semantic_contexts(id,workspace_id,conversation_id,title,scope,source_sequence,initiating_message_id) VALUES(${target.context_id},${scope.workspace},${actual.conversation},${target.title},${target.scope},${target.source.sequence},${target.source.message_id})`;
   }
   for(const move of moves) {
    await commitLink(tx,scope,move.after,{kind:'reorganize',operation_id:request.operation_id,reason:request.reason,before:move.before});
    await tx`UPDATE assistant.semantic_contexts SET revision=revision+1,updated_at=now() WHERE workspace_id=${scope.workspace} AND id=${move.before.context_id}`;
   }
   if(request.proposal_id)await tx`UPDATE assistant.semantic_context_organizations SET resolved_by=${request.operation_id} WHERE workspace_id=${scope.workspace} AND operation_id=${request.proposal_id}`;
  }
  const created=apply?[...targets.values()].map(target=>target.context_id):[];
  const result=OrganizationResult.parse({operation_id:request.operation_id,status:apply?'applied':'proposal',moves,contexts:apply?await organizationRevisions(tx,scope,[...affected,...created]):current,created_context_ids:created});
  await recordOrganization(tx,actor,{scope,kind:apply?'apply':'proposal',request:payload,hash:replay.hash,result});
  return result;
 });
}
